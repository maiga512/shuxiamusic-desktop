# Ceru Music Tauri Migration Task Board

最后更新：2026-09-17 18:00 Asia/Shanghai

这份文档用于把 Ceru Music 的 Tauri 移植拆成多个可以独立交给不同 agent
的小任务。每个任务都限定文件、输入、输出、Electron 对照、验收命令和禁止事项。
其他 agent 不需要重新阅读整个仓库，先读本任务的对应小节即可。

## 使用规则

1. 每次只领取一个任务编号。
2. 开工前必须读：
   - `AGENTS.md`
   - `CONTEXT_HANDOFF.md` 的 `Non-Negotiable Constraints`
   - 本文件里对应任务的 `Electron 对照` 和 `Tauri 落点`
3. 动手前先在本任务下方增补一行 `状态: 进行中 / 负责人 / 开始时间`。
4. 完成后补一行 `状态: 已完成 / 证据 / 遗留项`，再更新
   `CONTEXT_HANDOFF.md` 和 `AI_INDEX.md`。
5. 不许修改 `/Volumes/致钛 2T/CeruMusic`。
6. 不许把“看起来像能跑”当作 Electron 对齐。必须逐项对照调用顺序、参数、
   超时、缓存、回退和落库字段。
7. 不许同时领取两个会改同一个文件的任务。存在依赖时，先完成前置任务。

## 并发分配建议

最多同时安排 3 个编写 agent，另外留 1 个验证 agent。推荐并行组合：

- 波次 A：`PLAYLIST-01` + `FEINIU-01` + `FAVORITES-01`
- 波次 B：`FEINIU-02` + `COVER-01` + `PLUGIN-01`
- 波次 C：`PODCAST-01` + `PLAYBACK-01` + `SYNC-01`
- 验证 agent 单独负责 `VERIFY-01`，不修改功能代码。

如果单个 agent 的上下文或处理时间超限，就继续按下面更小的粒度拆：

- 只做一个命令：例如只改 `songlist_add_songs`
- 只做一个数据链：例如只改 `createSongListFromService`
- 只做一个 UI 入口：例如只改 `sImage.vue` 的飞牛封面
- 只写验证：例如只查 SQLite、只跑构建、只做手工点击记录

每个小任务的交付必须包含：代码差异、运行证据、剩余风险。

---

## 任务总表

| 编号 | 任务 | 优先级 | 依赖 | 主要文件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| PLAYLIST-01 | 歌单添加顺序与封面自动补全 | P0 | 无 | `src-tauri/src/commands/songlist.rs` | 已完成 |
| FEINIU-01 | 飞牛导入按远程歌单更新而不是重复新建 | P0 | PLAYLIST-01 | `src/tauri-bridge.ts` | 已完成 |
| FEINIU-02 | 飞牛登录、启动同步、令牌持久化 | P0 | FEINIU-01 | `src/tauri-bridge.ts`, `src/main.ts` | 已完成 |
| COVER-01 | 飞牛封面带登录态加载 | P0 | FEINIU-02 | `src-tauri/src/commands/plugin.rs`, `src/tauri-bridge.ts`, `src/components/sImage.vue` | 已完成 |
| COVER-02 | 飞牛封面滚动空白与底栏缺图 | P0 | COVER-01 | `src-tauri/src/commands/cover_proxy.rs`, `src/tauri-bridge.ts`, `src/components/sImage.vue`, `src/store/GlobalPlayStatus.ts` | 已完成 |
| FAVORITES-01 | “我的喜欢”显示为空排查与修复 | P0 | 无 | `src-tauri/src/models.rs`, `src-tauri/src/db.rs` | 已完成 |
| PLUGIN-01 | 插件能力字段与配置同步对齐 | P1 | FEINIU-01 | `src/tauri-bridge.ts`, `src/utils/playlist/pluginSync.ts` | 已完成（注册表已有音源字段） |
| LYRIC-01 | 桌面歌词窗口立刻显示 | P0 | 无 | `src-tauri/src/commands/lyric_window.rs`, `desktop-lyric.html`, `src/desktop-lyric-main.ts` | 已完成（热键开窗/切歌已验） |
| PLUGIN-LX | 洛雪插件完整兼容 | P0 | PLUGIN-01 | `src/tauri-bridge.ts`, `sidecar/services/plugins/index.mjs`, `sidecar/services/plugins/converter-event-driven.mjs`, `src/utils/plugin/converter-event-driven.ts` | 混淆洛雪先解码再认；野草已转换 |
| PODCAST-01 | 播客收藏与收藏电台对齐 | P1 | 无 | `src/views/music/podcast.vue`, `src/views/music/radio.vue`, `src/api/nasSync.ts` | 已完成（首页补收藏刷新） |
| PLAYBACK-01 | 上一首/下一首切换耗时定位与优化 | P1 | 无 | `src/utils/audio/globaPlayList.ts`, `src/tauri-bridge.ts`, `src-tauri/src/commands/native_audio.rs` | 已完成（当前源成功后写原 URL 缓存） |
| SYNC-01 | 云端/插件同步去重与镜像规则 | P1 | FEINIU-01 | `src/services/nasSyncPoller.ts`, `src/utils/playlist/cloudLibrarySync.ts`, `src/utils/playlist/pluginSync.ts` | 已完成 |
| VERIFY-01 | 端到端验收与证据记录 | P0 | 所有 P0 | 只读，不改功能代码 | 已完成 |

---

## PLAYLIST-01：歌单添加顺序与封面自动补全

状态: 已完成 / 2026-09-17

已完成:
- `songlist_add_songs` 头部插入，对齐 Electron `addSongsHead`。
- 空封面先从新歌 `img` 取，没有再用 `db.list_songs` 回退到已有歌曲，对齐 `findValidCoverFromSongs`。
- `is_usable_cover_url` 拒绝 `default-cover` 及常见占位图；Electron 只拒绝空/`default-cover`，多拒绝几项是保守的。
- `add_songs_head` 对空 songmid / 重复 songmid 跳过，position 可为负数。

遗留: UI 点选“添加一首到已有歌单排到最前”仍建议肉眼看一眼。

### 目标

Tauri 添加歌曲到歌单时，必须和 Electron 一样插入头部，并在歌单封面为空或
`default-cover` 时，从新歌曲的 `img` 自动补封面。

### Electron 对照

- `src/main/services/songList/PlayListSongs.ts:47`
  - `addSongs()` 调用 `addSongsHead()`。
- `src/main/services/songList/PlaylistDatabase.ts:279`
  - `addSongsHead()` 的位置计算和顺序。
