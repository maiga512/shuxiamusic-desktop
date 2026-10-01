# macOS 应用公证指南

## 问题现象

用户下载 DMG 后，双击应用时 macOS 提示"无法打开，因为它来自身份不明的开发者"，需要：
1. 右键 → 打开
2. 或输入命令：`sudo xattr -r -d com.apple.quarantine /Applications/树夏Music.app`

## 根本原因

应用**没有经过 Apple 公证（Notarization）**。macOS Gatekeeper 会阻止所有未公证的应用。

---

## 解决方案：启用应用公证

### 步骤 1：加入 Apple Developer Program

1. 访问：https://developer.apple.com/programs/
2. 支付 $99/年 加入开发者计划
3. 获得 Apple Developer 账户

### 步骤 2：创建 App-Specific Password

1. 访问：https://appleid.apple.com/account/manage
2. 登录您的 Apple ID（开发者账户）
3. 安全 → App-Specific Passwords → 生成新密码
4. 记录这个密码（格式：`xxxx-xxxx-xxxx-xxxx`）

### 步骤 3：在 GitHub 添加 Secrets

在 `maiga512/shuxiamusic-desktop` 仓库添加以下 Secrets：

```
Settings → Secrets and variables → Actions → New repository secret
```

需要添加三个：

1. **APPLE_CERTIFICATE**
   - Base64 编码的开发者证书（.p12 文件）
   - 导出证书：
     ```bash
     # 1. 在 Keychain Access 中导出证书为 certificate.p12
     # 2. 转换为 base64
     base64 -i certificate.p12 | pbcopy
     # 3. 粘贴到 GitHub Secret
     ```

2. **APPLE_CERTIFICATE_PASSWORD**
   - 导出 .p12 文件时设置的密码

3. **APPLE_ID** 和 **APPLE_PASSWORD**
   - `APPLE_ID`: 您的 Apple Developer 账户邮箱
   - `APPLE_PASSWORD`: 步骤 2 生成的 App-Specific Password

4. **APPLE_TEAM_ID**
   - 在 https://developer.apple.com/account 查看
   - 格式：10 位字母数字，例如 `A1B2C3D4E5`

### 步骤 4：修改 GitHub Actions 配置

在 `.github/workflows/desktop-release.yml` 的 Mac 编译任务中添加：

```yaml
build-macos-arm64:
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Your Name (TEAM_ID)"
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
    # 启用公证
    TAURI_APPLE_NOTARIZE: "true"
```

在编译步骤前添加证书导入：

```yaml
- name: 导入 Apple 证书
  run: |
    KEYCHAIN_PATH=$RUNNER_TEMP/app-signing.keychain-db
    KEYCHAIN_PASSWORD=$(openssl rand -base64 32)
    
    # 创建临时 keychain
    security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
    
    # 导入证书
    echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
    security import certificate.p12 -P "$APPLE_CERTIFICATE_PASSWORD" \
      -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
    
    # 设置为默认 keychain
    security list-keychain -d user -s "$KEYCHAIN_PATH"
```

### 步骤 5：更新 tauri.conf.json

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "entitlements": null,
      "notarize": {
        "enabled": true
      }
    }
  }
}
```

---

## 公证后的效果

✅ 用户下载 DMG 后，双击应用**直接打开**，无需任何命令  
✅ 显示"已验证开发者"，增加用户信任度  
✅ Gatekeeper 不再阻止应用启动  
✅ 自动更新时，新版本也能直接打开  

---

## 替代方案（不推荐）

如果暂时不想花 $99：

### 方案 A：用户手动移除隔离属性
```bash
sudo xattr -r -d com.apple.quarantine /Applications/树夏Music.app
```
**缺点**：每次更新都需要重新输入

### 方案 B：提供安装脚本
在 DMG 中包含一个 `install.command` 脚本：
```bash
#!/bin/bash
xattr -r -d com.apple.quarantine "$1/树夏Music.app"
open "$1/树夏Music.app"
```
**缺点**：用户需要手动运行脚本

---

## 总结

**最佳方案**：花 $99 加入 Apple Developer，启用应用公证。这是唯一能让用户无障碍使用的方法。

公证不仅解决了 Gatekeeper 问题，还能：
- 提升应用专业度
- 增加用户信任
- 支持自动更新
- 符合 macOS 生态规范

**之前能双击打开的原因**：可能是本地开发环境，或者是从可信来源（如 App Store）下载的应用。GitHub Release 下载的应用一定会被 Gatekeeper 检查。
