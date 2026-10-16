# 桌面版双平台发布（GitHub + Gitee）

## 发布页项目来源署名

发布中心 README 的介绍段落后必须保留以下来源说明，并在桌面端下载段落再次简要标注：

> **项目来源与架构迁移**：树夏Music 桌面版基于澜音 Music（Ceru Music）改进而来，
> 将原 Electron + Vue 架构迁移为 Tauri 2 + Rust + Vue 3。感谢澜音团队的原项目与设计基础。
>
> 原项目：[maiga512/CeruMusic](https://github.com/maiga512/CeruMusic) · [项目主页](https://ceru.docs.shiqianjiang.cn)

树夏Music 桌面版同时发布到两个平台，更新器会优先用国内更快的 Gitee，连不上再自动回退 GitHub。

## 更新器怎么“哪边快用哪边”

`src-tauri/tauri.conf.json` 的更新端点是一个**有序列表**，顺序为 `[Gitee, GitHub]`：

```
https://gitee.com/songsong2020/shuxiamusic-desktop-release/releases/download/desktop-latest/latest.json
https://github.com/maiga512/shuxiamusic-release/releases/download/desktop-latest/latest.json
```

Tauri 原生更新器按顺序逐个尝试，第一个能拉到就用它、拉不到才换下一个。对国内网络来说
Gitee 基本就是更快、更稳的那个；Gitee 挂了会自动回退 GitHub。这是“优先 + 兜底”，不是逐次测速。

## 两个发布仓库

| 平台 | 仓库 | 标签 | 说明 |
| --- | --- | --- | --- |
| GitHub | `maiga512/shuxiamusic-release` | `desktop-latest` | 与安卓共用，发布时 `make_latest=false`，不抢安卓的“最新 Release”指针 |
| Gitee | `songsong2020/shuxiamusic-desktop-release` | `desktop-latest` | 桌面**专用**公开仓库，与安卓分开，避免抢占“最新版” |

Gitee 为什么单独一个仓库：GitHub 有 `make_latest=false` 开关能让桌面发布不抢“最新 Release”，
Gitee 没有同等开关，所以桌面放独立仓库，彻底避免干扰安卓更新。

## 需要的 GitHub Actions Secrets

| Secret | 用途 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 更新包签名（公钥在 tauri.conf.json） |
| `RELEASE_REPO_TOKEN` | 发布到 GitHub `maiga512/shuxiamusic-release` 的 PAT |
| `GITEE_RELEASE_TOKEN` | 发布到 Gitee 桌面仓库的访问令牌。**缺这个时 Gitee 步骤自动跳过，只发 GitHub** |

令牌只放 Secret，源码/配置里绝不出现明文。

## 公开 Runner 免额度方案（推荐）

桌面源码仓库 `maiga512/shuxiamusic-desktop` 已公开。公开发布仓库
`maiga512/shuxiamusic-release` 的构建工作流会直接 Checkout 公开桌面源码，
不依赖私有源码 Token，也不需要等待私有仓库额度：

```text
maiga512/shuxiamusic-release
  .github/workflows/desktop-release-public.yml
```

该工作流在**公开仓库**申请 `ubuntu-latest` / `macos-14` / `windows-latest` Runner，
直接 Checkout `maiga512/shuxiamusic-desktop` 的 `main` 或 `desktop-vX.Y.Z` 标签。
发布仓库只保留 Release 中心 README、CHANGELOG、产品截图和工作流，不存放桌面源码副本。

公开仓库 Secrets：

- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：更新包签名。
- `CERU_MPV_WINDOWS_URL`：Windows 内置便携 MPV 压缩包地址。

发布命令：

```bash
gh workflow run "Desktop Release Public" \
  -R maiga512/shuxiamusic-release \
  --ref main \
  -f version=1.1.5 \
  -f source_ref=main \
  -f release_notes="树夏Music 桌面版 v1.1.5：修复听歌识曲麦克风授权与录音启动。"
```

`source_ref` 默认是 `main`，便于先验证源码；正式发布时显式传入 `desktop-vX.Y.Z` 标签，
确保构建内容与版本标签完全一致。收到用户发布通知后，再创建标签、触发公开 Runner并生成安装包。

## 发布流程

1. 改完代码、确定要发版。
2. 升版本号：改 `package.json` 的 `version`（`tauri.conf.json` 的 `version` 继承自它）。
3. 触发 GitHub Actions `Desktop Release` 工作流：
   - 手动：Actions → Desktop Release → Run workflow，可填版本号与更新说明；或
   - 打标签：`git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`。
4. 工作流会：编包 → `scripts/ci/make-latest-json.py` 生成两份 `latest.json`（GitHub 版 +
   Gitee 版，URL 前缀不同）→ 发到 GitHub `desktop-latest` → 再发到 Gitee `desktop-latest`
   （`scripts/ci/publish-gitee.py`）。
5. Gitee 步骤带 `continue-on-error`：即使 Gitee 上传失败也不影响已完成的 GitHub 发布，
   更新器会自动回退 GitHub。

## 相关文件

- `src-tauri/tauri.conf.json` — 更新端点顺序 `[Gitee, GitHub]`
- `scripts/ci/make-latest-json.py` — 生成 GitHub + Gitee 两份清单
- `scripts/ci/publish-gitee.py` — 创建/更新 Gitee `desktop-latest` Release 并上传产物
- `.github/workflows/desktop-release.yml` — 发布工作流
- `maiga512/shuxiamusic-release:.github/workflows/desktop-release-public.yml` — 公开 Runner 免额度构建工作流

## 注意事项

- Gitee 发布仓库必须保持**公开**，否则更新器匿名下载不到安装包。
- Gitee 桌面发布仓库的**总附件配额是 1GB**。旧版本累计会把 `desktop-v1.1.3` 的 Windows 包顶掉；
  发布前如遇 `文件大小已超出仓库附件配额`，直接 DELETE 旧版本化 Release 和混有旧附件的
  `desktop-latest`，再运行 `publish-gitee-local.sh` 重建。Gitee 列表接口不返回附件 id，
  试图只删单个旧附件不可靠，必须整 Release 重建。
- Gitee 单文件附件也有体积上限；若桌面安装包超限会导致 Gitee 上传失败（此时自动回退 GitHub）。
- 安卓 APK 仍可从公开 Release 附件下载，但安卓源码不再放在发布中心仓库；
  发布中心仓库只保留 README、截图和必要工作流。
