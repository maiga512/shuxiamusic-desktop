# 桌面版双平台发布（GitHub + Gitee）

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

## 公开 Runner 免额度方案（私有 Actions 被账单拦截时）

源码仓库 `maiga512/shuxiamusic-desktop` 是私有仓库。若 GitHub 提示
`recent account payments have failed or your spending limit needs to be increased`，
不要等待私有仓库额度恢复，改用公开发布仓库里的构建工作流：

```text
maiga512/shuxiamusic-release
  .github/workflows/desktop-release-public.yml
```

该工作流在**公开仓库**申请 `ubuntu-latest` / `macos-14` / `windows-latest` Runner，
再通过 `SOURCE_REPO_TOKEN` 私密读取私有源码标签。源码不提交到公开仓库，产物仍直传
`maiga512/shuxiamusic-release` 的 Release。公开仓库 Runner 不占用被扣款拦截的私有仓库 Actions。

公开仓库 Secrets：

- `SOURCE_REPO_TOKEN`：读取私有源码仓库。
- `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：更新包签名。
- `CERU_MPV_WINDOWS_URL`：Windows 内置便携 MPV 压缩包地址。

发布命令：

```bash
gh workflow run "Desktop Release Public" \
  -R maiga512/shuxiamusic-release \
  --ref main \
  -f version=1.1.4 \
  -f source_ref=desktop-v1.1.4 \
  -f release_notes="树夏Music 桌面版 v1.1.4"
```

`source_ref` 默认是 `main`，便于先验证源码；正式发布时显式传入 `desktop-vX.Y.Z` 标签，
确保构建内容与版本标签完全一致。未收到用户发布通知前，只准备版本、源码和命令，不创建标签、
不触发公开 Runner、不生成安装包。

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
- 安卓的 Gitee 仓库 `songsong2020/shuxiamusic-release` 目前是**私有**，若安卓也要从 Gitee
  自动更新，需另行将其设为公开（不属于本次桌面改动范围）。
