# -*- coding: utf-8 -*-
"""
setup_native_host.py — 安装/卸载 Chrome Native Messaging 宿主（HKCU，无需管理员）

    python tools\\setup_native_host.py                # 安装
    python tools\\setup_native_host.py --uninstall     # 卸载
    python tools\\setup_native_host.py --id <扩展ID>   # 手动指定扩展 ID

扩展 ID 从 Chrome 自己的配置里读（Preferences / Secure Preferences 里 extensions.settings
中 path 指向本目录的那条），比用「路径 hash」推算可靠——Chrome 实际用的算法跟文档不一致。
"""
import argparse
import glob
import hashlib
import io
import json
import os
import subprocess
import sys

HOST_NAME = "com.hermes.javindex"
HERE = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(HERE)
MANIFEST_PATH = os.path.join(HERE, HOST_NAME + ".json")
HOST_BAT = os.path.join(HERE, "native_host.bat")
REG_KEY = r"HKCU\Software\Google\Chrome\NativeMessagingHosts\%s" % HOST_NAME


def derived_id(path):
    """路径 hash 推算（仅供兜底参考，通常不等于真实 ID）"""
    p = os.path.abspath(path)
    d = hashlib.sha256(p.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in d)


def id_from_chrome_profiles(folder):
    """在 Chrome 各 profile 的 Preferences / Secure Preferences 里按 path 找扩展 ID"""
    target = os.path.abspath(folder).lower().rstrip("\\")
    base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "User Data")
    hits = []
    for prof in glob.glob(os.path.join(base, "*")):
        for fn in ("Secure Preferences", "Preferences"):
            p = os.path.join(prof, fn)
            if not os.path.exists(p):
                continue
            try:
                with io.open(p, encoding="utf-8", errors="replace") as f:
                    d = json.load(f)
            except Exception:
                continue
            settings = (d.get("extensions") or {}).get("settings") or {}
            for eid, v in settings.items():
                path = ((v or {}).get("path") or "").lower().rstrip("\\")
                if path == target:
                    hits.append((eid, p))
    return hits


def install(force_id=None):
    if not os.path.exists(HOST_BAT):
        sys.stderr.write("[错误] 找不到 %s\n" % HOST_BAT)
        return 1

    hits = id_from_chrome_profiles(EXT_ROOT)
    if force_id:
        eid = force_id
        src = "命令行 --id"
    elif hits:
        eid = hits[0][0]
        src = "Chrome 配置（%s）" % os.path.basename(os.path.dirname(hits[0][1]))
    else:
        eid = derived_id(EXT_ROOT)
        src = "路径 hash 推算（可能不对！先把扩展装进 Chrome 再重跑本脚本）"

    manifest = {
        "name": HOST_NAME,
        "description": "JAV 番号查询扩展 —— 本机影片库建档服务",
        "path": HOST_BAT,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % eid],
    }
    with io.open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    r = subprocess.run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", MANIFEST_PATH, "/f"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("[错误] 写注册表失败：%s%s\n" % (r.stdout, r.stderr))
        return 1

    print("扩展目录 : %s" % EXT_ROOT)
    print("扩展 ID  : %s   （来源：%s）" % (eid, src))
    print("宿主清单 : %s" % MANIFEST_PATH)
    print("注册表   : %s" % REG_KEY)
    print("\n完成。到 chrome://extensions 点扩展卡片上的刷新图标，然后就能用「刷新本机库」。")
    if not hits and not force_id:
        print("\n[警告] 没能从 Chrome 配置里认出这个扩展，白名单可能不匹配 → 先在 Chrome 装好扩展再重跑本脚本。")
    return 0


def uninstall():
    subprocess.run(["reg", "delete", REG_KEY, "/f"], capture_output=True, text=True)
    if os.path.exists(MANIFEST_PATH):
        os.remove(MANIFEST_PATH)
    print("已卸载 native host：%s" % REG_KEY)
    return 0


def main():
    ap = argparse.ArgumentParser(description="安装 Chrome Native Messaging 宿主")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--id", default=None, help="手动指定扩展 ID")
    a = ap.parse_args()
    return uninstall() if a.uninstall else install(a.id)


if __name__ == "__main__":
    sys.exit(main())
