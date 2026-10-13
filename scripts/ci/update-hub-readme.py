#!/usr/bin/env python3
"""更新发布中心首页（shuxiamusic-release）README 里某一端的「当前版本」。

桌面端 CI 每次发版后调用，把表格里「树夏Music 桌面端」行的版本号更新为本版本，
并同步 GitHub / Gitee 两份 hub README（内容保持一致）。

所需环境变量：
  GH_TOKEN       GitHub 令牌，需要对 maiga512/shuxiamusic-release 有写权限
  HUB_VERSION    新版本号，可带可不带 v 前缀（如 1.0.7 或 v1.0.7）
可选环境变量：
  GITEE_TOKEN    Gitee 令牌（同步 Gitee 镜像用；不配置则只更 GitHub 并提示）
  HUB_ROW        表格行名称，默认「树夏Music 桌面端」
  HUB_GITHUB_REPO / HUB_GITEE_REPO / HUB_GITEE_BRANCH  换 hub 仓库或分支用

失败语义：
  GitHub README 更新失败 → exit 1（CI 报错，因为它是首页的源）
  Gitee 镜像更新失败     → 只告警不退出（镜像可稍后补，不影响发布本身）
版本号没变化时什么都不推，直接退出 0。
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

GH_API = "https://api.github.com"
GH_REPO = os.environ.get("HUB_GITHUB_REPO", "maiga512/shuxiamusic-release")
GITEE_API = "https://gitee.com/api/v5"
GITEE_REPO = os.environ.get("HUB_GITEE_REPO", "songsong2020/shuxiamusic-release")
GITEE_BRANCH = os.environ.get("HUB_GITEE_BRANCH", "master")


def transform(content: str, row: str, version: str) -> str:
    """只替换 row 对应行的版本单元格（| v1.0.6 | 这种），找不到就报错。"""
    ver = version if version.startswith("v") else f"v{version}"
    lines = content.splitlines(keepends=True)
    hit = False
    for i, line in enumerate(lines):
        if f"**{row}**" in line:
            lines[i], n = re.subn(r"\| v\d+(?:\.\d+)+ \|", f"| {ver} |", line)
            if n == 0:
                raise SystemExit(f"在行 {row!r} 里没找到版本单元格，无法安全替换:\n{line}")
            hit = True
            break
    if not hit:
        raise SystemExit(f"README 里找不到行 {row!r}")
    return "".join(lines)


def gh_request(method: str, path: str, token: str, payload=None):
    """GitHub REST 调用，网络类失败最多重试 3 次。"""
    last = ""
    for attempt in range(3):
        req = urllib.request.Request(
            f"{GH_API}{path}",
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "shuxia-hub-readme-updater",
            },
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read().decode(errors='replace')[:500]}"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = str(e)
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    raise SystemExit(f"GitHub API {method} {path} 失败（重试 3 次）: {last}")


def main():
    token = os.environ.get("GH_TOKEN", "").strip()
    row = os.environ.get("HUB_ROW", "树夏Music 桌面端").strip()
    version = os.environ.get("HUB_VERSION", "").strip()
    if not token:
        sys.exit("::error::未配置 GH_TOKEN，无法更新发布中心首页。")
    if not version:
        sys.exit("::error::未配置 HUB_VERSION。")
    ver = version if version.startswith("v") else f"v{version}"

    cur = gh_request("GET", f"/repos/{GH_REPO}/contents/README.md", token)
    content = base64.b64decode(cur["content"]).decode("utf-8")
    new_content = transform(content, row, version)
    if new_content == content:
        print(f"ℹ️ {row} 首页版本已经是 {ver}，无需更新。")
        return
    gh_request("PUT", f"/repos/{GH_REPO}/contents/README.md", token, {
        "message": f"chore(hub): 自动更新 {row} 版本为 {ver}",
        "sha": cur["sha"],
        "content": base64.b64encode(new_content.encode("utf-8")).decode("ascii"),
    })
    print(f"✅ GitHub 首页已更新：{GH_REPO}（{row} → {ver}）")

    gtoken = os.environ.get("GITEE_TOKEN", "").strip()
    if not gtoken:
        print("⚠️ 未配置 GITEE_TOKEN，跳过 Gitee 首页同步（可稍后手动同步）。")
        return
    try:
        url = f"{GITEE_API}/repos/{GITEE_REPO}/contents/README.md?access_token={gtoken}"
        with urllib.request.urlopen(url, timeout=30) as resp:
            cur_g = json.loads(resp.read().decode("utf-8"))
        data = urllib.parse.urlencode({
            "access_token": gtoken,
            "branch": GITEE_BRANCH,
            "sha": cur_g["sha"],
            "message": f"chore(hub): 自动更新 {row} 版本为 {ver}",
            "content": base64.b64encode(new_content.encode("utf-8")).decode("ascii"),
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{GITEE_API}/repos/{GITEE_REPO}/contents/README.md",
            data=data, method="PUT",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            json.loads(resp.read().decode("utf-8"))
        print(f"✅ Gitee 首页已更新：{GITEE_REPO}（{row} → {ver}）")
    except Exception as e:
        print(f"::warning::Gitee 首页同步失败（不影响本次发布，可稍后手动同步）: {e}")


if __name__ == "__main__":
    main()
