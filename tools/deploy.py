#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
deploy.py — 把仓库里的源码同步到 Chrome 实际加载扩展的目录

浏览器加载的是「解压后的目录」，本仓库是源码所在。改完代码跑一次本脚本即可。

    python tools/deploy.py --to "D:\\ext\\jav-code-lookup"
    JAV_EXT_TARGET="D:\\ext\\jav-code-lookup" python tools/deploy.py

只同步源码；目标目录里的 local-index.json（你的片库索引）、
tools/com.hermes.javindex.json（宿主清单，含本机扩展 ID）不会被覆盖或删除。
"""
import argparse
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

SKIP_DIRS = {"__pycache__", ".git", "docs"}
# 目标目录里由本机生成、不能覆盖的文件
KEEP_TARGET = {"local-index.json"}
KEEP_TARGET_PATHS = {os.path.join("tools", "com.hermes.javindex.json")}


def main():
    ap = argparse.ArgumentParser(description="同步源码到 Chrome 扩展目录")
    ap.add_argument("--to", default=os.environ.get("JAV_EXT_TARGET", ""),
                    help="Chrome 加载扩展的目录（也可用环境变量 JAV_EXT_TARGET）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if not a.to:
        sys.stderr.write(
            "[错误] 没指定目标目录。\n"
            "       用法: python tools/deploy.py --to \"<你加载扩展时选的目录>\"\n"
            "       或设置环境变量 JAV_EXT_TARGET\n")
        return 2
    dst = os.path.abspath(a.to)
    if not os.path.isdir(dst):
        sys.stderr.write("[错误] 目标目录不存在：%s\n" % dst)
        return 2

    copied = same = skipped = 0
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        rel = os.path.relpath(root, ROOT)
        for name in files:
            relpath = name if rel == "." else os.path.join(rel, name)
            if relpath in KEEP_TARGET or relpath.replace("/", "\\") in KEEP_TARGET_PATHS:
                skipped += 1
                continue
            if name.endswith((".pyc", ".log")):
                continue
            src = os.path.join(root, name)
            tgt_dir = dst if rel == "." else os.path.join(dst, rel)
            tgt = os.path.join(tgt_dir, name)
            with io.open(src, "rb") as f:
                data = f.read()
            if os.path.exists(tgt):
                with io.open(tgt, "rb") as f:
                    if f.read() == data:
                        same += 1
                        continue
            if a.dry_run:
                print("would copy:", relpath)
                copied += 1
                continue
            os.makedirs(tgt_dir, exist_ok=True)
            with io.open(tgt, "wb") as f:
                f.write(data)
            copied += 1
            print("→", relpath)

    print("\n%s：复制 %d 个，未变 %d 个%s" % (
        "预演" if a.dry_run else "完成", copied, same,
        ("，跳过本机生成文件 %d 个" % skipped) if skipped else ""))
    if copied and not a.dry_run:
        print("记得到 chrome://extensions 点一下扩展的刷新图标（改了 sw.js 还要升 manifest 的 version）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
