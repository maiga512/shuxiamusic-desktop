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

GITHUB_BASE = f"https://github.com/{REPO}/releases/download/{TAG}"

# 可选：同时生成一份指向 Gitee 的 latest.json。
# 更新器端点顺序为 [Gitee, GitHub]，国内优先命中 Gitee，连不上再回退 GitHub。
# GITEE_REPOSITORY 形如 songsong2020/shuxiamusic-desktop-release；
# GITEE_RELEASE_TAG 默认沿用桌面固定标签 desktop-latest。
GITEE_REPO = os.environ.get("GITEE_REPOSITORY", "").strip()
GITEE_TAG = os.environ.get("GITEE_RELEASE_TAG", "desktop-latest").strip()
GITEE_BASE = (
    f"https://gitee.com/{GITEE_REPO}/releases/download/{GITEE_TAG}" if GITEE_REPO else None
)

# 文件名后缀 -> Tauri 平台键
TARGETS = {
    f"shuxiamusic_{VERSION}_aarch64.app.tar.gz": "darwin-aarch64",
    f"shuxiamusic_{VERSION}_x64.app.tar.gz": "darwin-x86_64",
    f"shuxiamusic_{VERSION}_windows-x64-setup.exe": "windows-x86_64",
}

# 先确定本次实际产出的平台（Gitee 与 GitHub 两份清单内容一致，只是下载地址前缀不同）。
present = {}
for filename, platform_key in TARGETS.items():
    artifact = OUT / filename
    sig = OUT / f"{filename}.sig"
    if not artifact.exists():
        print(f"跳过 {platform_key}: 缺少 {filename}")
        continue
    if not sig.exists():
        print(f"跳过 {platform_key}: 缺少签名 {filename}.sig")
        continue
    present[platform_key] = (filename, sig.read_text().strip())
    print(f"加入 {platform_key}: {filename}")

if not present:
    raise SystemExit("没有任何平台产物可写入 latest.json，终止。")


def build_manifest(base: str) -> dict:
    platforms = {
        platform_key: {"signature": signature, "url": f"{base}/{filename}"}
        for platform_key, (filename, signature) in present.items()
    }
    return {
        "version": VERSION,
        "notes": NOTES,
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }


# GitHub 版：文件名 latest.json，随 GitHub Release 一起上传。
(OUT / "latest.json").write_text(
    json.dumps(build_manifest(GITHUB_BASE), ensure_ascii=False, indent=2) + "\n"
)
print("已写入 release-assets/latest.json (GitHub)")

# Gitee 版：写到独立目录 release-assets-gitee/latest.json，避免被 GitHub Release
# 的 files: release-assets/**/* 一并上传。发布脚本直接取这个文件当作 latest.json 上传到 Gitee。
if GITEE_BASE:
    gitee_dir = Path("release-assets-gitee")
    gitee_dir.mkdir(exist_ok=True)
    (gitee_dir / "latest.json").write_text(
        json.dumps(build_manifest(GITEE_BASE), ensure_ascii=False, indent=2) + "\n"
    )
    print(f"已写入 release-assets-gitee/latest.json (Gitee: {GITEE_REPO}/{GITEE_TAG})")
else:
    print("未设置 GITEE_REPOSITORY，跳过 Gitee latest.json 生成")