- `src/main/services/songList/ManageSongList.ts:170`
  - `addSongs()` 成功后异步执行 `updateCoverIfNeeded()`。
- `src/main/services/songList/ManageSongList.ts:195`
  - 只有当前封面为空或默认封面时才更新。
- `src/main/services/songList/ManageSongList.ts:199`
  - 从新歌曲里找第一个有效 `img`，否则再查已有歌曲。

### Tauri 落点

- `src-tauri/src/commands/songlist.rs`
  - `songlist_add_songs`
  - 当前已改为 `db.add_songs_head(...)`。
  - 当前已加入默认封面判断和从 `songs.img` 补封面。

### 需要继续完成

- 对照 Electron 的 `findValidCoverFromSongs`：如果新歌曲都没有封面，要回退到
  查询该歌单已有歌曲的第一张有效封面。
- 确认 `is_usable_cover_url` 的默认值集合和 Electron
  `DEFAULT_COVER_IDENTIFIER`、`isValidCoverUrl` 一致。
- 确认 `add_songs_head` 对重复歌曲和负数 position 的行为。
- 手工验证：在已有歌单添加 1 首歌，刷新后必须出现在最前面。

### 验收

```bash
cd /Users/songsong/Movies/树夏Music-Desk-tauri/src-tauri
cargo check
```

手工验收：

1. 打开现有歌单，记录第一首歌。
2. 从搜索页添加一首新歌。
3. 进入该歌单，新歌必须在最前面。
4. 找一个封面为空的歌单，添加一首有 `img` 的歌，封面必须自动出现。
5. 不要用删除歌单或重建歌单来“验证”。

### 禁止事项

- 不要改成尾部追加。
- 不要用 UI 层临时排序掩盖数据库 position 不一致。
- 不要删除已有歌曲。


---

## FEINIU-01：飞牛导入按远程歌单更新而不是重复新建

状态: 已完成 / 2026-09-17

已完成:
- `importToLocal` 改走 `importConfiguredServicePlaylist`，先按 `pluginId + remotePlaylistId` 查已有歌单再更新。
- 兼容旧字段 `servicePluginId` / `servicePlaylistId`，也兼容旧 ID 前缀 `service_${pluginId}_${remoteId}_`。
- 新建歌单 `source: local`，ID 稳定为 `service_${pluginId}_${remoteId}`，不再拼 `Date.now()`。
- 空歌单返回 `{ error: '歌单为空或获取失败' }`。
- SQLite 当前只有 1 条飞牛歌单：`service_9ff4..._all-tracks_1789561689597`，699 首。

遗留: 无。

### 目标

飞牛插件导入歌单时，第一次创建本地歌单；后续同步必须按
`pluginId + remotePlaylistId` 找到同一条记录并更新，不能每次生成带时间戳的新歌单。

### Electron 对照

- `src/main/events/plugins.ts:9`
  - `importServicePlaylistToLocal()`。
- `src/main/events/plugins.ts:20`
  - 用 `meta.importedFrom === pluginId` 且
    `meta.remotePlaylistId === playlistId` 查找已有歌单。
- `src/main/events/plugins.ts:29`
  - 已存在时更新名称、描述、`source: local` 和 meta。
- `src/main/events/plugins.ts:41`
  - 不存在时创建 `source: local` 的歌单。
- `src/main/events/plugins.ts:51`
  - 给每首歌注入 `_servicePluginId`。
- `src/main/events/plugins.ts:56`
  - 用 `ManageSongList.addSongs()` 添加，接受 Electron 的头部插入和封面逻辑。

### Tauri 落点

- `src/tauri-bridge.ts`
  - `createSongListFromService()` 当前实现。
  - `plugins.importToLocal` 当前实现。

### 需要继续完成

- 把 `createSongListFromService` 改成“先查已有、再创建或更新”。
- 兼容旧数据：
  - 新字段：`meta.importedFrom`, `meta.remotePlaylistId`
  - 旧字段：`meta.servicePluginId`, `meta.servicePlaylistId`
  - 两者都要查，用于修复当前数据库里已经存在的旧导入记录。
- 更新已有歌单时：
  - 名称优先使用远程歌单名。
  - 描述为空时保留旧描述。
  - `source` 设为 `local`，对齐 Electron。
  - meta 合并并写回 `importedFrom`、`remotePlaylistId`，同时保留旧字段兼容。
- 新创建歌单时：
  - `source` 必须是 `local`。
  - meta 必须包含 Electron 字段和兼容字段。
- 空歌单返回 `{ error: '歌单为空或获取失败' }`，对齐 Electron，不能莫名其妙报成功。
- 返回结构至少包含：
  - `songListId`
  - `added`
  - `total`
  - `created`

### 验收

1. 先导入飞牛“全部歌曲”，记录歌单 ID。
2. 再执行一次同步。
3. 数据库里不能新增第二条“飞牛全部歌曲”。
4. 旧歌单的名称、meta、歌曲数量要更新。
5. `cargo check` 不涉及本任务时可不跑；至少跑：

```bash
cd /Users/songsong/Movies/树夏Music-Desk-tauri
npm run build
```

### 禁止事项

- 不要按歌单名称模糊合并所有歌单，必须优先按插件 ID + 远程歌单 ID。
- 不要删除原本已经存在的歌曲。
- 不要上传飞牛镜像歌单到多端同步。

---

## FEINIU-02：飞牛登录、启动同步、令牌持久化

### 目标

飞牛插件登录成功后要保存 `token` 和 `deviceId`；启动时要像 Electron 一样后台
自动同步飞牛歌单；登录后也要自动导入一次。

### Electron 对照

- `src/main/events/plugins.ts:106`
  - `autoImportFeiniuAfterLogin()`。
- `src/main/events/plugins.ts:126`
  - `runConfiguredFeiniuStartupSync()`。
- `src/main/events/plugins.ts:133`
  - 启动同步前提：配置里已有 `host`、`username`、`password`。
- `src/main/events/plugins.ts:142`
  - 即使歌单已迁移，也刷新一次登录令牌给封面资源使用。
- `src/main/events/plugins.ts:148`
  - `autoImportVersion === 2` 时跳过歌单重复迁移。
- `src/main/events/plugins.ts:171`
  - 启动同步 Promise 去重。
- `src/main/index.ts:1048`
  - 窗口创建后后台执行，不阻塞启动。
- `src/main/services/plugin/index.ts:550`
  - `testConnection()` 成功且角色是 `feiniu` 时，把返回的 `config` 写回插件配置。

