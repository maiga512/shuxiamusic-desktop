# AGENTS.md - Ceru Tauri AI Entry Contract

This file is the mandatory entry point for AI agents and automated coding tools
working in this repository.

## Read First

Before searching, editing, or proposing a fix:

1. Read `AI_INDEX.md` for tags, task routing, aliases, and entry points.
2. Read `TOP_GRAPH.md` for the current architecture and cross-module flows.
3. Read `CONTEXT_HANDOFF.md` for project constraints and recent handoff state.
4. Use `graphify-out/GRAPH_REPORT.md` or `graphify query "<question>"` to locate
   exact symbols instead of scanning the whole repository.

Do not reconstruct the architecture from old screenshots, process lists, or
memory when the index and graph already answer the question.

## 三端一体：项目位置总览（每个 AI 必读，别再找错）

树夏Music（树夏音乐 / ShuxiaMusic）是一套「桌面端 + 移动/车机端 + 同步服务器」协同的系统，
三个仓库通过同一台 NAS 同步服务器共享歌单、收藏、播客、插件等数据。不要凭记忆猜路径，
需要跨端对照或改动时，按下表定位：

| 端 | 说明 | 绝对路径 |
| --- | --- | --- |
| **Mac / 桌面端**（本仓库） | 树夏Music 桌面版，Tauri 2 + Rust + Vue 3 | `/Users/songsong/Movies/树夏Music-Desk-tauri` |
| **安卓 / 车机端** | 树夏Music 移动与车机版，Kotlin + Jetpack Compose | `/Volumes/致钛 2T/shuxiamusic` |
| **同步服务器（NAS）** | 三端共用的云同步后端，Node 服务，`@ceru/nas-sync-server` | `/Users/songsong/Movies/树夏Music-Desk-tauri/nas-sync-server` |
| Electron 旧版（只读参考） | 迁移前的 Electron 实现，行为对照用，**禁止修改** | `/Volumes/致钛 2T/CeruMusic` |

改跨端行为（同步、收藏、歌单、播客、插件）时，Mac 与安卓两端要一起对齐，服务器契约以
`nas-sync-server` 为准。

## Project Boundary

- Active project: `/Users/songsong/Movies/树夏Music-Desk-tauri`（Mac 桌面端）
- Android / 车机端: `/Volumes/致钛 2T/shuxiamusic`
- 同步服务器 (NAS): `/Users/songsong/Movies/树夏Music-Desk-tauri/nas-sync-server`
- Read-only Electron reference: `/Volumes/致钛 2T/CeruMusic`
- Never modify the Electron reference project.
- Product behavior must follow the Electron implementation. Tauri-specific code
  may only adapt the shell, IPC, window, WebView, or platform boundary.

## Language Contract

- 默认使用中文回答用户，包括过程说明、最终总结、状态汇报和错误说明。
- 只有用户在当前请求中明确要求使用其他语言时，才改用该语言。
- 代码、日志、命令、文件名和第三方 API 名称可以保留英文；解释和结论必须使用中文。

## Mandatory Index Maintenance

Every change to code, configuration, routes, data flow, commands, or project
documentation must update the search index in the same work session.

After each meaningful change:

1. Update the affected tags or routing entries in `AI_INDEX.md`.
2. Run the Graphify update workflow from `docs/AI_GRAPH_MAINTENANCE.md`.
3. Regenerate `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, and
   `graphify-out/graph.html`.
4. Update `TOP_GRAPH.md` when any of these changed:
   - god nodes or important hub nodes;
   - community ownership or names;
   - cross-module data flow;
   - execution path;
   - playback, podcast, source, lyric, download, or persistence architecture.
5. Append a short dated entry to the maintenance log in `AI_INDEX.md`.
6. Report the index update in the final change summary.

A code edit is not complete while the graph and index describe the old system.

## Required Routing

Use the task routing table in `AI_INDEX.md` before opening files. Typical routes:

- Playback, source switching, song URL, next-track, podcast playback:
  read `TOP_GRAPH.md` section "Playback And Media".
- Download dialog, quality checks, download queue:
  read `TOP_GRAPH.md` section "Downloads".
- Desktop lyrics, lock, drag, multi-line resize:
  read `TOP_GRAPH.md` section "Desktop Lyrics".
- Discover, podcast, playlists, loading speed, cache:
  read `TOP_GRAPH.md` section "Network And Content".
- Memory, CPU, sidecar lifecycle, Rust process growth:
  read `TOP_GRAPH.md` section "Runtime And Cost".

## Graphify Rules

- Treat `AI_INDEX.md` as the human-readable tag index.
- Treat `graphify-out/graph.json` as the machine-readable graph.
- Treat `TOP_GRAPH.md` as the curated Top Graph for agents.
- Treat `graphify-out/GRAPH_REPORT.md` as the generated audit report.
- Keep generated files synchronized with `CONTEXT_HANDOFF.md`.
- Do not add Graphify as an application dependency.
- Do not semantically index the whole icon/image asset catalog unless the task
  specifically concerns those assets. Index their paths and ownership instead.

Detailed commands, verification, and failure recovery are in
`docs/AI_GRAPH_MAINTENANCE.md`.
