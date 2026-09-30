#!/usr/bin/env python3
"""根据 release-assets 里实际存在的产物生成 Tauri 更新器 latest.json。

只为成功产出的平台写入条目，因此即使某个平台（例如 Windows）本次没编出来，
Mac 用户依然能正常收到更新——Tauri 只读取与自身平台匹配的键。
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

OUT = Path("release-assets")
VERSION = os.environ["VERSION"]
NOTES = os.environ.get("NOTES", "树夏Music 桌面版更新")
TAG = os.environ["RELEASE_TAG"]
REPO = os.environ["RELEASE_REPOSITORY"]

BASE = f"https://github.com/{REPO}/releases/download/{TAG}"

# 文件名后缀 -> Tauri 平台键
TARGETS = {
    f"shuxiamusic_{VERSION}_aarch64.app.tar.gz": "darwin-aarch64",
    f"shuxiamusic_{VERSION}_x64.app.tar.gz": "darwin-x86_64",
    f"shuxiamusic_{VERSION}_windows-x64-setup.exe": "windows-x86_64",
}

platforms = {}
for filename, platform_key in TARGETS.items():
    artifact = OUT / filename
    sig = OUT / f"{filename}.sig"
    if not artifact.exists():
        print(f"跳过 {platform_key}: 缺少 {filename}")
        continue
    if not sig.exists():
        print(f"跳过 {platform_key}: 缺少签名 {filename}.sig")
        continue
    platforms[platform_key] = {
        "signature": sig.read_text().strip(),
        "url": f"{BASE}/{filename}",
    }
    print(f"加入 {platform_key}: {filename}")

if not platforms:
    raise SystemExit("没有任何平台产物可写入 latest.json，终止。")

manifest = {
    "version": VERSION,
    "notes": NOTES,
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": platforms,
}

(OUT / "latest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("已写入 release-assets/latest.json")