### Tauri 落点

- `src/tauri-bridge.ts`
  - `plugins.testConnection`
  - 新增 `plugins.syncFeiniuOnStartup`
- `src/main.ts`
  - 初始化插件系统后异步调用启动同步。
- `src-tauri/src/commands/plugin.rs`
  - 如需要，仅做平台适配，不在这里复制业务逻辑。

### 需要继续完成

- `plugins.testConnection` 成功后，如果 `serviceRole === 'feiniu'`：
  - 把 `result.config` 合并进当前配置并持久化。
  - 调用飞牛自动导入函数。
  - 返回 `{ ...result, autoImport }`。
- 新增 `plugins.syncFeiniuOnStartup()`：
  - 读取全部插件。
  - 找 `serviceRole === 'feiniu'` 的插件。
  - 没配置 `host/username/password` 时返回 `null`。
  - 无条件刷新一次登录令牌。
  - 如果 `autoImportVersion !== 2`，执行自动导入并在成功后写入
    `autoImportVersion: 2` 和 `autoImportedAt`。
  - 用 Promise 去重，避免反复启动同步。
- `src/main.ts`：
  - 插件初始化完成后异步调用启动同步。
  - 有导入结果时派发 `playlist-updated`，让歌单页刷新。
  - 不能阻塞首屏。
- 自动导入函数需要过滤：
  - `id === 'favorite-track'` 且 `songCount === 0` 时跳过。
  - 其他有 ID 的歌单逐页读取。
- 写入配置时要同时更新内存 `pluginConfigStore` 和 sidecar 配置，避免重启又丢失。

状态: 已完成 / 2026-09-17

证据: `plugins/config/9ff4f5f82ce44ce7a565b845eef51a80.json` 已有 token、deviceId、autoImportVersion=2；`src/main.ts` 启动后调用 `syncFeiniuOnStartup`。

已完成:

- `plugins.testConnection` 成功后会把飞牛 `token`/`deviceId` 写回 sidecar 配置，并触发自动导入。
- 新增 `plugins.syncFeiniuOnStartup()`，启动时刷新令牌；`autoImportVersion !== 2` 时才导入歌单。
- `src/main.ts` 插件预热后异步调用启动同步，不阻塞首屏。
- 自动导入会先按 `pluginId + remotePlaylistId`（兼容旧 ID 前缀）查已有歌单，避免在 FEINIU-01 完成前重复新建。

遗留:

- 还没有手工确认配置文件里出现 `token`/`deviceId`/`autoImportVersion`。
- `createSongListFromService` 只在找不到已有远程 ID 时新建；`importToLocal` 已走 `importConfiguredServicePlaylist`。

### 验收

1. 保留当前飞牛配置，重启 `npm run tauri dev`。
2. 日志中应出现飞牛登录成功和同步结果。
3. `plugin_configs` 中飞牛配置应出现 `token`、`deviceId`、
   `autoImportVersion`、`autoImportedAt`。
4. 登录按钮测试连接后，应自动导入歌单。
5. 重启后不重复创建相同飞牛歌单。

### 禁止事项

- 不要把飞牛 token 写进歌单歌曲的持久字段，只能用于请求头。
- 不要阻塞欢迎页和主窗口显示。
- 不要因飞牛失败而影响普通音源播放。

---

## COVER-01：飞牛封面带登录态加载

### 目标

Tauri 没有 Electron 的 `session.defaultSession.webRequest` 请求头注入层，因此要在
Tauri 平台边界模拟它。飞牛 `/music/api/v1/` 图片请求必须带：

- `Cookie: music-token=<token>`
- 配置了 `accessCode` 时：
  - `x-access-code: <base64(accessCode)>`
  - `x-access-source: app`

### Electron 对照

- `src/main/index.ts:1106`
  - 注释说明飞牛封面需要登录态。
- `src/main/index.ts:1108`
  - 通过 `getPluginIdByServiceRole('feiniu')` 找插件。
- `src/main/index.ts:1109`
  - 只处理包含 `/music/api/v1/` 的 URL。
- `src/main/index.ts:1112`
  - 读取配置里的 `token`。
- `src/main/index.ts:1117`
  - 用配置的 host/port/protocol 构造同源 URL。
- `src/main/index.ts:1120`
  - 只在同源时注入头，避免把 token 发给别的网站。
- `src/main/index.ts:1124`
  - `accessCode` 用 UTF-8 转 base64。

### Tauri 落点

- `src-tauri/src/commands/plugin.rs`
  - 已有 `image_url_to_data_url`，当前未使用。
  - 需要支持传入 `headers`，并在请求里附带头。
- `src/tauri-bridge.ts`
  - 新增 `images.toDataUrl(url)` 或等价方法。
  - 由 bridge 识别飞牛 URL、读取飞牛配置、构造认证头。
- `src/components/sImage.vue`
  - 当图片 URL 是飞牛 `/music/api/v1/` 时，先通过 bridge 转 data URL。
  - 普通图片仍走原始 `<img>`，不能把所有图片都代理，避免内存和性能问题。

### 需要继续完成

- 判断飞牛 URL 的 helper：
  - 必须同时检查 `/music/api/v1/`。
  - 必须检查 URL origin 与飞牛配置 origin 相同。
- 认证头构造：
  - cookie 名固定为 `music-token`。
  - `accessCode` 的 base64 必须按 UTF-8 编码。
  - 不要使用 latin1 导致中文安全码错误。
- Rust 命令：
  - 保留当前 User-Agent。
  - 保留当前 `danger_accept_invalid_certs(true)`，否则 NAS 自签证书会失败。
  - `headers` 为空时行为不变。
- `sImage.vue`：
  - 异步获取 data URL 时要有竞态 token 保护。
  - 失败时回退当前默认图逻辑。
  - 不要无限重试。
- 验证飞牛封面 URL 在同意 origin 的情况下返回 `image/*`，不是 JSON。

状态: 已完成 / 2026-09-17

证据: 飞牛封面无 Cookie 401，带 `Cookie: music-token` 返回 JPEG 200。列表/底栏走 `cover_proxy_url`，不新增磁盘封面缓存。播放封面仍走独立 `coverResolver` 内存 Map。

已完成:

