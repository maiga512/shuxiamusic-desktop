#!/usr/bin/env python3
"""把桌面产物发布到 Gitee 的 desktop-latest Release。

与 GitHub 侧并行：更新器端点顺序 [Gitee, GitHub]，国内优先命中 Gitee。
依赖 make-latest-json.py 已经在 release-assets/ 里生成了 latest.gitee.json
（内容与 GitHub 版一致，只是下载地址前缀换成 Gitee）。

需要的环境变量：
  GITEE_TOKEN        Gitee 访问令牌（放 GitHub Actions Secret，别进源码）
  GITEE_REPOSITORY   owner/repo，例如 songsong2020/shuxiamusic-desktop-release
  GITEE_RELEASE_TAG  固定标签，默认 desktop-latest
  VERSION / NOTES    版本号与更新说明
  GITEE_TARGET_BRANCH 新建 Release 时打标签所依附的分支，默认 master

没有令牌时直接跳过（exit 0），方便 Secret 还没配好时整条流水线不被卡住。
"""
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
import uuid
from pathlib import Path

API = "https://gitee.com/api/v5"
TOKEN = os.environ.get("GITEE_TOKEN", "").strip()
REPO = os.environ.get("GITEE_REPOSITORY", "").strip()
TAG = os.environ.get("GITEE_RELEASE_TAG", "desktop-latest").strip()
BRANCH = os.environ.get("GITEE_TARGET_BRANCH", "master").strip()
VERSION = os.environ.get("VERSION", "").strip()
NOTES = os.environ.get("NOTES", "树夏Music 桌面版更新")
OUT = Path("release-assets")

if not TOKEN:
    print("未配置 GITEE_TOKEN，跳过 Gitee 发布。")
    sys.exit(0)
if not REPO or "/" not in REPO:
    sys.exit(f"GITEE_REPOSITORY 无效（应为 owner/repo）：{REPO!r}")


def api(method: str, path: str, data=None):
    url = f"{API}{path}"
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise SystemExit(f"Gitee API {method} {path} 失败: {e.code} {detail}")


def find_release():
    url = f"{API}/repos/{REPO}/releases/tags/{urllib.parse.quote(TAG)}?access_token={TOKEN}"
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise SystemExit(f"查询 Gitee Release 失败: {e.code} {e.read().decode(errors='replace')}")


def upload(release_id, filepath: Path, upload_name: str):
    boundary = uuid.uuid4().hex
    parts = []
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"access_token\"\r\n\r\n{TOKEN}\r\n")
    head = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{upload_name}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    )
    body = b"".join(p.encode() for p in parts)
    body += head.encode() + filepath.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{API}/repos/{REPO}/releases/{release_id}/attach_files",
        data=body,
        method="POST",
    )
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            info = json.loads(resp.read().decode())
            print(f"  上传成功: {upload_name} -> {info.get('browser_download_url')}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"上传 {upload_name} 失败: {e.code} {e.read().decode(errors='replace')}")


manifest = Path("release-assets-gitee") / "latest.json"
if not manifest.exists():
    sys.exit("缺少 release-assets-gitee/latest.json，请先运行 make-latest-json.py（并设置 GITEE_REPOSITORY）。")

skip = {"latest.json"}
installers = sorted(p for p in OUT.iterdir() if p.is_file() and p.name not in skip)
if not installers:
    sys.exit("release-assets/ 下没有可发布的安装包产物，终止。")

release = find_release()
if release is None:
    print(f"desktop-latest Release 不存在，新建（分支 {BRANCH}）。")
    release = api(
        "POST",
        f"/repos/{REPO}/releases",
        {
            "access_token": TOKEN,
            "tag_name": TAG,
            "name": f"树夏Music 桌面版 v{VERSION}",
            "body": NOTES,
            "prerelease": "false",
            "target_commitish": BRANCH,
        },
    )
else:
    print(f"复用已存在的 Release id={release.get('id')}，先清掉旧附件再重传。")
    for att in release.get("assets", []) or []:
        att_id = att.get("id") if isinstance(att, dict) else None
        name = att.get("name") if isinstance(att, dict) else None
        # Gitee 的 assets 里源码包没有可删除 id，跳过；只删我们上传过的附件。
        if att_id is None:
            continue
        api("DELETE", f"/repos/{REPO}/releases/{release['id']}/attach_files/{att_id}?access_token={TOKEN}")
        print(f"  已删除旧附件: {name}")

release_id = release["id"]
print(f"开始上传到 Gitee {REPO} @ {TAG} (release id={release_id})")
for f in installers:
    upload(release_id, f, f.name)
# Gitee 版清单以 latest.json 之名上传，这样更新器端点地址才对得上。
upload(release_id, manifest, "latest.json")

print(f"Gitee 发布完成：https://gitee.com/{REPO}/releases/download/{TAG}/latest.json")
