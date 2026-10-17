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

流程：
  1) 固定标签 desktop-latest（更新器主通道）：清旧附件，重传全部安装包 + latest.json
  2) 版本化 Release（desktop-v<版本>）：每版本独立，旧版可随时下载；只传安装包，不传 latest.json

没有令牌时直接报错退出（exit 1）。Gitee 是国内更新主通道，必须发布成功，
不能静默跳过，否则国内用户收不到更新。
"""
import json
import os
import re
import sys
import time
import tempfile
import urllib.request
import urllib.parse
import urllib.error
import uuid
from pathlib import Path

# 境外 GitHub 运行器上传大文件到 Gitee 常被限速导致 write timeout。
# 多次重试 + 指数退避，并把 multipart 落盘后以文件流发送（不整包塞进内存）。
UPLOAD_RETRIES = int(os.environ.get("GITEE_UPLOAD_RETRIES", "5"))
UPLOAD_BACKOFF = float(os.environ.get("GITEE_UPLOAD_BACKOFF", "5"))

API = "https://gitee.com/api/v5"
TOKEN = os.environ.get("GITEE_TOKEN", "").strip()
REPO = os.environ.get("GITEE_REPOSITORY", "").strip()
TAG = os.environ.get("GITEE_RELEASE_TAG", "desktop-latest").strip()
BRANCH = os.environ.get("GITEE_TARGET_BRANCH", "master").strip()
VERSION = os.environ.get("VERSION", "").strip()
NOTES = os.environ.get("NOTES", "树夏Music 桌面版更新")
OUT = Path("release-assets")

if not TOKEN:
    sys.exit("::error::未配置 GITEE_TOKEN，无法发布到 Gitee。Gitee 是国内更新主通道，必须配置令牌。")
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


def find_release(tag: str):
    url = f"{API}/repos/{REPO}/releases/tags/{urllib.parse.quote(tag)}?access_token={TOKEN}"
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise SystemExit(f"查询 Gitee Release 失败: {e.code} {e.read().decode(errors='replace')}")


def upload(release_id, filepath: Path, upload_name: str):
    boundary = uuid.uuid4().hex
    pre = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"access_token\"\r\n\r\n{TOKEN}\r\n"
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{upload_name}\"\r\n"
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    post = f"\r\n--{boundary}--\r\n".encode()
    content_length = len(pre) + filepath.stat().st_size + len(post)

    # 把整个 multipart 落到临时文件，上传时按文件流发送，避免大文件撑爆内存，
    # 同时每次重试都能从头重放同一份请求体。
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(pre)
        with filepath.open("rb") as src:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        tmp.write(post)

    url = f"{API}/repos/{REPO}/releases/{release_id}/attach_files"
    last_err = None
    try:
        for attempt in range(1, UPLOAD_RETRIES + 1):
            with tmp_path.open("rb") as body:
                req = urllib.request.Request(url, data=body, method="POST")
                req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
                req.add_header("Content-Length", str(content_length))
                try:
                    with urllib.request.urlopen(req, timeout=600) as resp:
                        info = json.loads(resp.read().decode())
                        print(f"  上传成功: {upload_name} -> {info.get('browser_download_url')}")
                        return
                except urllib.error.HTTPError as e:
                    detail = e.read().decode(errors="replace")
                    # 4xx 多半是鉴权/参数问题，重试没意义，直接失败。
                    if e.code < 500:
                        raise SystemExit(f"上传 {upload_name} 失败: {e.code} {detail}")
                    last_err = f"{e.code} {detail}"
                except (urllib.error.URLError, TimeoutError, OSError) as e:
                    last_err = str(e)
            if attempt < UPLOAD_RETRIES:
                wait = UPLOAD_BACKOFF * attempt
                print(f"  上传 {upload_name} 第 {attempt} 次失败({last_err})，{wait:.0f}s 后重试")
                time.sleep(wait)
        raise SystemExit(f"上传 {upload_name} 失败：重试 {UPLOAD_RETRIES} 次仍超时/出错，最后错误：{last_err}")
    finally:
        tmp_path.unlink(missing_ok=True)


MANIFEST = Path("release-assets-gitee") / "latest.json"
VERSION_PLAIN = VERSION.lstrip("v")

# 由 main() 填充：release-assets/ 下所有安装包（不含 latest.json）。
installers: list = []


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """不自动跟随重定向，用于从第一跳 Location 里取出附件 id。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def resolve_attach_id(browser_download_url: str):
    """取附件的 attach_file_id。

    Gitee 的 releases 列表接口只返回附件名，不返回 id（assets 里没有 id 字段），
    所以没法直接用列表里的 id 去删；但附件的下载地址第一跳 302 会跳到
    ``.../attach_files/<id>/download/<name>``，据此可精确拿到 attach_file_id。
    Gitee 自动生成的源码包（.zip/.tar.gz）不是附件，这条路径会 404，返回 None。
    """
    if not browser_download_url:
        return None
    location = ""
    try:
        with _NO_REDIRECT_OPENER.open(browser_download_url, timeout=60) as resp:
            location = resp.headers.get("Location", "") or ""
    except urllib.error.HTTPError as e:
        location = (e.headers.get("Location", "") or "") if e.headers else ""
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    m = re.search(r"/attach_files/(\d+)/download/", location)
    return int(m.group(1)) if m else None