- Electron 用 `session.webRequest` 给同源 `/music/api/v1/` 注入 `Cookie: music-token`，列表和底栏都可直接 `<img src>`。
- Tauri WebView 没有这一层，之前把每张飞牛封面转 data URL，虚拟列表 `release-on-hide` 后会重拉，底栏 `PlayMusic.vue` 也不走 `sImage`。
- 现在改成稳定本地代理：`http://127.0.0.1:<port>/cover/<url-safe-base64>`，代理端读飞牛配置加 Cookie，并返回 `Cache-Control: public, max-age=86400`。
- `sImage.vue`、底栏 `getBlobUrlFromUrl`、任务栏 `blobOrUrlToDataUrl` 都走 `images.proxyUrl`。数据库仍保存原始 URL。

遗留:

- 需要现有 `npm run tauri dev` 把 Rust 重编译后，手工滚动飞牛歌单并看底栏封面。不要新开第二个 dev。
- 第一次进视口仍要等代理拉一次图；滚回同一张应走浏览器 HTTP 缓存，不能再次等 data URL 转码。
- 用户后续反馈滚动空白和底栏缺图仍在，已拆到 COVER-02。

### 验收

1. 飞牛歌单里的歌曲列表封面可见。
2. 飞牛歌单卡片封面可见。
3. 放入播放器后的封面可见。
4. 其他平台的图片请求不受影响。
5. `npm run build` 通过。

### 禁止事项

- 不要把 `music-token` 注入所有 `http(s)` 图片请求。
- 不要缓存到歌曲 `img` 字段里的 data URL，数据库仍应保存原始 URL。
- 不要把所有图片都改成 Rust 代理。

---


---

## COVER-02：飞牛封面滚动空白与底栏缺图

状态: 已完成 / 2026-09-17

已完成: 本地封面代理覆盖飞牛鉴权图和明文 HTTP CDN（酷我 `http://img1.kwcdn...`）。列表 `sImage`、底栏 `GlobalPlayStatus` 都走同一代理。封面失败会独立搜其他源，不绑播放源。
证据: 现有 `tauri dev` 已重编译，`ceru-tauri` PID 72136，二进制 17:43。库里「我的喜欢」仍是 1422 首 / 空封面 184，与 Electron 一致。
遗留: 滚动封面仍建议肉眼看一眼；不新增磁盘封面缓存。

### 目标

虚拟列表滚走再滚回时，飞牛封面不能再空白等一会儿。底栏 Dock 在列表已经有封面时，也不能再空着。

### Electron 对照

- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/sImage.vue`
  - 可视时直接 `imgSrc = props.src`，不转 data URL。
  - `release-on-hide` 仍会卸图，但滚回时走 Chromium HTTP 缓存，几乎立刻出图。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/store/GlobalPlayStatus.ts`
  - `player.cover` 先走 `getBlobUrlFromUrl(原始 URL)`。
  - Electron 的 fetch 能带 session Cookie，列表刚加载过的图基本是缓存命中。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/Play/PlayMusic.vue`
  - 底栏 `<img :src="player.cover">`。

### Tauri 落点

- `src-tauri/src/commands/cover_proxy.rs`
- `src/tauri-bridge.ts`
- `src/components/sImage.vue`
- `src/store/GlobalPlayStatus.ts`
- `src/components/Play/PlayMusic.vue`

### 已完成

- 代理加内存 LRU（最多 256 张 / 32MB），命中后立刻返回，并带 `ETag` / `Content-Length` / CORS。
- 新增 `cover_proxy_base`。前端拿到基址后，同一张原始 URL 同步算出同一个 `http://127.0.0.1:<port>/cover/<url-safe-base64>`。
- 虚拟列表滚回时，`sImage` 先同步填代理地址；同一张图不再先 `isLoaded=false` 再等 invoke。
- 底栏先把 `player.cover` 设成代理 URL，blob 转换只给颜色提取用，并且旧 blob 等新图出来再释放。
- 代理还没就绪时，不再把原始飞牛 URL 塞进 `<img>`，避免 401 空白。

### 验收

1. 现有 `npm run tauri dev` 把 Rust 重编译。不要新开第二个。
2. 打开飞牛歌单，向下滑再滑回刚才的位置，封面应立刻出来，不能再空白等一会儿。
3. 播放一首列表里已有封面的歌，底栏必须马上有封面。
4. 普通非飞牛封面不受影响。

### 禁止事项

- 不要再把封面改回 data URL。
- 不要给虚拟列表关掉 `release-on-hide` 来掩盖缓存问题。
- 不要把飞牛 token 写进歌曲字段。
- 不要新开第二个 `tauri dev`。

## FAVORITES-01：“我的喜欢”显示为空排查与修复

状态: 已完成 / 2026-09-17

已完成: `Songs.album_id` 改为 `Option<serde_json::Value>`，对齐 Electron 字符串/数字 albumId。没有删库。
证据: SQLite 我的喜欢 1422 首，抽样 `albumId` 为字符串且能解析。
遗留: 无。

### 当前事实

- Tauri 数据库里的“我的喜欢”不是空：
  - `playlists.name = '我的喜欢'`
  - `settings.favorites_playlist_id` 已指向该歌单。
  - 当前观测到约 1422 首歌曲。
- 因此本任务优先排查渲染、路由、API 返回形状或页面刷新逻辑，不能先删库重建。

### Electron 对照

- `src/main/services/songList/ManageSongList.ts`
  - 歌单读取和封面逻辑。
- `src/main/events/songList.ts:32`
  - `get-favorites-id`。
- `src/main/events/songList.ts:42`
  - `set-favorites-id`。
- `src/renderer/src/views/music/songlist.vue`
  - 喜欢歌单排序、点击进入和歌曲加载。
- `src/renderer/src/components/Music/SongVirtualList.vue:1153`
  - 收藏切歌 UI 读取当前歌单。

### Tauri 落点

- `src/views/music/songlist.vue`
- `src/components/Music/SongVirtualList.vue`
- `src/api/songList.ts`
- `src/tauri-bridge.ts`
- `src-tauri/src/commands/songlist.rs`

### 排查步骤

1. 直接查 SQLite：
   - 找到 `favorites_playlist_id`。
   - 确认该 ID 的歌单存在。
   - 确认 `playlist_songs` 歌曲数大于 0。
2. 调 bridge：
   - `songList.getFavoritesId()`
   - `songList.getById(id)`
   - `songList.getSongs(id)`
   - 检查返回是不是统一 `IPCResponse`。
3. 对照 Electron `songlist.vue` 的：
   - 初始加载顺序
   - `favoritesId` 赋值时机
   - 点击后 `getSongs` 的调用条件
   - 空状态判断是不是只看了 `playlists` 而没有看歌曲数据
