#!/usr/bin/env bash
# 收集 Windows NSIS 产物并改成 ASCII 唯一名。
set -euo pipefail

TRIPLE="$1"   # x86_64-pc-windows-msvc
LABEL="$2"    # windows-x64
VERSION="$3"

BUNDLE="src-tauri/target/${TRIPLE}/release/bundle"
OUT="release-assets"
mkdir -p "$OUT"

# Tauri 2 的 NSIS 更新器产物：*-setup.exe + *-setup.exe.sig
SETUP=$(ls "${BUNDLE}"/nsis/*-setup.exe 2>/dev/null | head -n1 || true)
if [[ -z "${SETUP}" ]]; then
  echo "未找到 *-setup.exe，检查 NSIS/updater/签名配置。" >&2
  ls -la "${BUNDLE}/nsis" || true
  exit 1
fi
cp "${SETUP}"      "${OUT}/shuxiamusic_${VERSION}_${LABEL}-setup.exe"
if [[ -f "${SETUP}.sig" ]]; then
  cp "${SETUP}.sig" "${OUT}/shuxiamusic_${VERSION}_${LABEL}-setup.exe.sig"
else
  echo "缺少 ${SETUP}.sig，更新器无法验证 Windows 包。" >&2
  exit 1
fi

echo "已收集 Windows(${LABEL}) 产物:"
ls -la "${OUT}"
