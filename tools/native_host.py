# -*- coding: utf-8 -*-
"""
native_host.py — Chrome Native Messaging 宿主：给扩展提供「刷新本机库」能力

协议：stdin/stdout 各读/写 4 字节小端长度 + UTF-8 JSON。
每条命令处理完就退出（扩展每次 connectNative 只问一件事）。

命令：
    {"cmd":"ping"}   -> {"type":"pong","version":N,"python":"...","root":"..."}
    {"cmd":"scan"}   -> 先回 {"type":"start"}，扫描过程中推 {"type":"progress",...}，
                        最后 {"type":"done","count":N,"generatedAt":"..."}
                        失败 {"type":"error","message":"..."}

注意：stdout 只能有协议帧，任何 print 都要走 stderr，否则协议就废了。
"""
import json
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import scan_local_index as S
except Exception as e:  # pragma: no cover
    sys.stderr.write("import scan_local_index failed: %r\n" % (e,))
    S = None

VERSION = 1
EXT_ROOT = os.path.dirname(HERE)
INDEX_PATH = os.path.join(EXT_ROOT, "local-index.json")


def read_msg():
    head = sys.stdin.buffer.read(4)
    if len(head) < 4:
        return None
    n = struct.unpack("<I", head)[0]
    body = sys.stdin.buffer.read(n)
    if len(body) < n:
        return None
    return json.loads(body.decode("utf-8"))


def send(obj):
    b = data_bytes(obj)
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def data_bytes(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def do_scan(root):
    if S is None:
        send({"type": "error", "message": "扫描模块加载失败（scan_local_index.py）"})
        return 1
    if not os.path.isdir(root):
        send({"type": "error", "message": "目录不存在：%s" % root})
        return 1

    t0 = time.time()
    send({"type": "start", "root": root})
    last_sent = [0.0]

    def progress(files, videos, items):
        now = time.time()
        if now - last_sent[0] < 0.7:      # 别刷太密
            return
        last_sent[0] = now
        send({"type": "progress", "files": files, "videos": videos,
              "items": items, "elapsed": round(now - t0, 1)})

    try:
        data = S.build_index(root, progress=progress)
        S.write_index(INDEX_PATH, data)
    except Exception as e:
        send({"type": "error", "message": "%s: %s" % (type(e).__name__, e)})
        return 1

    total = sum(v["size"] for v in data["items"].values())
    send({
        "type": "done",
        "count": data["count"],
        "generatedAt": data["generatedAt"],
        "seconds": round(time.time() - t0, 1),
        "scannedFiles": data["scannedFiles"],
        "scannedVideos": data["scannedVideos"],
        "noCode": len(data.get("noCode", [])),
        "totalSize": total,
        "path": INDEX_PATH,
        "root": root,
    })
    return 0


def main():
    msg = read_msg()
    cmd = (msg or {}).get("cmd") or "ping"

    if cmd == "ping":
        send({"type": "pong", "version": VERSION, "python": sys.executable,
              "root": S.DEFAULT_ROOT if S else None, "index": INDEX_PATH,
              "indexExists": os.path.exists(INDEX_PATH)})
        return 0

    if cmd == "scan":
        root = (msg or {}).get("root") or (S.DEFAULT_ROOT if S else None)
        return do_scan(root)

    send({"type": "error", "message": "未知命令：%s" % cmd})
    return 1


if __name__ == "__main__":
    sys.exit(main())