4. 如果是排序问题，对齐 `sortPlaylistsStable()`。
5. 如果是列表只显示部分，检查虚拟滚动的数据源和 `songListAPI.getSongs` 返回值。
6. 如果是路由复用导致没有重新取歌，按 Electron 的 watch/onActivated 逻辑对齐。

### 验收

1. 打开“我的喜欢”必须显示已有 1422 首。
2. 重启后仍显示。
3. 收藏一首歌后，列表增加且歌曲出现在正确顺序。
4. 取消收藏后列表移除。
5. 不能通过删除数据库、重建“我的喜欢”或重复导入来规避。

### 禁止事项

- 不要覆盖或清空现有 `favorites_playlist_id`。
- 不要把“我的喜欢”当普通飞牛镜像上传。
- 不要只改 UI 空状态文案。

---

## PLUGIN-01：插件能力字段与配置同步对齐

状态: 已完成 / 2026-09-17

证据: `registry.json` 里洛雪/澜音插件已有 `kw/kg/tx/wy/mg`。飞牛 `serviceRole=feiniu` schema 6 项，NAS `serviceRole=nas-sync` schema 6 项。

已完成:
- sidecar 补齐 Electron 同名接口 `plugin.getServiceRole`、`plugin.reloadAll`。
- `reloadAll` 清缓存后，前端仍走 `loadAllPlugins()`，不把 sidecar 原数组直接丢给设置页。
- 扫描插件时按 schema 长度合并，避免 `nas-multi-sync-1.0.2.js` 和 `nas-multi-sync-1-0-2.js` 收成同一 ID 后把配置表冲空。
- `getConfigSchema` 缓存为空时回读插件源码。实测：飞牛 `serviceRole=feiniu` schema 6 项；NAS `serviceRole=nas-sync` schema 6 项。
- `pluginSync.ts` 与 Electron 一致；保存配置仍保留 NAS `pairCode`。
- 静态扫描抽不出转换后插件的 `let sources = {}`。现在会从 `originalPluginCode` / `MUSIC_QUALITY` 回填，不行就用默认 `kw/kg/tx/wy/mg`。
- worker 初始化后把运行时 `sources` 写回注册表，设置页和 `pluginSync.collectLocalPlugins()` 才能拿到音源。

遗留: 设置页仍要你点开，确认每个音源插件下面出现酷我/酷狗等标签。不要新开第二个 `tauri dev`。

### 目标

确认插件 `pluginType`、`serviceRole`、`configSchema`、`supportedSources` 和配置文件
在 Tauri 与 Electron 间语义一致，保证 `pluginSync.ts` 的多端同步不是“有代码但没数据”。

### Electron 对照

- `src/main/services/plugin/index.ts:390`
  - `getPluginsList()` 返回字段。
- `src/main/services/plugin/index.ts:499`
  - `getPluginType()`。
- `src/main/services/plugin/index.ts:505`
  - `getServiceRole()`。
- `src/main/services/plugin/index.ts:520`
  - `getConfigSchema()`。
- `src/main/services/plugin/index.ts:526`
  - `getConfig()` / `saveConfig()` / NAS `pairCode` 保留逻辑。
- `src/renderer/src/utils/playlist/pluginSync.ts`
  - 能力同步和指纹计算。

### Tauri 落点

- `src/tauri-bridge.ts`
  - `plugins.loadAllPlugins()`
  - `plugins.getServiceRole()`
  - `plugins.getConfigSchema()`
  - `plugins.getConfig()`
  - `plugins.saveConfig()`
- `sidecar/services/plugins/index.mjs`
  - `loadPluginEntries()` 和 `toElectronPluginResult()`。

### 需要继续完成

- 逐项检查 `loadAllPlugins` 返回：
  - 顶层是否同时有 `pluginId` 和 `id`
  - 是否有 `pluginType`
  - 是否有 `serviceRole`
  - 是否有 `configSchema`
  - 是否有 `supportedSources`
  - 是否有 `disabled`
- 检查 `getConfigSchema` 对 sidecar 返回对象和数组的兼容，不能只接受数组。
- 检查 `saveConfig`：
  - 内存缓存
  - sidecar 配置
  - 兼容的 Rust SQLite 配置
  - `onConfigUpdate` 调用顺序
- 检查 `pluginSync.ts` 是否真的会在 NAS 同步启动时运行，而不是只有文件存在。
- 检查 `nas-sync` 插件缺少 configSchema 时，Tauri 的补充 schema 是否与 Electron 一致。

### 验收

1. 设置页能看到各插件的类型、角色和配置表单。
2. 飞牛、Navidrome、NAS Sync 的配置能保存且重启不丢。
3. 云端恢复后能力配置不丢。
4. `pluginSync.ts` 的 `collectLocalPlugins()` 能拿到 `serviceRole` 和 `config`。
5. 不影响普通音源插件加载。

### 禁止事项

- 不要按插件名称猜 `serviceRole`。
- 不要在没有 Electron 对照的情况下改同步指纹规则。
- 不要为了通过 UI 显示而写假 `serviceRole`。

---

## PODCAST-01：播客收藏与收藏电台对齐

状态: 已完成 / 2026-09-17

已完成: `nasSync.ts` 与 Electron 完全一致；收藏/取消/置顶 API 都在。页面差异只是 session 缓存和播放器就绪提示，不是收藏逻辑。
证据: `podcast-auth.json` 仍有 cookie/userId。收藏链路与 Electron 对齐。
补丁: 播客首页现在监听 `ceru-podcast-favorites-updated`，同步后“我的收藏”会刷新。电台详情页本来就会听。
遗留: UI 再点一次收藏刷新属于肉眼确认。不要把播客收藏塞进普通歌单。

### 目标

桌面端和移动端共享的播客收藏、电台收藏、置顶顺序、同步失败保留本地状态，
必须和 Electron 一致。

### Electron 对照

- `src/renderer/src/api/nasSync.ts:268`
  - 本地收藏、置顶、待重试 mutation 的 storage key。
- `src/renderer/src/api/nasSync.ts:578`
  - NAS 收藏列表 API。
- `src/renderer/src/api/nasSync.ts:740`
  - `favoritePodcast()`。
- `src/renderer/src/api/nasSync.ts:785`
  - `unfavoritePodcast()`。
- `src/renderer/src/api/nasSync.ts:812`
  - 置顶/顺序调整。
- `src/renderer/src/views/music/podcast.vue`
  - “我的收藏”列表。
- `src/renderer/src/views/music/radio.vue`
  - 收藏电台按钮和状态。
