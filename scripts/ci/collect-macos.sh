#!/usr/bin/env bash
# 收集 macOS 产物并改成 ASCII 唯一名，避免 arm64/x64 同名冲突，
# 也方便 latest.json 里的下载 URL 稳定。
set -euo pipefail

TRIPLE="$1"   # aarch64-apple-darwin / x86_64-apple-darwin
LABEL="$2"    # aarch64 / x64
VERSION="$3"

BUNDLE="src-tauri/target/${TRIPLE}/release/bundle"
OUT="release-assets"
mkdir -p "$OUT"

# 更新器产物：.app.tar.gz + .sig（Tauri 在配置了 updater 且有签名私钥时生成）
TARBALL=$(ls "${BUNDLE}"/macos/*.app.tar.gz 2>/dev/null | head -n1 || true)
if [[ -z "${TARBALL}" ]]; then
  echo "未找到 .app.tar.gz 更新器产物，检查 updater/签名配置是否生效。" >&2
  ls -la "${BUNDLE}/macos" || true
  exit 1
fi
cp "${TARBALL}"      "${OUT}/shuxiamusic_${VERSION}_${LABEL}.app.tar.gz"
cp "${TARBALL}.sig"  "${OUT}/shuxiamusic_${VERSION}_${LABEL}.app.tar.gz.sig"

# DMG：给用户手动下载安装
DMG=$(ls "${BUNDLE}"/dmg/*.dmg 2>/dev/null | head -n1 || true)
if [[ -n "${DMG}" ]]; then
  cp "${DMG}" "${OUT}/shuxiamusic_${VERSION}_${LABEL}.dmg"
fi

echo "已收集 macOS(${LABEL}) 产物:"
ls -la "${OUT}"
