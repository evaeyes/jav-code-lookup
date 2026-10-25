# -*- coding: utf-8 -*-
"""
scan_local_index.py — 给「番号查询」Chrome 扩展做本机影片建档

扫描 H:\\H\\女优（结构：<女演员>\\<番号>\\<番号>.mp4），把番号 + 相对路径 + 大小
写进扩展目录下的 local-index.json，扩展据此显示「已下载」标记。

用法：
    python scan_local_index.py                # 默认扫 H:\\H\\女优
    python scan_local_index.py --root "X:\\y" --out "…\\local-index.json"
也可以被 native_host.py 直接调用（build_index / write_index）。
"""
import argparse
import io
import json
import os
import re
import sys
import time

# 默认扫描目录：优先环境变量 JAV_LIB_ROOT，否则用 ~/Videos/jav
DEFAULT_ROOT = os.environ.get("JAV_LIB_ROOT") or os.path.join(
    os.path.expanduser("~"), "Videos", "jav")
HERE = os.path.dirname(os.path.abspath(__file__))
# 索引写在扩展根目录，popup 用 chrome.runtime.getURL('local-index.json') 读
DEFAULT_OUT = os.path.join(os.path.dirname(HERE), "local-index.json")

VIDEO_EXT = {".mp4", ".mkv", ".avi", ".wmv", ".mov", ".ts", ".m2ts", ".iso",
             ".rmvb", ".rm", ".flv", ".strm", ".mpg", ".mpeg", ".webm",
             ".f4v", ".vob", ".m4v", ".3gp", ".asf"}
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".idea", ".vscode",
             "System Volume Information", "$RECYCLE.BIN"}

# 番号 A：字母段开头（可带 ≤3 位数字前缀）—— SSIS00123 / ABF-045 / 1start00430
RE_CODE_A = re.compile(r"(?:^|[^0-9A-Za-z])([0-9]{0,3})([A-Za-z]{2,7})[-_. ]?([0-9]{2,7})(?![0-9])")
# 番号 B：字母里夹数字的厂牌（FC2）—— FC2-1391490 / FC2-761338，数字段 5~7 位才认，避免误伤
RE_CODE_B = re.compile(r"(?:^|[^0-9A-Za-z])([A-Za-z]{2,7}[0-9]{1,2})[-_. ]?([0-9]{5,7})(?![0-9])")
# 明显不是番号的（编码、分辨率、站点后缀）
BAD_TOKENS = {
    "HEVC", "XVID", "DIVX", "AVC", "MPEG", "FULLHD", "FHD", "HD", "UNCENSORED",
    "NYAP2P", "THZU", "HHD800", "COM", "NET", "WWW", "WEB", "RIP", "PART",
    "DISC", "VER", "MP", "MP4",
}


def norm_key(code):
    """统一成查询用的 key：PREFIX-整数（去掉前导零），如 ABF-045 -> ABF-45"""
    m = re.match(r"^([0-9]{0,3}[A-Za-z0-9]{2,7})-([0-9]{1,7})$", code or "")
    if not m:
        return None
    prefix = m.group(1).upper()
    if sum(1 for ch in prefix if ch.isalpha()) < 2:   # 前缀至少两个字母
        return None
    return "%s-%d" % (prefix, int(m.group(2)))


def codes_in(text):
    """从一段文本里抠出所有番号候选（规范写法 PREFIX-NNN）"""
    out = []
    for m in RE_CODE_A.finditer(text or ""):
        digits, letters, num = m.group(1), m.group(2), m.group(3)
        if letters.upper() in BAD_TOKENS:
            continue
        out.append("%s-%s" % ((digits + letters).upper(), num.zfill(3) if len(num) < 3 else num))
    if out:
        return out
    for m in RE_CODE_B.finditer(text or ""):
        pfx, num = m.group(1), m.group(2)
        if pfx.upper() in BAD_TOKENS:
            continue
        out.append("%s-%s" % (pfx.upper(), num))
    return out