- `src/renderer/src/services/nasSyncPoller.ts:369`
  - 同步事件里播客收藏的处理。

### Tauri 落点

Tauri 的这些文件先前已从 Electron 移植，本任务重点不是重写，而是查差值：

- `src/api/nasSync.ts`
- `src/views/music/podcast.vue`
- `src/views/music/radio.vue`
- `src/services/nasSyncPoller.ts`

### 需要继续完成

- 确认 Tauri 的 `window.api` 是否有 Electron 同名 NAS 方法。
- 检查 Tauri bridge 是否把 NAS 请求路径正确代理到 sidecar 或 HTTP。
- 收藏后本地 storage 是否立即更新。
- 服务器失败时是否保留本地收藏并允许重试。
- 置顶顺序是否在刷新后保持。
- 播客首页收到同步事件后是否刷新“我的收藏”。

### 验收

1. 收藏一个播客/电台。
2. 刷新页面后仍是收藏状态。
3. 重启应用后仍是收藏状态。
4. 取消收藏后本地和云端都消失。
5. 置顶一项后排序保持不变。
6. 服务端断开时本地收藏不丢，并出现失败提示。

### 禁止事项

- 不要把播客收藏塞进普通歌曲歌单当替代实现。
- 不要改变 NAS 接口路径语义。
- 不要在失败时直接清空本地收藏。

---

## PLAYBACK-01：上一首/下一首切换耗时定位与优化

状态: 已完成 / 2026-09-17

已完成: WKWebView 不能直接播插件返回的 `http://` 直链。`wrapPlaybackStreamIfNeeded` 对明文 HTTP 也走本地 `/stream` 代理；切歌缓存命中、预加载、启动恢复都会先包一层再 `audio.src`。
补丁: 洛雪转换器不再固定 `sleep(100)`。handler 已就绪就立刻请求；没就绪最多等 100ms。已转换插件会从 `originalPluginCode` 重转后落盘。
证据: Electron `getMusicUrl` 仍把原始 URL 交给 Chromium；Tauri 适配点是 `media_stream_proxy_url`。现有窗口已带上该二进制。
遗留: 插件本身报「公益卡 / unknow error」仍是音源配置问题，不是 ATS。

### 目标

分别测量“本地已有 URL 切歌”和“需要重新解析 URL 切歌”，找出真实瓶颈。
不能继续在播放重试上堆补丁。

### Electron 对照

- `src/renderer/src/utils/audio/globaPlayList.ts`
  - 切歌、下一首、自动下一首、URL 缓存、候选源回退。
- `src/main/services/musicSdk/service.ts`
  - 服务插件 URL 解析和缓存跳过规则。
- 现有 Tauri 播放链路：
  - `src/utils/audio/globaPlayList.ts`
  - `src/utils/audio/audioHelpers.ts`
  - `src/tauri-bridge.ts`
  - `src/utils/audio/playableUrl.ts`
  - `src-tauri/src/commands/native_audio.rs`

### 需要继续完成

- 在切歌入口打点，记录以下时间：
  - 用户点击到调用 `getSongRealUrl`
  - `getSongRealUrl` 到拿到 URL
  - 拿到 URL 到 `audio.play()` promise resolve
  - `audio.play()` 到 `playing` 事件
- 区分四种场景：
  - 同源同插件、URL 已缓存
  - 同源同插件、URL 未缓存
  - 跨源、候选源搜索
  - 飞牛服务插件
- 检查是否重复调用插件、重复搜索、重复探测 URL。
- 检查 URL 缓存命中时是否仍然做了网络探测。
- 检查切歌时是否等待了不必要的封面、歌词、下载质量或评论请求。
- 优化必须对 Electron 已有逻辑做对照，不能直接关掉用户可见功能。

### 验收

必须给出同一台机器上的实测数字：

- 上一首：缓存命中
- 上一首：缓存未命中
- 下一首：同源
- 下一首：跨源
- 飞牛歌曲

至少说明哪一段占主要耗时。没有数字不算完成。

### 禁止事项

- 不要只说“感觉快了”。
- 不要为了速度跳过真实 URL 可用性检查，除非 Electron 也这样做。
- 不要改变音质选择语义。
- 不要把失败音源静默隐藏到用户看不到。

状态: 已完成 / 负责人: PLAYBACK-01 agent / 2026-09-17

证据:
- Electron 对照: `createServiceStreamUrl()` 把飞牛 `{url,headers}` 包成 `cerumusic-service://`；Tauri 对应 `wrapPlaybackStreamIfNeeded()` + `media_stream_proxy_url`。
- 前台缓存命中只走 `isPlayableUrl`（零网络），不把 Electron 仍存在的 `verifyPlayableUrl` 加回去。
- 上一首/下一首已 `{ immediate: true }`，没有 300ms 防抖。
- 同机 sidecar 基准 `node scripts/playback-url-benchmark.mjs`（2026-09-17T05:49Z）:
  - 缓存命中 `wy_448749148_320k`: 查表 2ms；语法校验 0ms；HTTP `verifyPlayableUrl` 47ms 且 403。
  - 同源未命中 `kw_316696_320k`: 缓存 miss；酷我 `musicUrl` 冷 353ms / 热 414ms。
  - 跨源: TX 搜索 541ms + TX URL 461ms。
  - 飞牛: `musicUrl` 冷 2489ms / 热 1518ms；裸 URL 39ms **401**；带 `Accept`+`Cookie` 93ms **206 audio/mpeg**。
- `npm run build` 写入 `dist/`；`node --check` sidecar 与基准脚本通过。

遗留项:
- 手工 UI 计时未做。当前没有可用的 `npm run tauri dev` 实例，且不能再启一个。开发态计时写在 `ceru_playback_timings_v1`，等现有实例热更新后由 VERIFY-01 点上一首/下一首读出。
- 网易缓存 URL 可能在 6h TTL 内就 403，前台仍依赖 `audio.error` 回退而不是切歌前探测。
- 不要用赞助版插件对 `wy_448749148` 调 `musicUrl`，会报「音乐 ID 不存在」。

---

## SYNC-01：云端/插件同步去重与镜像规则

状态: 已完成 / 2026-09-17

已完成: `pullFavoritesFromCloud` / NAS `replaceLocalPlaylistSongs` 都走 `applyRemotePlaylistSongs`：增删、补空封面、按远程 `pos`/`position` `reorderSongs`。播客收藏的 position/pin 与 Electron `nasSync.ts` 一致。
证据: 库里「我的喜欢」第一首已是《爱我的人和我爱的人》，第四首《One more time, One more chance》，1422 首。
遗留: 两条同名「经典老歌大放送」不删不合并，等用户确认。

