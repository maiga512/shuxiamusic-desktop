#!/usr/bin/env bash
# Gitee 本地直连兜底发布：GitHub 境外 runner 往 Gitee 传大文件被跨境限速超时时，
# 用本机（国内直连 Gitee）把 CI 已编好的产物发布到 Gitee 的 desktop-latest，
# 保证国内用户正常收到更新。正常发布仍走 workflow_dispatch 流水线（令牌在
# GITEE_RELEASE_TOKEN secret 里，不需要人工提供）；本脚本只用于流水线卡住时兜底。
#
# 前提：工作目录 $1 下有一个平铺的安装件目录：
#   release-assets/
#     shuxiamusic_<版本>_aarch64.app.tar.gz      (+ .sig)
#     shuxiamusic_<版本>_aarch64.dmg
#     shuxiamusic_<版本>_windows-x64-setup.exe   (+ .sig)
#   可从 CI 下载后平铺得到：
#     gh run download <RUN_ID> -D /tmp/ceru-release/work
#     把 desktop-macos-arm64/ 与 desktop-windows-x64/ 里的文件平铺进 release-assets/
#
# 用法:
#   scripts/ci/publish-gitee-local.sh <工作目录> <版本号> [更新说明]
# 例:
#   scripts/ci/publish-gitee-local.sh /tmp/ceru-release/work 1.0.6 "修复输入框拖拽选择复制"
#
# 令牌从 ~/.config/ceru/gitee_token 读取（兜底 ~/.gitee-token），无需每次再提供。
# 缺 release-assets-gitee/latest.json 时自动用 make-latest-json.py 生成。
# 注意：Gitee 列表接口不返回附件 id，脚本无法精确删旧附件；若目标 Release 里混有
# 旧版本附件，请先 DELETE 整个 release（API /releases/{id}）再跑本脚本重建。
set -euo pipefail

WORK_DIR="${1:?用法: publish-gitee-local.sh <工作目录> <版本号> [更新说明]}"
VERSION="${2:?缺少版本号参数}"
NOTES="${3:-树夏Music 桌面版更新}"

TOKEN_FILE="$HOME/.config/ceru/gitee_token"
[ -f "$TOKEN_FILE" ] || TOKEN_FILE="$HOME/.gitee-token"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "错误：找不到 Gitee 令牌（已查 ~/.config/ceru/gitee_token 与 ~/.gitee-token）。" >&2
  echo "先创建：echo '<令牌>' > ~/.config/ceru/gitee_token && chmod 600 ~/.config/ceru/gitee_token" >&2
  exit 1
fi

cd "$WORK_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f release-assets-gitee/latest.json ]; then
  echo "未检测到 release-assets-gitee/latest.json，自动生成..."
  VERSION="$VERSION" NOTES="$NOTES" \
  RELEASE_TAG=desktop-latest \
  RELEASE_REPOSITORY=maiga512/shuxiamusic-release \
  GITEE_REPOSITORY=songsong2020/shuxiamusic-desktop-release \
  python3 "$SCRIPT_DIR/make-latest-json.py"
fi

GITEE_TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")" \
GITEE_REPOSITORY=songsong2020/shuxiamusic-desktop-release \
GITEE_RELEASE_TAG=desktop-latest \
VERSION="$VERSION" \
NOTES="$NOTES" \
python3 "$SCRIPT_DIR/publish-gitee.py"

echo ""
echo "更新器清单校验（应看到 version $VERSION 且 URL 指向 Gitee）："
curl -fsS --max-time 30 \
  "https://gitee.com/songsong2020/shuxiamusic-desktop-release/releases/download/desktop-latest/latest.json" \
  | head -c 400
echo ""
