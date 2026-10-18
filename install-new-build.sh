#!/bin/bash
# 安装最新编译的树夏Music（正式 release 包）到 /Applications。
#
# 重要：不要在这里重新签名！构建产物已经用固定的 "Shuxia Music Self-Signed"
# 证书签过（见 src-tauri/tauri.conf.json 的 bundle.macOS.signingIdentity）。
# 之前用 `codesign --force --deep --sign -` 重签会把证书签名换成 ad-hoc，
# 而 ad-hoc 的 designated requirement 是 cdhash（二进制哈希），每次重新编译
# 都会变，导致 macOS 的辅助功能权限每次都要重授。保持证书签名，权限才稳定。
#
# 同理不要换成 keychain 里那个改名前的旧证书 "Ceru Music Self-Signed"：
# 换证书就是换 DR，已授的辅助功能/麦克风权限全部作废重来。
set -e

APP_SRC="src-tauri/target/release/bundle/macos/树夏Music.app"
APP_DST="/Applications/树夏Music.app"

echo "🚀 安装最新编译的树夏Music（release）"
echo ""

echo "1️⃣ 关闭运行中的应用..."
killall "ceru-music" "树夏Music" 2>/dev/null || true
sleep 2

echo "2️⃣ 备份旧版本..."
if [ -d "$APP_DST" ]; then
  mv "$APP_DST" "$HOME/旧版树夏Music-$(date +%m%d%H%M).app"
fi

echo "3️⃣ 安装新版本..."
cp -R "$APP_SRC" /Applications/

echo "4️⃣ 去掉隔离属性（不重新签名，保留固定证书签名）..."
xattr -cr "$APP_DST"

echo "5️⃣ 校验签名..."
codesign --verify --verbose=2 "$APP_DST"
codesign -d -r- "$APP_DST" 2>&1 | tail -1

echo ""
echo "✅ 安装完成！签名身份固定为 Shuxia Music Self-Signed，辅助功能权限可跨版本保留。"
