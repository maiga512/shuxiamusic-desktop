# Windows Packaging

目标：做出接近 Electron `build:win` 的“安装就能用”体验，而不是只在本机有 Node 时才能跑。

## 为什么以前不行

1. `node_sidecar.rs` 直接 `Command::new("node")`，打包后依赖系统 Node。
2. `sidecar/` 需要 `axios` / `iconv-lite`，这些不在系统全局模块里。
3. `tauri.conf.json` 只有 `targets: all`，没有明确的 NSIS / WebView2 安装策略。

## 现在的方案

- 打包前执行 `npm run sidecar:prepare-runtime`
  - 下载便携 Node（默认 `22.14.0`）
  - 复制 sidecar 运行时 npm 依赖到 `packaging/sidecar-runtime/node_modules`
- `tauri.conf.json` 把 `sidecar` + `sidecar-runtime` 打进 resources
- Rust 启动 sidecar 时优先用内置 Node，再回退系统 `node`
- 同时注入：
  - `CERU_APP_DATA_DIR`
  - `CERU_TAURI_APP_DATA_DIR`
  - `NODE_PATH`（指向打包进应用的 sidecar deps）
- Windows 安装器：
  - NSIS（中/英，可改目录，当前用户/整机可选）
  - WebView2 `embedBootstrapper`

## 在 Windows 上打包

推荐在 Windows x64 机器或 Windows CI runner 上执行：

```bash
npm ci
npm run tauri:build:windows
```

产物通常在：

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

也可只准备运行时：

```bash
npm run sidecar:prepare-runtime -- --platform win32 --arch x64
```

arm64：

```bash
npm run tauri:build:windows:arm64
```

## 在 macOS 上注意

macOS 可以准备 Windows 的 sidecar Node / deps，但真正编出 `.exe` / NSIS 仍建议在 Windows 上完成。跨编译 Windows 目标还要额外装 Windows 工具链，不作为默认路径。

## 安装后冒烟

1. 安装 NSIS 包，不预装系统 Node。
2. 启动应用，确认不会弹黑框 console。
3. 搜歌 / 切歌 / 插件列表能通（sidecar health）。
4. 桌面歌词、状态栏歌词等 macOS 专有能力在 Windows 上可降级，不影响主播放链路。

## 相关文件

- `scripts/prepare-sidecar-runtime.mjs`
- `packaging/sidecar-runtime/`
- `src-tauri/tauri.conf.json`
- `src-tauri/src/commands/node_sidecar.rs`
- `.github/workflows/windows-build.yml`