def delete_attachment(release_id, att_id: int) -> bool:
    """按 attach_file_id 删除单个附件；已被删掉（404）时返回 False，不当作失败。"""
    url = f"{API}/repos/{REPO}/releases/{release_id}/attach_files/{att_id}?access_token={TOKEN}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise SystemExit(f"删除附件 {att_id} 失败: {e.code} {e.read().decode(errors='replace')}")


def ensure_release(tag: str, release_name: str) -> int:
    """找到或创建指定标签的 Release；复用已有 Release 时先删旧附件。返回 release id。"""
    release = find_release(tag)
    if release is None:
        print(f"Release {tag} 不存在，新建（分支 {BRANCH}）。")
        release = api(
            "POST",
            f"/repos/{REPO}/releases",
            {
                "access_token": TOKEN,
                "tag_name": tag,
                "name": release_name,
                "body": NOTES,
                "prerelease": "false",
                "target_commitish": BRANCH,
            },
        )
        return release["id"]

    print(f"复用已存在的 Release {tag} id={release.get('id')}，先清掉旧附件再重传。")
    # 附件名可能重复堆积（历史遗留的同名 latest.json / 多版本安装包），而下载地址每次
    # 只解析到其中一个，所以反复扫描，直到某一轮再也解析不出可删附件为止。
    release_id = release["id"]
    for _ in range(10):
        deleted = 0
        for att in release.get("assets", []) or []:
            if not isinstance(att, dict):
                continue
            name = att.get("name")
            att_id = att.get("id") or resolve_attach_id(att.get("browser_download_url"))
            if att_id is None:
                continue
            if delete_attachment(release_id, att_id):
                deleted += 1
                print(f"  已删除旧附件: {name} (id={att_id})")
        if not deleted:
            break
        release = find_release(tag) or {"id": release_id, "assets": []}
    return release_id


def publish_tag(tag: str, release_name: str, include_manifest: bool):
    release_id = ensure_release(tag, release_name)
    print(f"开始上传到 Gitee {REPO} @ {tag} (release id={release_id})")
    for f in installers:
        upload(release_id, f, f.name)
    if include_manifest:
        if not MANIFEST.exists():
            sys.exit(f"缺少 {MANIFEST}，请先运行 make-latest-json.py（并设置 GITEE_REPOSITORY）。")
        # Gitee 版清单以 latest.json 之名上传，这样更新器端点地址才对得上。
        upload(release_id, MANIFEST, "latest.json")
    print(f"Gitee {tag} 发布完成: https://gitee.com/{REPO}/releases/tag/{tag}")


def main():
    global installers
    installers = sorted(p for p in OUT.iterdir() if p.is_file() and p.name != "latest.json")
    if not installers:
        sys.exit("release-assets/ 下没有可发布的安装包产物，终止。")

    # 1) 固定标签 desktop-latest：更新器主通道（安装包 + latest.json）
    publish_tag(TAG, f"树夏Music 桌面版 v{VERSION_PLAIN}", include_manifest=True)

    # 2) 版本化 Release（desktop-v<版本>）：每个版本一个，不被固定标签覆盖，
    #    发布中心首页「全部历史版本」可据此随时下载旧版本。不附 latest.json（只给 desktop-latest 用）。
    publish_tag(f"desktop-v{VERSION_PLAIN}", f"树夏Music 桌面版 v{VERSION_PLAIN}", include_manifest=False)

    print(f"Gitee 发布完成：https://gitee.com/{REPO}/releases/download/{TAG}/latest.json")


if __name__ == "__main__":
    main()