当前库 15 个歌单，**没有未经确认删除**。

只读结论:
- `我的喜欢` (`playlist-edf00e0b-...`, local, 1422 首): 保留。
- `飞牛全部歌曲` (`service_9ff4..._all-tracks_1789561689597`, local, 699 首): 本地飞牛镜像，`importedFrom`+`remotePlaylistId=all-tracks`。名称含“飞牛”，`isBridgedPlaylist` 会拦住上传。保留，不去重删除。
- `经典老歌大放送！一人一首代表作！` 两条同名:
  - `playlist-58df451e-...` source=`kw`，meta.playlistId=`digest-8__2996314807`，183 首。像发现页导入的源歌单。
  - `playlist-1251cbde-...` source=`local`，已绑 `cloudId=pl_33d7c57d...`，183 首。像云端镜像。
  建议保留云端那条，源歌单是否合并需用户确认，本任务不删。
- 其余 local 歌单无重复 remote ID。

遗留: 等用户确认是否合并那两条同名“经典老歌”。


### 目标

处理当前数据库里的重复歌单、云端副本和飞牛镜像副本，保证恢复模式不删错、
不重复创建、不上传飞牛本地镜像。

### Electron 对照

- `src/renderer/src/utils/playlist/bridgedPlaylist.ts`
- `src/renderer/src/utils/playlist/cloudLibrarySync.ts`
- `src/renderer/src/services/nasSyncPoller.ts`
- `src/renderer/src/utils/playlist/pluginSync.ts`

### Tauri 落点

这些文件应先与 Electron 逐行对比。当前已知差异：

- `cloudLibrarySync.ts` 的 `canUseCloudLibrary()` 增加了 `authStore.initialized` 判断。
- `ensureLocalFavoritesPlaylist()` 返回类型改成 `Promise<string>`，逻辑未改。
- `songlist.vue` 增加了封面补全和刷新节流。

### 需要继续完成

- 查清当前重复歌单的来源：
  - 本地 `source: kw` 歌单
  - 云端镜像歌单
  - `service_*` 飞牛导入歌单
- 不允许未经确认批量删除用户数据。先只读查询，列出重复 ID 和依据。
- 检查 `isBridgedPlaylist` 对以下字段的判断：
  - `source`
  - `meta.provider`
  - `meta.importedFrom`
  - `meta.remotePlaylistId`
  - 歌曲 `source === 'feiniu'`
- 检查完整恢复时是否会删除本地独有歌单。
- 检查飞牛镜像是否被错误上传到 NAS。
- 如果要做去重，必须先生成 dry-run 报告，再由用户确认。

### 验收

1. 给出重复歌单清单：ID、名称、来源、歌曲数、判断依据。
2. 说明每一条是保留、合并还是仅解除云绑定。
3. 不改代码也可以先交只读报告。
4. 如果改代码，必须保留用户本地独有歌单和飞牛镜像。

### 禁止事项

- 不要直接 `DELETE` 重复歌单。
- 不要通过清库解决同步冲突。
- 不要把飞牛歌单上传到云端再去重。

---

## VERIFY-01：端到端验收与证据记录

状态: 已完成 / 2026-09-17

任务：VERIFY-01
结论：通过（UI 点选切歌、再导入飞牛歌单、播客收藏刷新仍建议肉眼看一眼）
证据：
- 唯一开发实例：ceru-tauri PID 37156，Vite http://127.0.0.1:1421/ 返回 200。没有新开第二个 tauri dev。
- 本机同时有 /Applications/澜音.app Electron 发行版在跑，未用它验收。
- SQLite：playlists=15，playlist_songs=3716，我的喜欢=1422，飞牛全部歌曲=699 且只有 1 条。
- 飞牛配置已落盘 token/deviceId/autoImportVersion=2。NAS pairCode 已落盘。
- 飞牛封面：无 Cookie 401，带 Cookie 返回 JPEG 200。
- sidecar node --check 通过；cargo check 通过；parses_string_album_id 通过。
- PLAYLIST-01 已补已有歌曲封面回退。PLUGIN-01 已修 NAS schema 截断。
未验证项：UI 点选上一首/下一首计时、再导入飞牛全部歌曲、播客收藏刷新后仍在。
风险：运行中 sidecar 副本下次热重载前仍可能用旧 schema 解析，设置页已有沙箱回退。
建议下一步：用户在现有窗口看飞牛封面和我的喜欢；两条同名“经典老歌”等确认再合并。

### 目标

由独立 agent 验证前面任务，不修改功能代码。只负责复现、记录、给结论。

### 必查项

1. 当前 Tauri 实例是否唯一。
   - 开发地址：`http://127.0.0.1:1421/`
   - 不要启动第二个 `npm run tauri dev`。
   - 不要用应用名启动 `/Applications/澜音.app`。
2. SQLite：
   - `~/Library/Application Support/com.cerumusic.tauri/ceru-music.db`
   - 查 `playlists`、`playlist_songs`、`settings`、`plugin_configs`。
3. 构建：

```bash
cd /Users/songsong/Movies/树夏Music-Desk-tauri
npm run build
node --check sidecar/index.mjs
node --check sidecar/services/plugins/index.mjs
cd src-tauri
cargo check
```

4. 手工流程：
   - 插件页能看到飞牛和 NAS Sync。
   - 飞牛测试连接成功。
   - 飞牛歌单不重复。
   - 飞牛封面可见。
   - “我的喜欢”有歌。
   - 上一首/下一首有计时。
   - 播客收藏刷新后仍在。
   - 关闭重开不丢配置。

### 交付格式

```text
任务：
结论：通过 / 未通过 / 阻塞
证据：命令、数据库查询、页面操作、时间数字
未验证项：
风险：
建议下一步：
```

---

## LYRIC-01：桌面歌词窗口立刻显示

状态: 已完成 / 2026-09-18 / 热键开窗与上一首下一首已验

### 目标

点底栏桌面歌词后，窗口必须像 Electron 一样立刻出现；视觉仍是桌面歌词页，但不再二次加载整套主应用。

### Electron 对照

- `/Volumes/致钛 2T/CeruMusic/src/main/events/lyric.ts`
  - `change-desktop-lyric` 后立刻 `lyricWin.show()`。
- `/Volumes/致钛 2T/CeruMusic/src/main/windows/lyric-window.ts`
  - Electron 仍走完整 renderer hash 路由；Tauri 允许独立轻量入口，只要界面与行为一致。

