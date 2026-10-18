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
2. 升版本号：三处保持一致 —— `package.json` 的 `version`、`src-tauri/Cargo.toml` 的 `version`、
   `src-tauri/Cargo.lock` 里 `shuxia-tauri` 的 `version`（`tauri.conf.json` 的 `version` 继承自
   `package.json`）。
3. 触发构建：打标签 `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`（或手动
   Run workflow `Desktop Release`）。
4. **等两个工作流都绿**（总计约 40+ 分钟）：
   - 源码仓库 `Desktop Release`（约 21 分钟）——它的 publish 作业会在发布仓库创建同名
     `desktop-vX.Y.Z` 标签与 Release；
   - 发布仓库 `Desktop Release Public`（约 21 分钟）——被上一步创建的标签触发，用发布仓库的
     公开 Runner 重新构建一次，**总是最后写入**，GitHub 上最终生效的是它的产物。
   只等第一个就下载会把源码仓库那版传到 Gitee，导致同一提交在两端是两套不同字节的安装包。
5. 本机下载产物并平铺进工作目录的 `release-assets/`（安装包 + `.sig`，不含 `latest.json`），
   然后发布 Gitee：
   `scripts/ci/publish-gitee-local.sh /tmp/ceru-release/work X.Y.Z "<更新说明>"`。
   脚本会重建 `desktop-latest` 与版本化 `desktop-vX.Y.Z`，并调用 `update-hub-readme.py`
   把发布中心首页的版本号与安装包文件名改成新版本（GitHub + Gitee 两份 README）。
6. GitHub 侧的 `desktop-latest`、版本化 Release 与首页由 CI 完成，无需本机操作。

## 相关文件

- `src-tauri/tauri.conf.json` — 更新端点顺序 `[Gitee, GitHub]`
- `scripts/ci/make-latest-json.py` — 生成 GitHub + Gitee 两份清单
- `scripts/ci/publish-gitee.py` — 创建/更新 Gitee `desktop-latest` + 版本化 Release 并上传产物
- `scripts/ci/publish-gitee-local.sh` — 本机发布 Gitee 的入口（含首页版本同步）
- `scripts/ci/update-hub-readme.py` — 同步发布中心首页 README 的版本与安装包文件名
- `.github/workflows/desktop-release.yml` — 源码仓库发布工作流（负责触发 + GitHub 侧）
- `maiga512/shuxiamusic-release:.github/workflows/desktop-release-public.yml` — 公开 Runner 免额度构建工作流

## 注意事项

- Gitee 发布仓库必须保持**公开**，否则更新器匿名下载不到安装包。
- Gitee 桌面发布仓库的**总附件配额是 1GB**。旧版本累计会把版本化 Release 的 Windows 包顶掉；
  如遇 `文件大小已超出仓库附件配额`，DELETE 掉多余的旧版本化 Release 即可释放配额（不必再删
  `desktop-latest`）。
- **清理只删版本化附件**：`desktop-latest` 的清理逻辑（CI 侧与 `publish-gitee.py`）只删
  `shuxiamusic_*` 与 `latest.json`。桌面端插件 `feiniu-service.js` / `shuxia-sync-service.js`
  常驻在 `desktop-latest`、发布中心首页直接链过去下载，**不能删**；早期「一刀切清空」的实现
  把它们删了，首页那两条链接自 1.1.5 起 404（原件仍可在 `desktop-v1.1.4` 归档里找到）。
- **重复上传不再污染 Release**：Gitee 的 releases 列表接口不返回附件 id，早期 `publish-gitee.py`
  的「清旧附件」循环因此空转，`desktop-latest` 里越堆越多旧版本安装包，且旧的同名 `latest.json`
  会遮蔽新清单（更新器一直读到旧版本，用户收不到更新）。现在改为从附件下载地址的第一跳 302
  （`.../attach_files/<id>/download/<name>`）反查 `attach_file_id` 再精确删除，同名附件反复扫描
  直到删净，因此重复发布前**不需要**再手工删除整个 Release。Gitee 自动生成的源码包
  （`.zip`/`.tar.gz`）不是附件、删不掉，会被跳过，不影响更新器。
- Gitee 单文件附件也有体积上限；若桌面安装包超限会导致 Gitee 上传失败（此时自动回退 GitHub）。
- 改发布仓库的 `.github/workflows/*` 需要令牌带 `workflow` scope；`gh` CLI 的令牌通常没有，
  用 SSH 克隆 + 推送即可（SSH 不受该限制）。
- 安卓 APK 仍可从公开 Release 附件下载，但安卓源码不再放在发布中心仓库；
  发布中心仓库只保留 README、截图和必要工作流。