def pick_code(relpath, fname):
    """优先用「上一层文件夹名」里的番号，其次用文件名"""
    parts = relpath.split(os.sep)
    parent = parts[-2] if len(parts) >= 2 else ""
    for src in (parent, os.path.splitext(fname)[0], relpath):
        cs = codes_in(src)
        if cs:
            return cs[0], cs
    return None, []


def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return ("%.0f%s" % (n, u)) if u in ("B", "KB") else ("%.1f%s" % (n, u))
        n /= 1024.0


def iter_files(root):
    """用 scandir 递归（Windows 上 DirEntry.stat() 走缓存，比 walk+getsize 快一倍）"""
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if e.name not in SKIP_DIRS:
                                stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            yield e
                    except OSError:
                        continue
        except OSError:
            continue


def build_index(root, progress=None, progress_every=300):
    """扫目录 -> 索引 dict。progress 回调收到 (已扫文件数, 视频数, 有番号条目数)"""
    items = {}
    nfile = nvideo = 0
    t0 = time.time()
    last = time.time()
    for e in iter_files(root):
        nfile += 1
        ext = os.path.splitext(e.name)[1].lower()
        if ext in VIDEO_EXT:
            nvideo += 1
            full = e.path
            rel = os.path.relpath(full, root)
            try:
                size = e.stat().st_size
            except OSError:
                size = 0
            code, _all = pick_code(rel, e.name)
            if not code:
                items["__NOPREFIX__" + rel] = {"code": None, "actress": rel.split(os.sep)[0],
                                               "files": [{"p": rel, "s": size}], "n": 1, "size": size}
            else:
                key = norm_key(code) or code
                it = items.get(key)
                if not it:
                    it = {"code": code, "actress": rel.split(os.sep)[0], "files": [], "n": 0, "size": 0}
                    items[key] = it
                it["files"].append({"p": rel, "s": size})
                it["n"] += 1
                it["size"] += size
        if progress and (time.time() - last > 0.5 or nfile % progress_every == 0):
            last = time.time()
            progress(nfile, nvideo, len(items))

    withcode = {k: v for k, v in items.items() if not k.startswith("__NOPREFIX__")}
    nocode = [v["files"][0]["p"] for k, v in items.items() if k.startswith("__NOPREFIX__")]
    data = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "root": root,
        "count": len(withcode),
        "items": withcode,
        "scanSeconds": round(time.time() - t0, 1),
        "scannedFiles": nfile,
        "scannedVideos": nvideo,
    }
    if nocode:
        data["noCode"] = nocode[:200]
    return data


def write_index(path, data):
    """原子写：先写 .tmp 再 replace，中途被打断不会毁掉旧索引"""
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def scan(root, verbose=True, progress=None):
    data = build_index(root, progress=progress)
    if verbose:
        print("扫描 %.1fs  文件 %d  视频 %d  有番号条目 %d  无番号视频 %d"
              % (data["scanSeconds"], data["scannedFiles"], data["scannedVideos"],
                 data["count"], len(data.get("noCode", []))))
        for p in data.get("noCode", [])[:15]:
            print("   [无番号]", p)
    return data


def main():
    ap = argparse.ArgumentParser(description="本机影片建档（给 Chrome 扩展用）")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("-q", "--quiet", action="store_true")
    a = ap.parse_args()

    if not os.path.isdir(a.root):
        sys.stderr.write("[错误] 目录不存在：%s\n" % a.root)
        return 1
    data = scan(a.root, verbose=not a.quiet)
    write_index(a.out, data)

    total = sum(v["size"] for v in data["items"].values())
    print("已写入：%s  (%.0f KB)" % (a.out, os.path.getsize(a.out) / 1024.0))
    print("条目 %d 部 · 合计 %s" % (data["count"], human(total)))
    if not a.quiet:
        print("\n样例：")
        for k in list(data["items"])[:8]:
            v = data["items"][k]
            print("   %-14s %-10s %d 个文件  %s  %s"
                  % (k, v["actress"][:10], v["n"], human(v["size"]), v["files"][0]["p"][:56]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