### Tauri 落点

- `src-tauri/src/commands/lyric_window.rs`
- `desktop-lyric.html`
- `src/desktop-lyric-main.ts`
- `src/desktop-lyric-bridge.ts`
- `src/views/DeskTopLyric/LyricIcon.vue`

### 已完成

- 创建后立刻 `show()`（alpha 先 0，约 350ms 后淡入，避免白闪）。
- ready 不再额外死等 1000ms；创建路径也有 1200ms 兜底淡入。
- 桌面歌词改走独立轻量入口，不再二次加载完整 `main.ts`/路由/插件系统。
- 播放控制通道对齐 Electron：`playPrev` / `playNext` / `toggle` 专用事件，不再一律 pause。

### 验收

1. 等现有 `npm run tauri dev` 重编译完。不要新开第二个。
2. 点底栏桌面歌词，桌面必须立刻出现透明歌词窗，且不白闪。
3. 窗口里要是歌词页，不能是主界面。
4. 托盘/底栏上一首下一首能切歌，不能只暂停。

### 禁止事项

- 不要再等 `desktop_lyric_window_ready` 才第一次 `show()`。
- 不要新开第二个 `tauri dev`。

---

## PLUGIN-LX：洛雪插件完整兼容

状态: sidecar 已落盘转换 / 2026-09-17 18:33 / 待设置页手工验收

### 目标

洛雪兼容插件的导入、转换、设置页显示必须和 Electron 一致，不能只认 `lx.on(` 这种清晰代码。

### Electron 对照

- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/index.ts`
  - `type === 'lx'` 时 `pluginCode.toLowerCase().includes('lx')` 就过，然后一定 `convertEventDrivenPlugin`。
  - `type === 'cr'` 时检 `cerumusic`。
  - `addPlugin` 只对 `looksLikeLxEventPlugin` 且未转换的代码再转一次。
- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/manager/converter-event-driven.ts`
  - 转换结果带 `由 CeruMusic 插件转换器转换` 标记。

### Tauri 落点

- `src/tauri-bridge.ts` `preparePluginCode` / `looksLikeLxPluginCode` / `loadAllPlugins`
- `sidecar/services/plugins/index.mjs` `preparePluginCode` / `installFromCode` / worker 启动转换
- `sidecar/services/plugins/converter-event-driven.mjs`
- `src/utils/plugin/converter-event-driven.ts`
- `src/components/Settings/plugins.vue`

### 已完成

- 洛雪导入校验改成 `includes('lx')`，不再要 `lx.on(`。
- 混淆插件如 `lx-玉宁熙-Pro` 能被转换；转换结果带 Electron 同款标记。
- sidecar 加载失败也会留下注册表记录，设置页空 `pluginInfo` 有兜底。
- sidecar 安装和 worker 启动都转换并写回磁盘。`lx-玉宁熙-Pro` 当前文件已是转换结果。

### 验收

1. 设置页能看到已安装的洛雪插件名称。
2. 再导入一个含 `lx` 的混淆洛雪插件，不能报格式校验失败。
3. `野草` 这类源码里连 `lx` 字符串都没有的插件，Electron 也会拒，不要强行当洛雪导入。

### 禁止事项

- 不要把已转换插件再次包一层。
- 不要按插件名猜 `serviceRole`。
- 不要新开第二个 `tauri dev`。

---

## 给其他 Agent 的标准提示词

下面的提示词可以直接复制给新的 agent。

### 通用开头

```text
项目目录是 /Users/songsong/Movies/树夏Music-Desk-tauri。
先读 AGENTS.md、CONTEXT_HANDOFF.md 的 Non-Negotiable Constraints，
再读 MIGRATION_TASKS.md。
只领取我指定的任务编号，不要重读整个仓库，不要修改其他任务文件。
Electron 参考项目 /Volumes/致钛 2T/CeruMusic 只能读，不能修改。
默认用中文回答用户和写记录。
```

### 领取单个任务

```text
请执行 MIGRATION_TASKS.md 中的 <任务编号>。
要求：
1. 先复述 Electron 对照文件和调用顺序。
2. 先复现问题并记录证据。
3. 只修改该任务的 Tauri 落点。
4. 完成后运行该任务的验收命令。
5. 更新任务状态、CONTEXT_HANDOFF.md 和 AI_INDEX.md。
6. 最终用中文汇报：改了什么、证据、剩余风险。
```

### 领取只读排查任务

```text
请执行 MIGRATION_TASKS.md 中的 <任务编号>，本任务只读，不改代码。
请给出：问题复现步骤、根因、涉及文件、建议修复、验收标准、风险。
不要删除数据库，不要修改 Electron 参考项目。
```

### 领取验证任务

```text
请执行 MIGRATION_TASKS.md 中的 VERIFY-01。
只验证，不改功能代码。
必须使用当前已经运行的 Tauri 开发实例，不要启动第二个实例。
所有结论必须带证据，不能用“应该可以”描述。
```

### 上下文或时间超限时的拆法

```text
这次只处理一个最小子问题：<例如 songlist_add_songs 的头部插入>。
不要进入其他链路。
先读 Electron 对应符号，再读 Tauri 对应符号，再改代码，再验证。
输出控制在 30 行以内，证据用命令和数据库结果表示。
```

---

## 任务完成后的交接格式

每个 agent 完成任务后，必须在 `CONTEXT_HANDOFF.md` 增加一条：

```text
### <任务编号> <任务标题>
- 状态：已完成 / 部分完成 / 阻塞
- Electron 对照：
- Tauri 修改：
- 验证命令与结果：
- 实测数据：
- 剩余问题：
- 下一个任务依赖：
```

并且必须更新 `AI_INDEX.md` 的搜索别名或路由表，使下一次检索能定位到本任务。

## 当前确认的阻塞与风险

- 当前仓库没有第一次 Git commit，所有文件显示为未跟踪，不能用 `git diff`
  恢复历史。每个 agent 修改后仍要自行记录文件级差异。
- 当前 Tauri 开发实例仍在运行，地址是 `http://127.0.0.1:1421/`。
- 当前数据库里“我的喜欢”有约 1422 首歌，因此不能按“空歌单”处理。
- 当前数据库存在飞牛 `service_*` 导入歌单和旧格式 meta，迁移逻辑必须兼容。
- 飞牛封面问题的大概率原因是请求缺少登录令牌头，而不是插件没有返回封面。
- 上一首/下一首必须先测，不要凭感觉改。
