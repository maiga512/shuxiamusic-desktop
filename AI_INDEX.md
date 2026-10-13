---

## 2026-10-11 修复在线歌曲"播到一半突然断了、不播了"

- **现象**：播放在线歌曲，播到中途突然掐断、停住不播。
- **根因**：在线直链在播放途中偶发 TCP 连接被服务器关闭 / 网络瞬断。内置 mpv 的 ffmpeg http 协议默认不重连，一次读失败就发出 `end-file(reason=error)`（`mpv_player.rs` 的事件分发把它转成 `emit_error_event("mpv_end_file_error")`）；前端 `nativePlayback.handleError` → `publishOnce('error')` → `globaPlayList` 的 `controlAudio.subscribe('error')` 把它当成播放错误跑 `currentPlaybackErrorHandler`（换源 / `tryAutoNext`），听感就是"中途断了、不播了"。此前已把 `--cache-secs` 从 2s 放大到 30s 抗抖动，但缓存只能平滑短暂卡顿，socket 真断了必须让 ffmpeg 自己重连。
- **修复（仅 `src-tauri/src/commands/mpv_player.rs` 主 mpv 启动参数）**：新增 `--network-timeout=30` + `--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5`，开启 ffmpeg http 自动重连（IINA / mpv.net 同款做法）。探活用的短命 mpv（`mpv_probe`）不动。
- **验证**：bundled mpv v0.41 / FFmpeg 9.0.1 实测接受这些参数（`--list-options` 有 `--stream-lavf-o`/`--network-timeout`，带参空跑 exit 0）；`cargo check` 通过（仅既有 96 warnings，无新增）。
- 索引：纯 mpv 启动参数改动，不涉及代码图拓扑 / 数据流 / 执行路径，未重跑 graphify 全量产物，仅追加本日志。待出包实测中途断流是否消除。

## 2026-10-09 媒体键收口：release 状态上报静默丢失 + 辅助功能权限失效自愈

- **根因一（耳机指令全被路由到浏览器网页）**：`tauri.conf.json` 未开 `withGlobalTauri`，release 包里 `window.__TAURI__` 不存在；`useSmtc.ts` 的 Now Playing 状态上报与诊断日志都走 `window.__TAURI__?.core?.invoke`，被 `typeof invoke !== 'function'` 守卫静默吞掉，系统（MediaRemote）永远收不到"我们在播放"，耳机指令被投给别的活跃会话（Edge 里开着的音乐网页）。其余 IPC 走 `@tauri-apps/api/core`（基于恒存在的 `__TAURI_INTERNALS__`），所以播放本身正常。日志实锤：08:20 启动后 mpv time-pos 在走，`/tmp/ceru-media-keys.log` 零 `np:` 行。
- **修复**：`syncNativeNowPlaying` / `mediaDiagLog` 改走 `@tauri-apps/api/core` 的 `invoke`（`safeTauriInvoke` 包装，吞异常不阻塞播放）；`HotkeySettings.vue` 录制态的第三处坏 `__TAURI__` invoke 同步修掉。
- **根因二（重打包后键盘 F7/F8/F9 失效）**：CGEventTap 依赖 macOS 辅助功能权限，权限绑定二进制 CDHash；重打包换签名后 tccd 统一日志明确 `Failed to match existing code requirement for subject com.cerumusic.tauri` + 两次 `kTCCServiceAccessibility` 查询被拒 → tap 注册静默失败（release 无 eprintln 出口），表现为零 `global-shortcut` 日志行。
- **修复（`hotkeys.rs`）**：`register_media_keys` 改返回 bool；注册失败时 `ax_is_trusted(true)` 弹一次系统授权对话框，`spawn_ax_retry` 后台线程每 2s 复查、最多 15 分钟，用户授权后自动补注册媒体键（无需重启 App），每次尝试写 `hotkeys: media keys re-register...` 进同一诊断日志。
- **根因三（新包启动数秒即崩，09:59 / 10:04 两次）**：Now Playing 首次生成封面时 `create_mpmedia_artwork` 调用 `+[NSImage imageWithData:]` —— 该类方法在 **macOS 27 被移除**（类对象还在、方法没了，本机 `respondsToSelector` 实测 0），运行时抛未捕获 `NSInvalidArgumentException` 直接 abort 整个进程（崩溃报告 `ceru-music-2026-10-09-100407.ips`，符号化确认崩溃帧在 `now_playing::macos::set_info` 内联的封面构造）。旧包从不崩是因为状态上报被静默吞掉、封面路径从未执行；状态上报修复后此隐患首次暴露。
- **修复（`now_playing.rs`）**：改用仍可用的实例方法 `alloc` + `initWithData:`（实测 =1），保留 `respondsToSelector:` 兜底——未来系统再删 API 时降级为"无封面+日志"，不再 abort；封面生成失败不缓存，下一次 `set_info` 心跳自然重试。同批实测 `MPMediaItemArtwork initWithImage:`、`dataWithContentsOfURL:` 在 macOS 27 均可用。
- **反向自愈（`globaPlayList.ts`）**：实测发现启动恢复期存在"mpv 在播但前端 `isPlay=false`"的竞争（sidecar 未预热时 load 的 IPC 偶发失败，mpv 照播、`isPlay` 留在 false），系统状态永远停在 paused、耳机键变死键。注意 `nativeIsPaused()` 读的是前端 store 自己的 `isPlay`、`isNativePlaybackActive()` 依赖 `currentUrl`（load 失败时被清空）——都不能当引擎状态用；修复在暂停态的 8s 进度 tick 里用 `mpv_get_state` 查真实引擎，连续两个 tick（约 16s）确认"引擎在播 + `isPlay=false`"才收敛：直接把前端 `isPlay`/`currentTime` 同步为引擎状态、重发 `play` 事件并上报 `playing`（不能调 `nativePlay()`，入口 guard 会空转）。日志 `self-heal:` 行可观测。
- 验证：`cargo check`、`npx vue-tsc --noEmit` 通过，`npm run tauri:build:macos` 出包（注：09:33 包启动数秒即崩，见根因三，修复后重打包）。用户步骤：启新包→弹授权框就授权（列表里两个树夏Music 时删旧勾新）→先暂停/关掉 Edge 里的音乐网页→放歌后测耳机单击暂停/双击下一首。

## 2026-10-09 耳机播放/暂停状态回环修复 + 媒体键 toggle 语义 + 双路去重

- **根因**：系统（MediaRemote/AVRCP）按"会话当前上报的播放状态"决定给耳机发 play 还是 pause。此前前端心跳硬编码 `playing:true`、`handlePause` 的状态同步又依赖 `url && audio 元素` 条件，暂停后系统状态停在 playing，用户按多少次都只收到 pause，且永远不会收到 play —— 耳机键"完全失灵"。
- **`useSmtc.ts`**：心跳改读真实状态（`nativeIsPaused()`，native 引擎为准），实际未播放时主动把系统状态改回 paused 并停心跳（自愈，10s 内兜底任意漏报路径）；`updatePlaybackState` 每次留诊断日志。新增导出 `mediaDiagLog()` 写 `/tmp/ceru-media-keys.log`（经新命令 `media_diag_log`）。
- **`globaPlayList.ts`**：`handlePause` 只按 `isPlay` 决定停不停，且**无条件** `updatePlaybackState('paused')`；`onGlobalCtrl` 对 `pause` 改 toggle 语义（在播→暂停，不在播→播放）、`play` 仅在未播时启动，系统状态感知滞后时按键也永远有实际效果；`source=media` 的同指令 250ms 去重（Rust MPRemoteCommandCenter 与 WKWebView Media Session 可能双路投递同一次按键，toggle 语义下双触发会互相抵消）。
- **`now_playing.rs`**：`set_info` 每次系统状态更新写 `np` 时间线日志（state/rate/elapsed/title），下次排障可直接从 `/tmp/ceru-media-keys.log` 看状态有没有同步、何时被覆盖；新增 `media_diag_log` 命令。
- **`Provider.vue` / `globalControls.ts`**：Rust 媒体键通道与 Media Session 回调的事件打上 `source=media` 标记供去重。
- 验证：`cargo check`、`npx vue-tsc --noEmit` 通过；`npm run tauri:build:macos` 出包。待用户戴耳机实测：播放中按一次→应暂停，再按一次→应恢复；双击下一首依赖系统设置里 AirPods 双击映射为"下一首"（设置→蓝牙→AirPods→双击）。
project: ceru-tauri
project_name: Ceru Music Tauri
project_aliases:
  - Ceru Music
  - CeruMusic
  - 澜音
  - 澜音 Tauri
  - Ceru Music Tauri
kind: tauri-desktop-music-player
language_policy: 所有回答必须中文
playback_backend: bundled-mpv-only
stack:
  - Tauri 2
  - Rust
  - Vue 3
  - TypeScript
  - Vite
  - Pinia
  - WebKit
  - Node sidecar
domains:
  - playback
  - music-sources
  - plugins
  - quality-and-download
  - podcast-and-radio
  - discovery-and-playlists
  - desktop-lyrics
  - local-music
  - listen-together
  - memory-and-performance
search_aliases:
  - 音源
  - 切源
  - 音质
  - 下载
  - 播客
  - 电台
  - 发现
  - 歌单
  - 桌面歌词
  - 底栏
  - 全屏播放
  - 卡顿
  - 加载慢
  - 内存
  - 插件
graph:
  json: graphify-out/graph.json
  report: graphify-out/GRAPH_REPORT.md
  html: graphify-out/graph.html
  labels: graphify-out/.graphify_labels.json
  top_graph: TOP_GRAPH.md
last_indexed: 2026-10-09
graph_stats_source: graphify-out/GRAPH_REPORT.md
---

## 2026-10-08 耳机媒体键根因（bundle 身份）+ 喜欢页静默刷新去抖

- **耳机控制根因**：`tauri dev` 跑的是 `target/debug/ceru-tauri` 裸可执行文件，
  `[[NSBundle mainBundle] bundleIdentifier]` 为 nil（实测日志已确认）。MediaRemote /
  MPRemoteCommandCenter 只把耳机（AVRCP：播放暂停、双击下一首）和控制面板指令投给
  有 bundle 身份且被认定为"正在播放"的 App，所以键盘媒体键（CGEventTap）能用而
  耳机键永远送不到本进程。修复：`src-tauri/build.rs` 在编译期向可执行文件同级目录
  生成 `Info.plist`（`com.cerumusic.tauri`），dev 裸跑也有 bundle 身份；实测
  `/tmp/ceru-media-keys.log` 出现 `init: bundleIdentifier=com.cerumusic.tauri`。
- **Now Playing 心跳**：`useSmtc.ts` 播放期间每 10s 复述一次 now-playing
  （title/artist/album/artwork/elapsed/rate），否则系统会把会话判为过期，耳机键
  不再路由过来、控制面板进度也会冻结；`now_playing.rs` 新增 `artwork_for()` 按 URL
  缓存 `MPMediaItemArtwork`，心跳不再每 10s 同步下载一次封面。
- **踩坑记录**：不要在 Tauri setup 里调 `-[NSApplication
  beginReceivingRemoteControlEvents]`，实测直接 abort 进程（panic in a function
  that cannot unwind）；`MEDIA_KEY_BINDINGS` 去掉 `MediaStop`（Apple 键盘/耳机没有
  停止键，global-hotkey 报 `Unknown scancode for MediaStop`），停止指令由
  `stopCommand` 负责。诊断开关 `CERU_DISABLE_MEDIA_TAP=1` 可只保留 MPRemote 通道。
- **喜欢页"一直在跳"**：`list.vue` 的 `fetchLocalPlaylistSongs` 过去整体替换
  `songs.value`，NAS/收藏事件每来一次就等于整表重建。改为 `mergeLocalSongsInto()`
  按 `source|songmid` 复用原行对象、内容一致时零响应式写入，并加
  `localSongsInFlight/localSongsRerun` 合并并发重读；`SongVirtualList.vue` 的
  `vObserveCover.updated` 只在绑定歌曲真的换了才 unobserve+observe（否则每次无关
  patch 都会让 IntersectionObserver 重跑一屏封面解析），`props.songs` 的 watch 用
  轻量签名判断内容是否变化再决定掐断在飞封面请求。
- **插件配置自激循环**：插件日志实测每 40~55 秒重复
  `插件配置已保存 → 插件已加载到 Node worker → onConfigUpdate not implemented`。
  根因在 `pluginSync.ts` 的 `applyCapabilityPlugin`：本地写回后指纹仍与云端不等，
  每轮同步都再写一次；三处 `saveConfig` 前加 `samePluginConfig()` 判等，配置没变
  就不写盘、不拉 worker。
- 验证：`cargo check`、`npx vue-tsc --noEmit` 通过；`npm run tauri:build:macos`
  重新出包。耳机端到端仍需用户按一次耳机键后读 `/tmp/ceru-media-keys.log`。

## 2026-10-08 窗口化全屏填充状态栏 + 安卓 A1 单层背景移植 + 媒体键诊断日志

- **背景改按安卓新版（A1 省电版）移植**：安卓仓当前 `PlayerGpuBackdrop.kt` 是 `BACKDROP_USE_BITMAP_CACHE = true`：整组光斑/方向雾/Overlay/Scrim 预光栅化成一张缓存位图（720P 封顶）每帧只贴图，视觉与旧版逐层绘制像素级一致。`FullPlay.vue` 的 `bakeCurrentBackdrop` 重写为同策略：切歌/改尺寸烤一次、播放只合成。stack A/B（`.bg-fallback`：对角底渐变 + 右下/左上/左下椭圆主光斑 + 有封面时 art 三层 + 方向雾三层，`transform: scale(1.1)` 对应 Compose `scale(1.10, pivot=center)`）+ 独立 `.bg-overlay-a/b`（scale 组外 `BlendMode.Overlay` 白柔光 → CSS `mix-blend-mode: overlay`）+ `.bg-backdrop-scrim`（`DesktopEnvironmentScrim` 同款四层常量黑：平涂 0.256 + 横向 0.03/0.12 + 纵向白 0.012/黑 0.30 + 径向暗角 0.30、圆心 48%/46%、半径 1.02w）。色阶按新版 `CoverColorUtils.extractBackdropColors`：Mac `ColorObject`（`colorExtractor.ts` 已 enhance）直接当 vibrant，lightAccent=mix(white,0.8)、secondary=main×0.35、base=main×0.18；新增 `boostForLightField`（先向白提亮再按 saturation 拉回饱和）；`hasBackdropArtwork()` 控制 art 光场与 alphaScale 1/1.08；`nextKey` 含宽高与 hasArtwork。
- **窗口化全屏（填充顶部状态栏）**：新增 `src-tauri/src/windowed_fs.rs` 复刻 Electron 网易云式 `enterWindowedFullScreen`：不走 macOS 原生全屏独立 Space，`set_decorations(false)` + `set_always_on_top(true)` + NSWindow `setLevel:1000`（NSScreenSaver 层，高于菜单栏 24，真正盖住状态栏）+ 窗口摆到显示器物理原点并铺满整屏物理尺寸；进入先置 `FS_ACTIVE` 再改尺寸（Resized guard 不误判），快照 position/size/maximized/alwaysOnTop/decorations，退出完整还原。命令 `windowed_fullscreen_get/set`，切换 emit `app-fullscreen-changed`；`main_window_state_payload` 与 Resized 上报的 `fullscreen` 改为原生∥窗口化。`tauri-bridge.ts` 的 `toggleFullscreen`/`getWindowStatePayload` 改查 Rust 状态（native `isFullscreen` 窗口化下恒 false）；`FullPlay.vue` 根节点加 `fullscreen` class，全屏时去 22px 窗口圆角。
- **媒体键诊断日志**：`now_playing.rs` 新增 `log_media_event` 写 `/tmp/ceru-media-keys.log`；`global-shortcut`（CGEventTap）与 `mp-remote`（MPRemoteCommandCenter）双通道都埋来源与 debounced 标记，用于区分耳机场景“事件没到进程”还是“到了没派发”。
- 验证：`cargo check`、`vue-tsc --noEmit`、`npm run tauri:build:macos` 全部通过。

- **媒体键全平台恢复**：`src-tauri/src/hotkeys.rs` 的 `register_media_keys` 恢复全平台注册 `MediaPlayPause/MediaTrackNext/MediaTrackPrevious/MediaStop`（上一会话曾在 macOS 跳过，只剩 `now_playing.rs` 的 MPRemoteCommandCenter，后台+耳机下完全不可用）。global-hotkey 0.8 在 macOS 走 SystemDefined CGEventTap 截获 NX_KEYTYPE 事件（键盘/有线耳机/AirPods/蓝牙），命中即消费，前后台都可靠；MPRemoteCommandCenter 保留为 Now Playing 展示 + 兜底，`MEDIA_EVENT_DEBOUNCE_MS=100ms` 防双通道重复触发。CGEventTap 需要 macOS 辅助功能权限，未授权时注册失败只打日志、不阻塞。
- **全屏背景对齐安卓横屏**：`FullPlay.vue` 的 `bakeCurrentBackdrop` 重写为安卓 `CarFullPlayerPreviewLayout` 五层打光（纵向白/黑遮罩 → 中心暗角 → 右下主色光斑 → 左上浅光斑 → deep→dark 底渐变；CSS 第一层在最上，与 Compose 顺序相反）。色阶与 `CoverColorUtils.extractBackdropColors` 一致：先 `enhanceDesktopMainColor`（S=min(S*1.2,0.9)、V<0.3→min(V*1.5,0.5)、V>0.7→max(V*0.8,0.5)），再 deep=main*0.18（base）、dark=main*0.35（muted/secondary）、light=mix(main,white,0.8)（lightAccent）；光斑半径按舞台宽度换算 px（0.86w/0.78w/0.62w）。渐变下纯色 `bgBaseColorA/B` 随层切换；`backdropInputKey` watch 暂停时不再跳过烘焙（一次性字符串计算）；删除 `isAudioPlaying` 清烘焙定时器的 watch；`handleBackdropResize` settle 后重新烘焙（窗口变宽要重算光斑 px 半径）；`releaseFullPlayHeavyResources` 同步清 base 色。
- **触控板一甩一切**：`FullPlay.vue` 的 `onFullPlayWheel` 水平段改为滑动段锁存：`swipeState`(acc/dir/latched/lastEventAt) + `SWIPE_GAP_MS=180`；事件断流 >180ms 或方向反转 = 新滑动段；累计 |acc| ≥ `GESTURE_TRIGGER_DISTANCE=48` 触发 `applyFullPlayGesture('layout')` 并锁存，本段剩余惯性事件全部忽略；`applyFullPlayGesture('layout')` 不再叠加 300ms 共享冷却（快速连续两次甩动第二下不再被误吞）。
- 验证：`cargo check` 与 `vue-tsc --noEmit` 通过。Graphify AST 增量：10660 nodes / 21022 edges / 746 communities；`graph.html` 社区聚合导出（332 社区节点 / 799 跨社区边）。

## 2026-10-08 全屏背景闪烁 + 光照简化

- 背景闪烁修复：`FullPlay.vue` 的 `handleBackdropResize` 改为空函数，resize 时不再重新烘焙背景。`background-size: cover` 本身就自动等比缩放，重新烘焙反而导致旧图被拉伸 80ms 产生"截图"闪烁。
- 光照简化：`bakedAmbientBackdrop.ts` 去掉三层"方向雾"和两层 Overlay 白色柔光，以及三层大范围环境光，只保留底部渐变 + 左上/右下/左下三个取色光斑。对齐安卓版的简单单层自然光照。
- 验证：`vue-tsc` 仅报 `main.ts` 既有 `LogtoClient` 类型不匹配（与本次无关）。

## 2026-10-08 全屏封面尺寸 + 双指滑动手势修复

- 无歌词/播客封面放大：`FullPlay.vue` 的 `.no-lyrics` CD 尺寸从 `max(200px, min(24vw, 560px, ...))` 提升到 `max(260px, min(32vw, 720px, ...))`；方形封面从 `min(480px, 45vh)` 提升到 `min(580px, 55vh)`。
- 双指滑动卡死修复：`FullPlay.vue` 的 `onFullPlayWheel` 只在手势真正触发后才锁定 `armed=false`；冷却期挡住时不锁定并重置累积距离。`GESTURE_COOLDOWN_MS` 从 520ms 降到 220ms 与 `GESTURE_REARM_MS` 对齐，连续滑动不再卡住。
- 验证：`vue-tsc` 仅报 `main.ts` 既有 `LogtoClient` 类型不匹配（与本次无关）。

## 2026-10-08 四项用户反馈修复

- **更新端点**：`tauri.conf.json` 的 updater endpoint 从 `desktop-latest/latest.json` 改为 `releases/latest/download/latest.json`，跟随 GitHub 最新 Release；`autoUpdateService.ts` 增加 30 秒错误去重，后台检查网络失败不再反复弹窗。
- **播放/暂停按钮竞态**：`nativePlayback.ts` 新增 `stateTransitioning` 标志，在 `nativePlay`/`nativePause` 命令执行期间抑制 `applyStateToStore` 对 `isPlay` 的覆盖，消除 MPV 状态事件与显式命令的竞态。
- **macOS 媒体键（当日已恢复）**：本条原方案为 `hotkeys.rs` 的 `register_media_keys` 在 macOS 上直接跳过（`#[cfg(target_os = "macos")]`）；实测 Now Playing 路径在后台/戴耳机时完全不可用，已在同日「媒体键恢复 + 全屏背景对齐安卓横屏 + 一甩一切」条目恢复全平台注册。
- **启动第一首歌重试**：`globaPlayList.ts` 的 `initPlayback` 恢复路径增加 2 秒延迟重试，解决插件 worker 未预热时首次 URL 解析失败的问题。
- 验证：`cargo check` 通过；`vue-tsc` 仅报 `main.ts` 既有 `LogtoClient` 类型不匹配（与本次改动无关）。

## 2026-10-04 安卓播放链路性能补齐

- 对照桌面 Ceru / 落雪安卓，补齐安卓 `/Volumes/致钛 2T/shuxiamusic` 播放链的剩余性能点：
  - `MusicViewModel.kt`：当前源按声明音质最多 3 档逐档降级；`playNext` 恢复有守卫的 Media3 单条预备项快路径；预取深度按非计量网络和电量降为 1，缓冲中暂停预取。
  - `PersistentPlaybackUrlCache.kt`：落盘改为单线程 debounce IO，切歌热路径不再同步序列化 JSON；新鲜缓存跳过同步 Range 探测。
  - `LocalStorage.kt` / `MusicViewModel.kt`：播放状态拆成“进度高频小写 + 队列/歌词变化时全量写”，避免每 3 秒重写 1400+ 完整队列。
  - `docs/CERU_PLAYBACK_LINKCHAIN.md`、`docs/LX_MOBILE_PLAYBACK_PARITY.md` 已同步新行为。
- 验证：安卓 `:app:compileDebugKotlin` 通过；`:app:testDebugUnitTest` 被既有 `PlaybackKeepAlivePolicyTest` 与当前 Media3 API 不匹配阻塞，与本次改动无关。
- Graphify：安卓侧 `scripts/ai-refresh.sh` 与 `scripts/refresh-graphify.sh` 已刷新；本仓库 `graphify update .` 与 `graphify export html` 已执行。

## 2026-09-29 MPV 退出生命周期修复

- `src-tauri/src/commands/mpv_player.rs`：`mpv_shutdown` 不再在退出路径等待 MPV IPC 的 `quit` 响应；先从运行时状态取出 `Child` 并释放锁，再直接 `kill + wait`，避免 IPC 断开或卡住时主程序退出而 MPV 继续播放。
- `src-tauri/src/lib.rs`：真正退出仍统一经过 `RunEvent::ExitRequested` / `Exit` 清理；关闭到托盘继续只隐藏窗口，保持 Electron 的 `closeToTray` 语义。
- Electron 对照：`src/main/index.ts` 的窗口关闭/退出策略与 `src/main/services/windowLifecycle.ts` 的 `closeToTray` 决策；Tauri 特有适配仅为 Rust `Child` 进程回收，因为 Electron 播放进程由 Electron 生命周期管理，而 Tauri 的 MPV 是 Rust 直接创建的子进程。
- 验证：`cargo check`、`npm run build`、`node --check sidecar/index.mjs` 通过。当前环境不能读取完整进程表，尚未进行实际播放后退出的进程树验收。

## 2026-09-29 全屏多首切歌性能审计状态

- 当前执行环境统一禁止本地端口监听（1421/1422/5173/4173 均返回 `EPERM`），无法启动新的 Tauri/Vite 交互实例；残留调试页是空 `#app`，不能进行真实播放、切歌或全屏采样。
- 静态审计确认播放链已有请求 ID、旧音频监听器移除、预取缓存上限、全屏重资源释放和本地进度时钟降频；没有证据支持直接改动播放时序。
- 修复 `FullPlay.vue` 的背景烘焙监听：从 `deep: true` 的颜色对象监听改为按歌曲/来源/颜色/显示状态生成稳定 key，避免同一首歌的深层响应式变化重复触发同步 Canvas 烘焙。`npm run build` 已通过。
- 完整性能结论仍需在允许端口监听的桌面环境按普通播放、多次上一首/下一首、全屏多首切歌、退出全屏、最小化恢复采集完整进程树后确认。

- 已实际检查旧调试页：`#app` 为空，没有 Vue DOM、播放控件或可操作播放器。
- 之前的 30 秒采样对应空页面与 `mpv --idle=yes`，不能作为普通播放、切歌或全屏基线。
- 本轮重新启动单实例 `npm run tauri dev` 时，Vite 被当前环境拒绝监听 `127.0.0.1:1421`，返回 `listen EPERM`；因此没有伪造性能结论，也没有继续盲改性能代码。
- 完整测试仍需在允许本机端口监听的桌面环境执行：普通播放、连续切歌、全屏连续播放、退出全屏、最小化恢复，并采集完整进程树。

- `main.ts` 的插件预热和飞牛同步本来就是异步 fire-and-forget，确认它们不会直接阻塞 `app.mount('#app')`。
- 修复启动桥接的非必要封面代理预热：`createTauriBridge()` 不再在挂载前立即发起 `cover_proxy_base` IPC，而是放到首帧后的定时任务；同时 `main.ts` 对桥接初始化增加异常隔离，避免单个 Tauri 初始化异常阻断后续 Vue 启动代码。
- `npm run build` 已通过；Graphify 更新仍因当前环境 `Operation not permitted` 未完成，生成图文件未伪造修改。

## 2026-09-30 桌面三端更新流水线重写

- 重写 `.github/workflows/desktop-release.yml`：产物统一发布到固定标签 `desktop-latest`，与 `tauri.conf.json` 更新器端点 `releases/download/desktop-latest/latest.json` 对齐。
- 关键约束：发布 Release 时 `make_latest: false`。安卓 `AppUpdateManager.kt` 读取 `api.github.com/repos/maiga512/shuxiamusic-release/releases/latest` 下载 `app-release.apk`，桌面 Release 一旦成为“Latest”会导致安卓拉到错误包；固定标签 + 非最新指针让三端共用一个发布仓库且互不干扰。
- 新增 `scripts/ci/collect-macos.sh`、`scripts/ci/collect-windows.sh`、`scripts/ci/make-latest-json.py`：把各平台更新器产物改成 ASCII 唯一名（避免 arm64/x64 的 `.app.tar.gz` 同名冲突），并按实际产出的平台动态生成 `latest.json`（键：`darwin-aarch64` / `darwin-x86_64` / `windows-x86_64`）。
- Windows 作业设 `continue-on-error: true`，`publish` 用 `if: always()` 且只要有一个平台成功即发布，Mac 更新不会被 Windows 阻塞。
- `scripts/prepare-mpv-runtime.mjs` 增加 Windows 分支：从 `CERU_MPV_WINDOWS_URL`（.zip/.7z）下载便携 mpv，或用本地 `CERU_MPV_PATH`，把 `mpv.exe` 及同目录 DLL 平铺进 `packaging/mpv/bin`。
- 需要的仓库 Secrets：`TAURI_SIGNING_PRIVATE_KEY`（对应 `ceru-updater.key`，公钥已与 `tauri.conf.json` pubkey 核对一致）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`、`RELEASE_REPO_TOKEN`、Windows 另需 `CERU_MPV_WINDOWS_URL`。
- 安全：`src-tauri/ceru-updater.key` 私钥已加入 `.gitignore` 且不在 git 历史中；仅公钥 `ceru-updater.key.pub` 入库。
- 版本号统一为 `1.0.0`（`package.json` + `tauri.conf.json`）。

## 2026-09-29 GitHub desktop release workflow

- Added `.github/workflows/desktop-release.yml` to build Apple Silicon, Intel Mac, and Windows x64 packages on GitHub-hosted runners, without requiring a local Windows computer.
- The workflow expects repository secrets `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and a cross-repository `RELEASE_REPO_TOKEN`; it publishes build artifacts to `maiga512/shuxiamusic-release`.
- The workflow currently collects Tauri-generated package and signature artifacts. A valid `latest.json` must be generated by the release step or provided by the release tooling before updater verification.
- Windows MPV packaging requires a Windows-compatible portable MPV binary through `CERU_MPV_PATH`; the workflow fails early if that runtime is not provided, rather than publishing an incomplete installer.
- Graphify refresh remains pending because the environment returned `Operation not permitted`.


- Mac/Windows Tauri updater endpoint now targets the shared `maiga512/shuxiamusic-release` GitHub Release `latest.json`; Android APK publishing remains compatible because platform artifacts are selected by the updater manifest.
- Desktop startup now schedules a delayed background check and repeats it every six hours when `autoUpdate` is enabled. Update downloads are silent and retained for the next application restart.
- The GitHub repository currently has Android APK only; Mac/Windows signed artifacts and the platform-aware `latest.json` still need to be published before production update verification.
- Graphify refresh was attempted but failed with `Operation not permitted`; generated graph outputs remain pending refresh.


- Mac 远端歌单事件广播现在携带 `remote` 标记，当前页面只重读本地数据库，不再因远端收藏/取消收藏事件触发带副作用的云端回拉。
- 远端歌单歌曲应用检查本地增删和封面刷新结果；失败时保留未确认状态，不继续推进为成功。
- Graphify 入口仍为 `src/services/nasSyncPoller.ts`、`src/utils/playlist/cloudLibrarySync.ts` 和 `src/views/music/songlist.vue`。

## 2026-09-20 NAS sync maintenance

- NAS sync now treats plugin upload as a merge: a missing cloud item cannot delete a local plugin or remove another device's cloud plugin.
- Playlist, favorite, podcast favorite, and plugin records carry explicit order positions; reorder endpoints emit ordered-id events.
- Plugin listing no longer collapses different identities that happen to share one script hash.
- Graphify update: 7019 nodes, 15682 edges, 331 communities.

## 2026-09-21 NAS realtime convergence maintenance

- Favorite song operations now retry legacy stale sequences with a persistent timestamp-floor sequence before accepting a newer cross-device winner.
- Desktop playlist-song events always hydrate the authoritative ordered server snapshot, so membership and order update together in the currently open view.
- Playlist-favorite relation events no longer add or remove an entire playlist from the local "我的喜欢" song list.
- Cloud playlist restore now persists the server playlist order locally while retaining local-only playlists after the cloud-ordered items.
- Favorite playlist uploads now send an order-only snapshot when membership matches, so reordering favorites converges without overwriting concurrent adds or removals.
- Podcast favorite reorder events now reload the complete server-ordered collection on Mac, preserving both position and pinned state; server regression coverage now verifies podcast order events and pinned sorting.

## 2026-09-23 NAS operation-driven sync hardening

- Android AUTO no longer uploads a whole local playlist snapshot or seeds all local podcasts/plugins on first sync; explicit mutations remain the upload source, and snapshots merge without treating a missing cloud-bound playlist as deletion.
- Mac plugin add/delete uses durable pending-operation queues; the background poller flushes only queued plugin mutations instead of treating a local inventory scan as user intent.
- NAS SSE requests abort database waiters on disconnect; Mac SSE reconnects with bounded backoff while revision polling remains the delivery fallback.
- Verification: NAS typecheck and 32 tests pass; Mac production build passes; Android repository test passes. Release packaging and live cross-device validation remain pending due R8/Kotlin metadata incompatibility and unavailable ADB/device access.
- Graphify incremental update: 7123 nodes, 16012 edges, 332 communities; aggregated HTML export refreshed.

This is the fast search doorway for AI agents. Read this file before opening
source files. The curated architecture map is in `TOP_GRAPH.md`; generated graph
details are in `graphify-out/GRAPH_REPORT.md`.

## Language Rule

默认使用中文回答用户；过程更新、最终结论、状态说明、追问和错误解释都必须是中文。
只有用户在当轮明确要求其他语言时才切换。代码、日志、命令、文件名和第三方 API
名称可保留英文。

## Start Here

| Need | Start with | Then inspect |
| --- | --- | --- |
| App startup and routing | `src/main.ts`, `src/App.vue`, `src/router/index.ts` | `src/components/layout/Provider.vue` |
| Main layout / left sidebar | `src/components/layout/HomeLayout.vue` | `src/components/layout/Provider.vue`, `src/components/Play/PlayMusic.vue` |
| Tauri command bridge | `src/tauri-bridge.ts` | `src-tauri/src/lib.rs` |
| Node background service | `sidecar/index.mjs` | `sidecar/services/*/index.mjs` |
| Playback chain | `src/utils/audio/globaPlayList.ts` | `src/utils/audio/mediaGateway.ts`, `src/utils/audio/playableUrl.ts`, `src/services/media/nativeMedia.ts` |
| Music source/plugin selection | `src/tauri-bridge.ts` | `sidecar/services/plugins/index.mjs`, `sidecar/services/musicSdk/index.mjs` |
| Audio output | `src/components/Play/GlobalAudio.vue` | `src/utils/audio/audioManager.ts`, `src-tauri/src/commands/native_audio.rs`, `src-tauri/src/commands/mpv_player.rs` |
| Download and quality | `src/utils/audio/download.ts` | `src/utils/audio/qualityAvailability.ts`, `src/services/media/nativeMedia.ts`, `src-tauri/src/commands/download_engine.rs`, `sidecar/services/download/index.mjs` |
| Desktop lyrics | `src/views/DeskTopLyric/DeskTopLyric.vue` | `src/utils/lyrics/desktopLyricBridge.ts`, `src-tauri/src/commands/lyric_window.rs` |
| Windows packaging / NSIS | `docs/WINDOWS_PACKAGING.md` | `scripts/prepare-sidecar-runtime.mjs`, `src-tauri/tauri.conf.json`, `src-tauri/src/commands/node_sidecar.rs`, `.github/workflows/windows-build.yml` |
| Podcast and radio | `src/views/music/podcast.vue`, `src/views/music/radio.vue` | `src/api/podcast.ts`, `sidecar/vendor/electron/src/main/utils/musicSdk/wy/podcastOfficial.js` |
| Discover and playlists | `src/views/music/find.vue`, `src/views/music/list.vue` | `src/utils/playlist/playlistManager.ts`, `src/services/music/*` |
| Local music | `src/views/music/local.vue` | `src-tauri/src/commands/local_music.rs`, `src-tauri/src/db.rs` |
| Listen together | `src/store/ListenTogether.ts` | `src/api/listenTogether.ts`, `src/components/ListenTogether/*` |
| NAS/cloud sync | `src/api/nasSync.ts` | `src/services/nasSyncPoller.ts`, `src/utils/playlist/cloudLibrarySync.ts` |
| Settings | `src/views/settings/index.vue` | `src/components/Settings/*`, `src/store/Settings.ts` |
| Global hotkeys and media keys | `src-tauri/src/hotkeys.rs`, `src-tauri/src/now_playing.rs` | `src/components/Settings/HotkeySettings.vue`, `src/utils/hotkeys/recording.ts`, `src/utils/audio/useSmtc.ts` |

## Search Aliases

Use these aliases when searching issues, handoffs, or graph nodes:

| User wording | Canonical concepts | Primary files |
| --- | --- | --- |
| 左侧栏、侧边栏、导航栏、树夏Music 标题、侧栏居中、菜单间距 | main layout sidebar, logo-section, nav-section | `src/components/layout/HomeLayout.vue` |
| 收藏星、切源掉星、换源收藏丢失、喜欢状态、取消收藏、重启后掉收藏、列表心形 | favorite anchor（切源前用户选中身份）、`_originalIdentity`（换源队列项携带的原收藏身份，随 list 持久化、重启恢复锚点）、source fallback、我的喜欢歌单、`favoriteSongKey`/`isLiked` 按原曲判定 | `src/store/GlobalPlayStatus.ts`, `src/components/Play/PlayMusic.vue`, `src/components/Music/SongVirtualList.vue`, `src/utils/audio/globaPlayList.ts` |
| 音源、切源、源切换、wyy、mg | current source, plugin candidates, fallback, source identity | `src/utils/audio/audioHelpers.ts`, `src/tauri-bridge.ts` |
| 音质、可用音质、下载音质、320K、无损 | preferred quality, plugin qualitys, declared quality, download source | `src/utils/audio/qualityAvailability.ts`, `src/utils/playlist/playlistManager.ts` |
| 播放慢、点播没反应、播客播放 | URL resolution, media gateway, native audio, MPV, sidecar latency | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/mediaGateway.ts` |
| 切歌慢、上一首、下一首、飞牛 401 | cache-hit syntax, Feiniu stream proxy, prev/next immediate | `src/utils/audio/globaPlayList.ts`, `src/tauri-bridge.ts`, `src-tauri/src/commands/media_stream_proxy.rs` |
| 快捷键、全局热键、自定义快捷键、媒体键、系统原生媒体键、键盘上一首下一首、F7 F8 F9、CommandOrControl 跨平台、启动自动播放 | global hotkeys, native media keys (OS-adapted), Now Playing, autoPlayOnLaunch | `src-tauri/src/now_playing.rs`, `src-tauri/src/hotkeys.rs`, `src/components/Settings/HotkeySettings.vue`, `src/store/playSetting.ts` |
| 首次播放慢、启动后点播慢 | plugin worker prewarm, legacy initialize channel, sidecar initialization dedupe | `src/main.ts`, `src/tauri-bridge.ts`, `sidecar/services/plugins/index.mjs` |
| 发现慢、歌单慢、播客加载慢 | request sequencing, stale response, session cache, concurrent fetch | `src/views/music/find.vue`, `src/views/music/podcast.vue`, `src/utils/cache/sessionCache.ts` |
| 桌面歌词、歌词锁定、双排歌词 | lyric window lifecycle, logical pixels, drag, resize, reveal | `src-tauri/src/commands/lyric_window.rs`, `src/views/DeskTopLyric/DeskTopLyric.vue` |
| Dock、底栏、全屏播放、卡顿 | dock layout, full player transition, visualizer, background | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` |
| 全屏手势、双指滑、捏合全屏、封面模式、黑胶、手势闪退 | two-finger cover/vinyl swipe, pinch window fullscreen, frontend-only | `src/components/Play/FullPlay.vue`, `src/store/playSetting.ts` |
| 启动动画、欢迎页化开、星空衔接、进主页动画 | welcome dissolve overlay, home reveal | `src/views/welcome/index.vue`, `src/App.vue` |
| 底栏进度一格一格、进度条跳、匀速进度 | dock bar compositor remaining-duration animation; Pinia/mpv clock stays 1s | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` |
| 全屏内存不回落、退出全屏内存、最小化内存、回主页内存 | hide/minimize release FullPlay heavy tree; list covers keep hot layer decoded, drop cold decoded bitmaps; KeepAlive max=1 while hidden | `src/components/Play/FullPlay.vue`, `src/components/sImage.vue`, `src/views/home/index.vue` |
| 全屏底栏要点两下、Dock 唤醒、自动隐藏底栏 | idle dock wake strip, pointerdown, WKWebView transform hit-testing | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` |
| 窗口按钮、最大化、最小化、关闭、设置点不了、标题栏拖拽 | window drag strip, TitleBarControls hit-testing, FullPlay overlay stacking | `src/App.vue`, `src/components/TitleBarControls.vue`, `src/components/Play/FullPlay.vue`, `src/utils/windowDrag.ts` |
| 播客封面变大、一排 4 个封面撑大、播客网格 | 固定封面轨道 `--cover-size`，不用 `1fr` 撑满 | `src/views/music/podcast.vue` |
| 启动更新弹窗、欢迎页检查更新、启动界面弹窗 | 欢迎页不再自动 `checkForUpdates`；设置里仍可手动检查；桌面后台检查由 `src/main.ts` 定时启动，更新器配置见 `src-tauri/tauri.conf.json` | `src/main.ts`, `src/services/autoUpdateService.ts`, `src/tauri-bridge.ts`, `src-tauri/tauri.conf.json` |
| 快进 CPU、拖进度 CPU、seek 占用 | 拖动只改 UI，松手才 `nativeSeek`；短峰来自 mpv 重新解码 | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` |
| 音效点一下等一下、环绕房间卡、响度标准延迟 | mpv 带标签滤镜增量替换，换档只换 `@loud`/`@sur` | `src-tauri/src/commands/mpv_player.rs`, `src/utils/audio/nativePlayback.ts` |
| 麦克风权限、启动弹窗、均衡器、高级音效、MPV lavfi | startup microphone permission, mpv audio filters, bass/surround/loudness | `src/App.vue`, `src-tauri/src/commands/mpv_player.rs`, `src/utils/audio/nativePlayback.ts` |
| 换输出设备没声、蓝牙连/断没声、睡眠唤醒没声、音频不跟随系统 | macOS CoreAudio AO 静默死亡恢复:`devicechange`+`ceru-wake` 触发 `mpv_reload_audio_output`，`aid` 循环重建 AO（单飞+1.5s 冷却+失败软处理） | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/tauri-bridge.ts` |
| 环绕、卷积、混响、afir、IR | WebKit-normalized surround IR, afir dry/wet mix | `src-tauri/src/commands/mpv_player.rs` |
| 内存、CPU、进程占用 | sidecar lifecycle, Rust buffers, cache growth, image cache | `src-tauri/src/commands/node_sidecar.rs`, `sidecar/index.mjs`, `src/utils/cache/sessionCache.ts` |
| CPU 160%、localhost 70%、倍速死循环、canplay 刷屏 | mpv playback rate loop, custom-protocol IPC storm, hot log `set_rate` | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/PlayMusic.vue` |
| localhost 400MB、内存、封面解码、hover 模糊底 | list covers decode 96, dock 128, cards 384; cold decoded bitmaps release on hide; HTTP cache remains | `src/utils/coverThumb.ts`, `src/components/sImage.vue`, `src/views/home/index.vue` |
| 设置 CPU、设置页切模块、插件管理占用 | 设置分类按需挂载，切走即卸载，设备扫描有列表就跳 | `src/views/settings/index.vue`, `src/views/settings/sections/PluginSection.vue`, `src/views/settings/sections/PlaybackSection.vue` |
| 插件、插件配置、插件安装 | plugin registry, sandbox, worker, source mapping | `sidecar/services/plugins/index.mjs`, `src/utils/plugin/pluginSandbox.ts` |
| 插件在线升级、更新失败、浏览器打不开 | plugin update download validation, system browser fallback | `src/components/PluginNoticeDialog.vue`, `src/tauri-bridge.ts` |
| 洛雪插件、洛雪歌单、导入失败、设置页空白 | lx includes check, `.lxmc` gzip playlist parsing, convertEventDrivenPlugin, pluginInfo fallback | `src/utils/playlist/playlistExportImport.ts`, `src/tauri-bridge.ts`, `src/components/Settings/plugins.vue` |
| 查重清理、歌单重复、一键清理、按建议勾选 | duplicate groups expanded, keep/delete per song, selected cleanup | `src/components/Music/DuplicateSongsDialog.vue`, `src/views/music/list.vue` |

## Architecture At A Glance

```text
Vue view/component
  -> src/tauri-bridge.ts
  -> Tauri invoke
  -> src-tauri/src/commands/*
  -> Node sidecar request
  -> sidecar/services/*
  -> plugins or migrated Electron music SDK
  -> response event or JSON result back to the renderer
```

Playback follows the same boundary, but audio output may use the Web Audio
element path, native audio commands, the media stream proxy, or MPV. Always check
the Electron reference before changing ordering, fallback, or timing.

## Key Entry Points

| Area | Path |
| --- | --- |
| Frontend bootstrap | `src/main.ts` |
| Root application shell | `src/App.vue` |
| Router | `src/router/index.ts` |
| Tauri compatibility bridge | `src/tauri-bridge.ts` |
| Node sidecar entry | `sidecar/index.mjs` |
| Plugin service | `sidecar/services/plugins/index.mjs` |
| Migrated music SDK | `sidecar/services/musicSdk/index.mjs` |
| Download service | `sidecar/services/download/index.mjs` |
| Rust app registration | `src-tauri/src/lib.rs` |
| Rust command index | `src-tauri/src/commands/mod.rs` |
| Global hotkeys | `src-tauri/src/hotkeys.rs`, `src-tauri/src/now_playing.rs` |
| Desktop lyric window | `src-tauri/src/commands/lyric_window.rs` |
| Sidecar IPC | `src-tauri/src/commands/node_sidecar.rs` |
| Media stream proxy | `src-tauri/src/commands/media_stream_proxy.rs` |

## Graph Outputs

- Machine-readable graph: `graphify-out/graph.json`
- Generated audit report: `graphify-out/GRAPH_REPORT.md`
- Interactive graph: `graphify-out/graph.html`
- Community labels: `graphify-out/.graphify_labels.json`
- Curated agent map: `TOP_GRAPH.md`
- Maintenance runbook: `docs/AI_GRAPH_MAINTENANCE.md`

The current `graph.html` is an aggregated community view because the graph has
more than 5,000 nodes. That is intentional and keeps the browser view usable.
Use `graphify query` or `graphify explain` for node-level traversal.

## Indexing Scope

- Code is represented by deterministic AST extraction.
- Project Markdown, HTML, and AGENTS knowledge files have semantic extraction.
- Static icon/image assets are represented as paths and references, not as
  individually interpreted design artifacts.
- Generated schemas and minified support files may be present in the graph, but
  they are not product behavior. Prefer the curated Top Graph for architecture.

## Known Graph Health Note

The first full extraction reported AST-level duplicate endpoint collapse,
self-loop, and dangling-edge warnings. The graph remains usable for navigation,
but a future maintenance pass should prune generated or minified sources before
treating raw edge counts as exact.

## Maintenance Log

| 2026-10-13 | 修复「多端同步/插件设置里输入框（服务器地址、端口、绑定码、密码、访问安全码等）不能鼠标拖选复制」：`src/assets/base.css` 全局 `html,body,#app { user-select: none }` 被 input 继承（WKWebView 对输入框同样尊重继承的 user-select），且全局 `*::selection { background: transparent !important }` 把选中高亮做透明，双重导致拖选不可用。修复（纯 CSS 新增两条规则，不改任何 JS/模板/动效）：① `input, textarea, [contenteditable="true"] { user-select: text; -webkit-user-select: text; }` 恢复全部输入框的鼠标拖拽选择（`src/main.ts` 的 selectstart 拦截器本就排除 input/textarea，JS 无需改动）；② `input::selection, textarea::selection, [contenteditable="true"]::selection { background: Highlight !important; color: HighlightText !important; }` （特异性高于全局透明选区规则，选区高亮跟随系统主题可见）。密码框为 `type="password"`（浏览器层面不可选），走 TDesign t-input 自带眼睛图标点成明文后即可拖选，属标准做法。版本号 1.0.5 → 1.0.6（`package.json` 唯一来源，`src-tauri/Cargo.toml`/`Cargo.lock` 同步对齐）。 | 纯 CSS + 版本号改动，不涉及架构/数据流/执行路径；`graphify update .` 增量重建（10739 nodes / 21208 edges / 752 communities），`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify export html` 重新生成 graph.html 社区聚合视图。拖选行为待 v1.0.6 桌面包（desktop-v1.0.6 tag 流水线发布 GitHub + Gitee）出包后实测确认。 |
| 2026-10-12 | 补发 v1.0.5 到 Gitee + 加固 Gitee 上传脚本抗超时。背景：最新一次 workflow_dispatch（run 38200118182）里 GitHub 侧 `desktop-latest` 发布成功，但「发布到 Gitee desktop-latest（必须成功）」步骤在上传第一个 ~99MB 安装包时报 `TimeoutError: The write operation timed out` / `urllib.error.URLError: <urlopen error The write operation timed out>` 整任务失败——根因是 GitHub 境外运行器往 Gitee 上传大文件被限速、socket 写阻塞超时（非令牌、非"可选跳过"：该步骤早在 commit 3222376 就已改为 `if: always()` + 无 continue-on-error 的强制必跑，`GITEE_RELEASE_TOKEN` Secret 也已配置）。应急：从本机 Mac（国内直连 Gitee 正常）用 `scripts/ci/publish-gitee.py` 把 GitHub `desktop-latest` 的 `shuxiamusic_1.0.5_aarch64.app.tar.gz`+`.sig`+`.dmg`+`latest.json`（latest.json 仅把下载地址前缀换成 Gitee，version/signature/pub_date 原样）直接传上 Gitee `songsong2020/shuxiamusic-desktop-release` 的 `desktop-latest`。加固：`scripts/ci/publish-gitee.py` 的 `upload()` 从「整包读进内存单发」改为「multipart 落临时盘按文件流发送 + 最多 5 次重试 + 指数退避」（新增 env `GITEE_UPLOAD_RETRIES`/`GITEE_UPLOAD_BACKOFF`；4xx 不重试直接失败、5xx/超时/网络错才退避重试），降低境外运行器再超时的概率。Gitee 令牌存本机仓库外 `~/.config/ceru/gitee_token`（chmod 600，不入库）。 | `python3 -m py_compile scripts/ci/publish-gitee.py` 通过；Mac 实跑上传 4 文件全部成功；校验 Gitee `desktop-latest` assets 现含 app.tar.gz/.sig/.dmg/latest.json（+自动源码包）；`curl` 下载 Gitee `latest.json` 读到 `version 1.0.5`、url 指向 Gitee；`curl -I` Gitee app.tar.gz 返回 HTTP 200、Content-Length 99140069（与本地一致）。索引：仅 CI 发布脚本改动，不涉及应用代码图的 god/hub 节点、社区归属、跨模块数据流或执行路径拓扑，**未重跑 graphify 全量产物**，仅追加本日志。 |
| 2026-10-12 | 修复双平台发布流水线「Publish 步骤失败 + Gitee 被整段跳过」。真正根因是 **softprops/action-gh-release@v2 的 `token` 输入默认 `${{ github.token }}`**（Actions 自动令牌，只能写当前 `shuxiamusic-desktop` 仓库），工作流原本只设了 `env.GITHUB_TOKEN: ${{ secrets.RELEASE_REPO_TOKEN }}` 并不会覆盖该默认输入；于是发布时实际用自动令牌去跨仓库写**公开**的 `maiga512/shuxiamusic-release`——读得到（"Found release id=409754121"）但写不动，报 `Resource not accessible by integration`。「校验发布令牌权限」步骤查的是 `RELEASE_REPO_TOKEN` 的协作者角色（admin，正确），但 softprops 根本没用这个令牌，所以给了假绿灯。修法：`.github/workflows/desktop-release.yml` 把 PAT 改成通过 `with: token: ${{ secrets.RELEASE_REPO_TOKEN }}` 显式传入（删掉无效的 `env.GITHUB_TOKEN`）。同时把 `RELEASE_REPO_TOKEN` 换成 repo 作用域的经典 OAuth 令牌（`gho_`，身份 maiga512，已本地 `curl -X PATCH` 实测 HTTP 200 可写该仓库 Release），确保作为 token 输入时具备 contents:write。另：Gitee 是国内更新主通道、必须成功——Gitee 步骤加 `if: ${{ always() }}`（GitHub 失败也照跑）、去掉 `continue-on-error: true`（Gitee 失败即整任务失败、fail loud）；`scripts/ci/publish-gitee.py` 把「缺 GITEE_TOKEN 时 exit 0 静默跳过」改为 `::error:: exit 1` 硬失败。注：GitHub `desktop-latest` 其实在 2026-10-11 已有可用 v1.0.5 产物（dmg+app.tar.gz+latest.json），本次修复主要为跑通整条流水线并补上 Gitee 通道。 | gh（gho_）令牌本地实测可读+可写 `maiga512/shuxiamusic-release` 的 `desktop-latest`（PATCH HTTP 200）；5 个 Secret 齐备。修复后需触发一次全新 workflow_dispatch（会重编 macos-arm64）端到端验证 GitHub 与 Gitee 两侧 `desktop-latest` 都产出 `latest.json`+安装包。索引：仅 CI 发布策略/脚本改动（工作流 YAML + 发布脚本），不涉及应用代码图的 god/hub 节点、社区归属、跨模块数据流或执行路径拓扑，**未重跑 graphify 全量产物**，仅追加本日志；如需严格对齐可执行 `graphify update .` 增量重建。 |

| 2026-10-12 | 两处行为澄清修复。①**后台更新检查全程静默**：`src/services/autoUpdateService.ts` 新增 `checkInFlight`/`checkIsSilent`/`checkToken`（默认 `checkIsSilent=true`，用完即复位），`checkForUpdates(options?:{silent?})` 区分手动/后台；`onUpdateNotAvailable` 只在手动检查（`silent=false`）时弹「已是最新」，`onError` 只在「静默检查进行中」时压掉（下载等其它阶段报错照常弹），`onUpdateAvailable` 不变（有新版无论来源都照常走下载+提示）。`src/main.ts` 的 `checkForUpdatesInBackground` 改为动态 `import` 走 `autoUpdateService.checkForUpdates({silent:true})`（避免顶层静态导入在 `createTauriBridge()` 建好 `window.api` 之前就实例化服务）。效果：每 6h 的后台检查不再弹「已是最新」/检查报错；只有「关于」页手动点「检查更新」才提示已是最新。②**完全关闭后重启只按「启动软件后自动播放」决定起播**：`src/utils/audio/globaPlayList.ts` 启动恢复里删掉 `wasPlayingAtExit`，`shouldAutoStart` 从 `autoPlayOnLaunch || wasPlayingAtExit` 收窄为仅 `usePlaySetting().autoPlayOnLaunch`——重启只恢复上次的歌+进度并保持暂停，不再因「退出时正在播」续播（有意与安卓端行为不一致）；缩小/恢复窗口不重跑该初始化，暂停状态按运行时 `isPlay` 原样保持。注：`resumePlaybackAfterAudioSessionChange`（监听 `ceru-audio-session-ready`）此前已随「启动不抢麦」改为死代码（事件不再 dispatch），本次未触碰。 | `npx vue-tsc --noEmit` 全量通过（exit 0，无类型错误）；`ReadLints` 三文件（autoUpdateService.ts/main.ts/globaPlayList.ts）均无诊断。更新弹窗静默/重启暂停保持需桌面环境实测确认。索引：局部逻辑改动，不涉及 god/hub 节点、社区归属、跨模块数据流或执行路径拓扑，**未重跑 graphify 全量产物**，仅追加本日志；如需严格对齐可执行 `graphify update .` 增量重建。 |
| 2026-10-11 | 修复「问题1:音频设备不跟随系统 / macOS CoreAudio 输出静默死亡」(此前多条日志记为「问题1仍挂起未动」)。现象:系统切换默认输出设备、蓝牙耳机连/断、`coreaudiod` 重启或睡眠唤醒后,mpv 解码与时钟照常推进但没有声音——AO(audio output)被设备切换噎死,必须彻底重建才恢复。四处改动:①**Rust 恢复原语**——`src-tauri/src/commands/mpv_player.rs` 新增 `reload_audio_output(path)`:读当前 `aid`,先设 `"no"` 再还原,可靠拆掉并重建整条音频链(含 AO),保留 demuxer 缓存与播放位置、不重开网络流(实测 mpv 0.41:直接重设 `audio-device` 同值是 no-op 不 reinit,`aid` 循环才会);包成 `#[tauri::command] mpv_reload_audio_output`,在 `lib.rs` 注册、`tauri-bridge.ts` 暴露 `mpv.reloadAudioOutput()`。②**前端触发**——`src/utils/audio/nativePlayback.ts` 的 `installListeners` 里监听 `navigator.mediaDevices` 的 `devicechange`(800ms 防抖,覆盖蓝牙连断/插拔/coreaudiod 重启),并在既有 `ceru-wake` 唤醒事件里追加一次主动重建(覆盖睡眠唤醒)。③**守卫**——`reloadNativeAudioOutput()` 单飞(`reloadingAudioOutput`)+ 1.5s 冷却(`AUDIO_RELOAD_COOLDOWN_MS`,蓝牙切换常瞬间连发多次 `devicechange`,只重建一次避免可听断续)+ **失败软处理**(AO 重建失败只 `console.warn`,绝不冒充播放错误去触发换源/`tryAutoNext`);重建后 `syncClockFromMpv()` 对齐一次本地时钟。④两个监听均登记 cleanup(含清防抖定时器),不泄漏。**已知边界**:不覆盖「两设备都在、仅在系统设置里切默认输出」这种不增删设备的情形(WebView 收不到 `devicechange`),要完美覆盖需 Rust 侧挂 CoreAudio `kAudioHardwarePropertyDefaultOutputDevice` 监听(更大改动,未做)。 | `cargo check` 通过(仅既有 96 warnings,无新增);`npx vue-tsc --noEmit` 全量通过(exit 0,无类型错误)。真实设备切换/蓝牙连断/睡眠唤醒的恢复效果需**重新出包**(`npm run tauri:build:macos`)后在桌面环境实测——当前仅编译/类型验证,未运行时验证。索引:Graphify 增量重建 10724 nodes / 21193 edges / 750 communities;`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label` 重建 `graph.html`(约 10MB);`graph.json`/`.graphify_labels.json` JSON 校验通过;`TOP_GRAPH.md` "Playback And Media" 已补 AO 静默死亡恢复段。 |
| 2026-10-11 | 收藏锚点扩展到「跨源回退 + 重启 + 列表心形」，彻底修复「QQ 收藏的歌换源到酷我后收藏状态丢失」。此前（2026-10-09）锚点只活在内存（`GlobalPlayStatus.player.favoriteAnchor`），只覆盖底栏；两个缺口未补：①重启后持久化队列项已是换源后的酷我实例，`initPlayback→playSong` 把锚点设成酷我→掉星；②播放队列列表（`SongVirtualList.vue`）的心形按队列项自身 `source:songmid` 判定，换源项显示未收藏。本次三处改动：①`globaPlayList.ts` 新增 `stampOriginalIdentity(previousSong,nextSong)`，在 `replaceCurrentSongInList` 换源替换队列项时，把原收藏身份（source/songmid/hash/name/singer/albumName/albumId/img，多次换源保留最早的）盖到新项 `_originalIdentity` 上，随 `list` 一起 `JSON.stringify` 持久化；②`playSong` 顶部 `setFavoriteAnchor((song as any)._originalIdentity || song)`，重启恢复时从队列项携带的原身份还原锚点；③`SongVirtualList.vue` 的 `favoriteSongKey`/`onToggleLike` 优先用 `_originalIdentity` 规范化（`isLiked` 命中原曲收藏键、增删喜欢操作原收藏记录），并新增 `displaySource(song)=_originalIdentity?.source||source` 用于列表音源标签——换源后的队列项仍显示原收藏音源（如 QQ），不暴露后台实际换到的播放音源（如酷我），前台只呈现一个身份。取消喜欢的队列移除 `evictUnlikedSongFromPlayback` 仍传当前队列项（换源后是酷我项，命中正确、能切下一首），不改。前台只呈现一个身份、不随音源漂移；后台换源纯播放实现。 | `npx vue-tsc --noEmit` 全量通过（exit 0，无类型错误）；`ReadLints` 两文件均无诊断。重启后恢复锚点、队列列表心形需桌面环境实播确认。索引：局部收藏/回退数据流改动，不涉及 god/hub 节点、社区归属或执行路径拓扑，**未重跑 graphify 全量产物**，仅追加本日志 + 更新任务路由表「收藏」行；如需严格对齐可执行 `graphify update .` 增量重建。 |
| 2026-10-11 | 结合落雪（LX Music）换源思路，把音源「硬失败拉黑」从**整源 120s** 收窄为**源+歌曲** 维度 120s：`src/utils/audio/globaPlayList.ts` 的 `_blockSource`/`_isSourceHardBlocked` 新增 `song` 参数、key 由 `source` 改为 `${source}::${songIdentity}`（新增 `_getHardBlockKey`），`tryUrlSequential` 的 4 处调用相应传入当前歌/候选歌。根因：鉴权/版权/403/VIP 这类确定性失败通常是「这首歌在这个源上没有」而非「这个源废了」，原整源封 120s 会把一首版权歌连累成整个源 2 分钟内对所有歌都不可用（用户反馈的「一竿子打死」）。落雪本身不跨歌封源、只在本次回退链内跳过已试源，此改即对齐该思路。正向记忆（成功源替换队列项 `replaceCurrentSongInList` + SQLite URL 持久缓存 + 预取/候选内存缓存）、429 限流 `_isThrottled`、失速看门狗、起播竞态守卫 `currentPlayRequestId` 全部保持不变。 | `npx vue-tsc --noEmit` 全量通过（exit 0，无类型错误）；`ReadLints` 无诊断。运行时成功率/切歌表现需桌面环境实播确认。索引：局部播放回退逻辑改动，不涉及 god/hub 节点、社区归属、跨模块数据流或执行路径拓扑，**未重跑 graphify 全量产物**，仅追加本日志 + 同步 `CONTEXT_HANDOFF.md` 第 4 点；如需严格对齐可执行 `graphify update .` 增量重建。 |
| 2026-10-11 | 【硬约束登记，不改代码】音源取链**永不并行**：音源 API 有每日请求配额，超量会把整个源封到当天结束、真实成功率反而崩。`getSongRealUrl`/插件 `musicUrl`/候选 `search` 一律保持顺序、省请求；禁止竞速、禁止并发扇出，也禁止再把「并行竞速」当性能建议提出。提高成功率只能靠「少发请求」（正/负缓存、记住可用源、本地文件优先、更快判死链），不能靠多发。已在 `TOP_GRAPH.md` 的 "Source And Plugin Selection" 落为 HARD CONSTRAINT。 | 仅文档/约束登记，不动代码；不涉及代码图拓扑，未重跑 graphify，仅追加本日志。 |
| 2026-10-11 | 修复「在线播放中途中断就不播、下一首经常不来、成功率很低」（问题2；音频设备不跟随系统的问题1仍挂起未动）。四处改动：①**失速看门狗复活**——`src/utils/audio/globaPlayList.ts` 的 `runStallCheck` 原本读 `s1.backend_ready`/`s1.current_time`（下划线），而 Rust 的 `MpvSnapshot` 用 `serde(rename_all="camelCase")` 序列化，`invoke('mpv_get_state')` 回来的是 `backendReady`/`currentTime`，于是第一道 guard `backend_ready!==true` 永远成立直接 return，整套「加载成功但无声的死链」检测从未触发（同一下划线 bug 也存在于 `tickPlaybackPosition` 的反向自愈，归属问题1，本次**未动**）。改为同时兼容驼峰/下划线（`mpvBackendReady`/`mpvCurrentTime` 辅助函数）。②**缓冲不再误判死链**——`src-tauri/src/commands/mpv_player.rs` 的 `MpvSnapshot` 新增 `paused_for_cache`/`core_idle` 字段并 `observe_property`（`paused-for-cache`/`core-idle`）、在 `handle_property_change` 落值；看门狗 `mpvBuffering()` 命中（在线缓冲/空转而非用户暂停）即放行，避免把正常缓冲判成死链。③**中途失效断点续播**——`applyPlayableUrl(url, startAtOverride?)` 新增可选续播位置；`currentPlaybackErrorHandler` 进入时记 `resumeAt = Audio.currentTime`，Stage1 刷新当前源与 Stage2 候选换源都从断点续播而非从 0 重放。④**mpv 模式恢复下一首预取**——起播后 `prefetchNextTrack()` 不再被 `!isNativePlaybackActive()` 门控（`_setPrefetchSlot` 仅在非 native 时写 `<audio>` 副槽），下一首直链提前解析进内存/持久缓存，减少「推进时现场重解析失败＝下一首不来」。⑤**长音频/播客不再静默放弃**——`tryAutoNext` 去掉 `isLongProgramSong` 这道静默 return 门（换源对播客的禁用仍在 `tryUrlSequential` 内，不会把节目当歌乱跳），长节目失败也推进队列。 | `cargo check` 通过（仅既有 96 warnings，无新增）；`npx vue-tsc --noEmit` 通过（无类型错误）；`ReadLints` 两文件均无诊断。运行时验证（真实起播成功率、看门狗命中/缓冲放行占比、断点续播、下一首预取命中）需在可监听本机端口的桌面环境采集日志确认。索引：局部播放逻辑 + mpv 状态字段改动，未触及 god/hub 节点或跨模块数据流拓扑，**未重跑 graphify 全量产物**，仅追加本日志；如需严格对齐可执行 `graphify update .` 增量重建。 |
| 2026-10-10 | 根治「每次重启/换版本后系统权限反复弹窗」：根因不是老版本不兼容，而是打包一直用 **adhoc 签名**（`codesign -s -`，`TeamIdentifier=not set`、DR 为 `cdhash H"…"`）。macOS TCC 隐私授权按「签名身份/指定要求(DR)」记忆，adhoc 的 cdhash 每次构建都变 → 系统每次都当成全新 App → 已授的麦克风/本地网络(DLNA 投屏「查找并连接本地设备」) 全部重问。改为 **稳定自签名证书**：在 login 钥匙串新建 10 年期 codeSigning 证书 `Ceru Music Self-Signed`（SHA-1 `3FCB56609A8A5577C9CBBC19F53C04F94D764A77`，OpenSSL 3 生成、`openssl pkcs12 -legacy` 导出以兼容 `security import`），`src-tauri/tauri.conf.json` 的 `bundle.macOS.signingIdentity` 设为该证书，以后 `tauri build` 自动用它签；已装 `/Applications/树夏Music.app` 已用该身份重签（DR 变为 `identifier "com.cerumusic.tauri" and certificate root = H"3fcb…"`，跨构建稳定）。效果：换证书这一次会再弹一轮授权，允许后因 DR 恒定、后续我出的新版本之间不再重弹。麦克风仍保持按需（听歌识曲/设备名枚举用户触发），**不**在启动期抢麦（否则重犯 AirPods 被切 HFP 的 bug）。证书自签名未加入信任，故首次打开仍是「未验证开发者」需右键→打开一次；本地网络(DLNA) 在个别新系统上仍可能偶发重问（系统侧已知问题）。彻底消除需 Apple Developer ID 签名 + 公证（待用户提供账号/证书）。 | `codesign --verify --deep --strict` 通过（`valid on disk` + `satisfies its Designated Requirement`，`Authority=Ceru Music Self-Signed`，不再是 adhoc）；按名字解析签名成功，确认 `tauri build` 可用该 `signingIdentity`；已干净重启（新进程 pid 来自新签名二进制）。索引：配置/签名流程改动（仅 `src-tauri/tauri.conf.json` 加 `signingIdentity`），不涉及代码图拓扑/数据流/执行路径，**未重跑 graphify 全量产物**，仅追加本日志。 |
| 2026-10-10 | 修复「连 AirPods 等蓝牙耳机时播放没声音 + 耳机捏停/双击切歌失灵」：根因是 App 启动/首播后自动申请麦克风权限，`src/App.vue` 的 `ensureStartupMicrophonePermission()` 里 `permissions.requestMicrophone()` → `getUserMedia({audio:true})` 一旦被调用，就把已连接的 AirPods 从音乐模式(A2DP)切进通话模式(HFP/SCO)，导致：①音乐输出被系统甩到扬声器、耳机没声；②mpv 的 CoreAudio 输出被设备切换噎住、播放时钟卡死；③耳机触控退化成通话控制、媒体键失效。播放器本身不消费麦克风流（听歌识曲 `recognize.vue`/`AudioMatch.vue`、音频输出设备选择器 `audioOutput.ts` 才需要，且均为用户主动触发），故把启动期这次无谓的抢麦改为空操作：`ensureStartupMicrophonePermission` 不再调用 `requestMicrophone()`、不再广播 `ceru-audio-session-ready`（该事件原本是用来从抢麦打断中恢复播放的，现在没有打断也就无需恢复）。`scheduleDelayedMicrophoneRequest`/`watch(isAppReady)` 调用链保留（守卫标志仍置位），其余 mic 入口不动（surgical）。 | `npm run build`（vue-tsc + vite）通过（built in 2m17s，无类型错误）；`npx tauri build --bundles app` 成功（exit 0，仅末尾 `TAURI_SIGNING_PRIVATE_KEY` 未设的更新包签名告警，不影响 .app）。已重打包装机到 `/Applications/树夏Music.app`（adhoc 重签、`codesign --verify` 通过）并清理掉一个 killall 未回收的残留 mpv + 过期 IPC socket 后干净重启。索引：此次为局部逻辑改动（不涉及 god/hub 节点、社区归属、跨模块数据流、执行路径或播放/持久化架构），**未重跑 graphify 全量图产物**，仅追加本维护日志；如需严格对齐可执行 `graphify update .` 增量重建。 |
| 2026-10-10 | DLNA 本地 HTTP 服务器改按需启动（安全加固，不改投屏功能/观感/播放链）：`src-tauri/src/commands/dlna.rs` 的 `init()` 不再在启动时 `thread::spawn(start_local_server)` 无条件 `TcpListener::bind("0.0.0.0:0")` 常开 accept 循环；改为新增 `ensure_local_server()`（幂等、`server_started: AtomicBool` + `compare_exchange` 抢占启动权、同步绑定取端口后再 spawn `run_local_server` accept 循环），仅在 `dlna_play` 真正需要本地取文件 / 本地代理（`file://`、相对路径、`127.0.0.1`/`localhost` 三个分支）时才首次绑定；纯 http(s) 直链投屏分支从不需要本地服务器。SSDP 发现仍按需绑临时 UDP、AVTransport/RenderingControl 仍走 reqwest，均未改。效果：不投屏时不再暴露 0.0.0.0 局域网端口（原观测 61082），首次投屏本地文件后端口在会话内保持（避免打断进行中的投屏）。 | `cargo check` 通过（仅既有 96 warnings，无新增、无 dlna 未用告警）。Graphify 增量：10707 nodes / 21135 edges / 747 communities；`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label` 重建 graph.html（约 10MB）。 |
| 2026-10-09 | 修复切源后收藏星丢失：收藏/喜欢状态从“跟随播放实例（音源+songmid）”改为锚定“用户选中的歌”（收藏锚点）。`GlobalPlayStatus` 新增 `player.favoriteAnchor` + `setFavoriteAnchor()`；`globaPlayList.ts` 的 `playSong` 选中歌时设锚点，自动换源路径（`replaceCurrentSongInList`/`applyCurrentSongInfo`）不再触碰锚点；`PlayMusic.vue` 的 `refreshLikeState`/`onToggleLike` 按锚点做 `hasSong` 判定与收藏增删（锚点缺失时退回当前播放歌），取消收藏的队列移除仍用当前播放实例（fallback 后队列里是 fallback 歌，能正确命中切下一首）。前端收藏展示从此不随音源漂移：收藏的星一直在，取消收藏就从“我的喜欢”消失，与后台换什么源无关。 | `npx vue-tsc --noEmit` 通过。Graphify：内部函数不在当前图粒度内（与 `updatePlayerInfo` 等同级处理），09:40 重建产物已覆盖当前代码（10698 nodes / 21093 edges / 760 communities）。 |
| 2026-10-09 | 左侧栏整栏下移：`src/components/layout/HomeLayout.vue` 的 `.sidebar-content` 顶部 padding 0.6rem → 2.2rem，「树夏Music」标题与发现/播客/歌单/本地/下载 菜单整体离开窗口顶部（承接同日「标题居中 + 菜单下移」）。纯 CSS 改动，不涉及架构/数据流。 | SCSS 编译验证通过；`graphify update .` 报告无代码图拓扑变化，graph 产物沿用 2026-10-09 早些时候的重建（10692 nodes / 21093 edges / 760 communities）。 |
| 2026-10-09 | 左侧栏布局微调：`src/components/layout/HomeLayout.vue` 的 `.sidebar-content .logo-section` 加 `justify-content: center` + `text-align: center`，「树夏Music」标题在 15rem 侧栏内水平居中；`margin-bottom` 0.9rem → 1.5rem，发现/播客/歌单/本地/下载 菜单整体下移、与标题拉开间距。纯 CSS 改动，不涉及架构/数据流。 | SCSS 编译验证通过（vite build）。Graphify AST 增量：10692 nodes / 21093 edges / 760 communities；`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label` 重建 graph.html（约 10MB）。 |
| 2026-10-08 | 耳机媒体键根因修复 + 喜欢页抖动：`src-tauri/build.rs` 编译期在 `target/<profile>/` 生成 `Info.plist`，让 `tauri dev` 裸跑的可执行文件也有 `com.cerumusic.tauri` bundle 身份（实测此前 `bundleIdentifier` 为 nil，MPRemoteCommandCenter 注册成功但系统永远不会把耳机 AVRCP 指令投过来）；`useSmtc.ts` 播放期 10s Now Playing 心跳 + `now_playing.rs` 封面对象按 URL 缓存；`MEDIA_KEY_BINDINGS` 去掉注册必然失败的 `MediaStop`；`list.vue` 静默刷新改 `mergeLocalSongsInto` 复用行对象、内容一致不写入，`SongVirtualList.vue` 修 `vObserveCover.updated` 反复重观察与封面请求被无谓掐断；`pluginSync.ts` 用 `samePluginConfig` 打断每约 50 秒一次的插件配置保存/worker 重载自激循环。 | `cargo check`、`npx vue-tsc --noEmit` 通过；`npm run tauri:build:macos` 出包；实测启动日志 `init: bundleIdentifier=com.cerumusic.tauri`、`MPRemoteCommandCenter 已注册 toggle/play/pause/next/prev/stop`。 |
| 2026-10-08 | 媒体键恢复 + 全屏背景对齐安卓横屏 + 触控板一甩一切：`hotkeys.rs` 的 `register_media_keys` 恢复全平台注册标准媒体键（macOS 走 SystemDefined CGEventTap 命中即消费，前后台可靠；MPRemoteCommandCenter 保留 Now Playing 展示 + 兜底，debounce 100ms 防双触发）；`FullPlay.vue` 的 `bakeCurrentBackdrop` 对齐安卓横屏 `CarFullPlayerPreviewLayout` 五层打光 + `CoverColorUtils` 色阶（enhanceDesktopMainColor → deep 0.18 / dark 0.35 / light mix white 0.8），光斑半径按舞台宽 px 换算，新增 `bgBaseColorA/B` 纯色兜底层、暂停也烘焙、resize settle 后重烘焙；`onFullPlayWheel` 横滑改滑动段锁存（180ms 断流/方向反转=新段，48px 触发后本段忽略），layout 不再走 300ms 共享冷却。 | `cargo check` 与 `vue-tsc --noEmit` 通过。Graphify AST 增量：10660 nodes / 21022 edges / 746 communities；graph.html 社区聚合（332 节点 / 799 边）。 |
| 2026-10-04 | 修复启动慢 + 歌单/播客/插件加载失败：根因是 `scripts/prepare-sidecar-runtime.mjs` 用 `fs.cp` 复制 `axios`/`iconv-lite` 时未 `dereference`，在 pnpm 工程里复制成了软链，Tauri 打包资源跳过软链导致 bundle 缺这两个包，Node sidecar 一启动就 `ERR_MODULE_NOT_FOUND: axios` 崩掉，进而欢迎页等初始化卡 30s 超时、进主页后各页请求全部超时。已改 `dereference: true`、重跑 prepare 并重新打包替换；sidecar health 返回 ok。 | `node --check scripts/prepare-sidecar-runtime.mjs` 与打包替换验证通过。Graphify AST 增量：10648 nodes / 21002 edges / 758 communities。 |
| 2026-10-04 | 修复横滑切封面后"马上弹回来"：触控板惯性在切完后继续发 `wheel`，又攒到 48px 阈值触发第二次 `applyFullPlayGesture('layout')`，把模式切回。`onFullPlayWheel` 增加 `armed` 锁定 + `GESTURE_REARM_MS=220` 离手计时：触发一次后锁定，任何后续滚轮刷新计时，停顿 220ms 才重新武装，保证一次横滑只切一次。 | `vue-tsc --noEmit` 仅剩 `src/main.ts` Logto 既有报错。Graphify AST 增量：10648 nodes / 21002 edges / 756 communities。 |
| 2026-10-04 | 启动化开收尾：欢迎页最短等待从 2000ms 提前到 1500ms，避免星空播到视觉尾部才切页；`App.vue` 的 welcome dissolve/reveal 从 0.96s `cubic-bezier(0.22,0.61,0.36,1)` 改为 0.72s `linear`，去掉曲线末尾减速造成的“快完成时停顿”。`initPlayback()` 在 `router.replace('/home')` 后延迟 720ms 启动，让 home 挂载和本地播放状态恢复不跟化开动画抢主线程。 | `npx vite build` 通过；`npm run build` 的 `vue-tsc` 仍被既有 `src/main.ts` Logto 重复依赖类型错误挡住，与本次改动无关。Graphify AST 增量：10648 nodes / 21002 edges / 754 communities；`graph.html` 按社区聚合导出（332 社区节点 / 799 跨社区边）。 |
| 2026-10-04 | 双指手势手感与方向收口：横滑判定放宽（去掉 `deltaMode` 硬性检查、阈值 72→48、只要求横向明显占优），单次左/右滑即切一次黑胶/方形封面；捏合改成方向式——放大进真全屏、捏合恢复，方向判断下沉到 `tauri-bridge.ts` 的 `toggleFullscreen(enter)` 用原生 `isFullscreen()` 决定目标状态，避免动画期间前端 `isFullscreen` 滞后漏掉恢复。原 AppKit 手势监听已确认零残留（无 `addLocalMonitor`/`touchesMatchingPhase`/`RcBlock`）。 | `cargo check` 与 `vue-tsc --noEmit`（仅剩 `src/main.ts` Logto 既有报错）通过。Graphify AST 增量：10648 nodes / 21002 edges / 757 communities。 |
| 2026-10-04 | 安卓播放链路性能补齐：`MusicViewModel.kt` 当前源音质最多 3 档降级、有守卫的 Media3 单条预备项快路径、按网络/电量自适应预取；`PersistentPlaybackUrlCache.kt` debounce 落盘与新鲜缓存免探测；`LocalStorage.kt` 进度/队列分写。 | 安卓 `:app:compileDebugKotlin`、`:app:assembleDebug` 通过；`:app:testDebugUnitTest` 被既有 `PlaybackKeepAlivePolicyTest` 阻塞。本仓库 `graphify update .` + `graphify export html` 已执行。 |
| 2026-10-04 | 全屏播放"最大化后还留顶部菜单栏"：`src/tauri-bridge.ts` 的 `toggleFullscreen` 从 macOS `setSimpleFullscreen` 改为原生 `appWindow.setFullscreen`。simple fullscreen 只撑满当前桌面、菜单栏仅自动隐藏，且 `isFullscreen` 不认 simple fullscreen 导致捏合只能进不能出；原生全屏进入独立 Space、真正隐藏菜单栏/Dock，`app-fullscreen-changed` 也能正确回写。 | `vue-tsc --noEmit` 仅剩 `src/main.ts` Logto 重复依赖的既有报错。Graphify AST 增量：10648 nodes / 21002 edges / 756 communities。 |
| 2026-10-04 | 全屏手势收口：按用户要求去掉三指，双指手势改为纯前端实现。删除 `src-tauri/src/lib.rs` 的 AppKit 本地事件监听(`install_macos_fullplay_gestures`、`FullPlayRawEvent`、`fullplay-gesture` 后台线程、`fullplay:gesture-capture`)和桥接 `onFullPlayTrackpadGesture`，前端 `FullPlay.vue` 也移除 native 订阅/捕获开关。双指左右滑走 `wheel`，捏合走 Safari `gesturestart/gesturechange` + `ctrl`+`wheel` 兜底。原生监听原本会吞掉 `magnify` 事件，拆掉后 WebKit 反而能正常收到捏合手势，双指捏合才真正生效。 | `cargo check` 通过；`vue-tsc --noEmit` 仅剩 `src/main.ts` Logto 重复依赖的既有报错。Graphify AST 增量：10648 nodes / 21002 edges / 755 communities；节点超 5000 上限，graph.html 按社区聚合导出(332 社区节点 / 799 跨社区边)。 |
| 2026-10-04 | 全屏手势二次闪退：新报告(16:01 `ceru-music`)栈停在 `_NSSendEventToObservers` → abort，且无 Rust `rust_begin_unwind` 符号，判定为 Objective-C 异常而非 Rust panic（`catch_unwind` 抓不住）。真凶是 `touchesMatchingPhase:inView:`，双指滑动(scroll wheel、phase 非 0)就会触发并在部分触控板抛异常。用 `objc2::exception::catch`（`@try/@catch`）包住这次查询，异常按 0 指处理；`cargo check` 通过。 | 未重编 release（本轮按用户要求只做类型检查）。Graphify 无需刷新（纯函数体内改动，符号图不变）。 |
| 2026-10-04 | 修复全屏播放划手势必闪退：崩溃报告两次都落在 `tao::send_event` → `panic_cannot_unwind` → `abort()`，即 Rust panic 从 AppKit 事件分发栈里跨 `extern "C"` 边界炸穿进程。根因是 `install_macos_fullplay_gestures` 的 NSEvent 本地监听闭包(block2 是 `extern "C-unwind"`)在主线程事件分发里直接跑 `Mutex` 累加并调用 `app_handle.emit`，重入 WebView/取锁都会 panic。改为闭包只读数值入队(`FullPlayRawEvent` + `Condvar`)，累加判断与 `emit` 交给 `fullplay-gesture` 后台线程；`catch_unwind` 兜底保留；`[profile.release]` 由 `panic = "abort"` 改为 `"unwind"`，并在 `run()` 装 panic 日志钩子写到临时目录 `ceru-tauri-panic.log`，release strip 后也能拿到文件行号。 | `cargo check`、`cargo build --release` 通过(96 warnings，均为既有未用代码)。`vue-tsc --noEmit` 仅剩 `src/main.ts` Logto 重复依赖的既有报错。Graphify AST 增量：10656 nodes / 21020 edges / 761 communities；节点超 5000 上限，graph.html 按社区聚合导出(332 社区节点 / 799 跨社区边)。 |
| 2026-10-04 | 续做空转功耗：着色器收起后不再每首取色；频谱/着色器跟窗口最小化停 rAF；隐藏窗口跳过背景烘焙和播客推荐刷新；正式版关掉 MPV 1Hz hot logger；`.dormant` 去掉会砸黑胶/歌词的 `content-visibility`/`contain:strict`。播放链、一起听 ping、媒体键、切歌、缓存尺寸和烘焙画质都没动。 | `vue-tsc --noEmit` 与 `cargo check` 通过。Graphify AST 增量：10588 nodes / 20917 edges / 763 communities。 |
| 2026-10-04 | 启动星空改真正化开进主页：欢迎页不再自己先淡成黑，路由 Transition 让主页先挂在下面，启动层放大模糊淡出。全屏播放手势：双指横滑切黑胶/方形封面，双指捏合切窗口全屏/恢复，三指横滑切左侧面板（封面+歌词 / 全屏歌词）。Mac 三指/捏合走 AppKit 本地监听，WKWebView 另接 ctrl+wheel 与 gesture 事件。 | `vue-tsc --noEmit` 与 `cargo check` 通过。Graphify AST 增量：10607 nodes / 20958 edges / 753 communities。 |
| 2026-10-04 | 功耗优化只保留不碰 UI/动效/播放链的部分：全屏着色器/频谱仅在全屏打开且正在播放时跑 rAF；生产环境关闭 IPC 统计刷新；窗口隐藏时跳过播客扫码轮询和 DLNA 进度同步；全屏卸载时清烘焙定时器。明确不做：降低背景烘焙分辨率/JPEG 质量、激进清空封面缓存、隐藏窗口立刻拆 FullPlay、一起听后台停 ping。 | 不改播放时序与视觉资产；`vue-tsc --noEmit` 通过。Graphify 无需刷新。 |
| 2026-10-02 | 修复多页面无法滚动 / Dock 变窄 / 歌单按钮溢出 / 全屏播放画布错乱：根因是 `src/main.ts` 没有 import `src/assets/base.css`（Electron 在 `main.ts` 第 2 行就导入了它）。`base.css` 定义了三件全局基础：根字号 `html{font-size:min(max(1.4vw,15px),18px)}`、底栏高度变量 `--play-bottom-height: max(min(10vh,80px),70px)`、以及 `*{box-sizing:border-box}` 等重置。缺失后 `--play-bottom-height` 全程 undefined，`HomeLayout .home-container height:calc(100vh - var(...))`、`PlayMusic` 的 dock `height:var(...)`、`FullPlay --cd-width-auto/--height` 等 calc 整条失效，导致 `.mainContent height:0` 的 flex 高度链塌陷（发现/播客/歌单/搜索都无法滚动）、Dock 变窄、歌单右上角按钮溢出窗口、全屏播放背景与黑胶/歌词布局错乱（唱臂探针异常放大）。此前另一个 Agent 把问题归到各页面 overflow（SCROLL_FIX_TEST.md）与功耗优化改动，方向错误。修复：在 `main.ts` 顶部、tdesign 样式之前 `import './assets/base.css'`，与 Electron 对齐。 | 仅补一行样式入口导入，不改架构/数据流/符号图；`vue-tsc --noEmit` 通过，Vite 已热重载确认 base.css 进入模块图且含根字号/dock 变量。Graphify 无需刷新。 |
| 2026-10-01 | 修复全屏播放“只剩唱臂、黑胶/歌词/背景全空白”：根因是 `FullPlay.vue` 休眠优化 `.dormant` 里用了 `content-visibility: hidden` + `contain: strict`，在 macOS WKWebView 下这两个属性开启再关闭会让黑胶唱片(drop-shadow 滤镜+旋转)和 AMLL 歌词(canvas)这类独立合成图层回收不回来，重新打开只剩普通 `<img>` 唱臂能绘制。改为仅保留 `visibility: hidden`（配合 `:not(.is-open)` 已暂停动画，开销足够低）。此前把病因误判为 `isAppWindowState` 窗口可见性误报（JS 逻辑），方向错误；`appWindowState.ts` 的可见性简化保留，无害。 | 纯 SCSS 边界改动，不涉架构/数据流；`npx vite build` 通过。Graphify 无需刷新（未改符号图）。 |
| 2026-10-01 | 全局媒体键去硬编码：删除 `hotkeys.rs` 的 `HARDWARE_FKEY_BINDINGS`（原 F7→上一首/F8→播放暂停/F9→下一首），只注册标准媒体键 MediaPlayPause/TrackNext/TrackPrevious/Stop。上一首/播放暂停/下一首默认交给系统原生：macOS 走 Now Playing(MPRemoteCommandCenter)，Windows 走全局快捷键捕获硬件媒体键；F7–F12 仍可作为自定义键录入。自定义快捷键用 `CommandOrControl`，一套配置在 Mac=Cmd / Windows=Ctrl 自动适配。版本号改为单一来源：`tauri.conf.json` 的 `version` 指向 `../package.json`，`get_app_version` 改读 `app.package_info().version`，关于页/安装包随 `package.json` 一处更新；`Cargo.toml` 版本仅为 Cargo 必填项（已注释说明，不参与展示）。前端去掉 About 页硬编码的 `1.0.0` 回退、更新 F7/F8/F9 相关文案。 | 仅动热键/版本边界；已过 `cargo check` 与 `npm run build`。已同步更新 `TOP_GRAPH.md` Playback And Media 热键流；Graphify 生成文件待下次增量刷新。 |
| 2026-09-30 | 桌面自动更新签名密钥轮换：原 `ceru-updater.key` 密码遗失无法签名，重新生成新 minisign 密钥对（无历史兼容包袱），更新 `tauri.conf.json` 的 `pubkey` 与 `ceru-updater.key.pub`，并写入发布仓 secrets（`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`）。同步配置 `CERU_MPV_WINDOWS_URL`。旧钥匙备份为 `*.old`（gitignore）。 | 仅动发布/签名边界，不涉架构；Graphify 无需刷新。已装 0.1.0 因换钥无法自动升级，需手动装一次 1.0.0，之后自动更新恢复。 |
| 2026-09-22 | Dock/Now Playing 封面链路统一：媒体元数据支持 `coverImgUrl`/`cover`/专辑封面字段，异步复用 `resolveSongCover` 补全并回写当前歌曲，切歌和跨淡入口传入完整歌曲对象；不改变播放时序。 | Graphify 增量刷新；已重新编译并替换 `/Applications/澜音.app`。 |
| 2026-09-22 | 最小化内存：热层封面钉住、冷层只丢解码图、隐藏时 KeepAlive 只留当前页、列表小封面解码 96。不卸整页、不改播放。 | Graphify 增量刷新。 |
| 2026-09-22 | 底栏进度改 compositor 匀速：不提高 Pinia/mpv 时钟；时间文字仍按秒；交叉淡化远端时不再每秒空写标记。 | Graphify AST 增量：7124 nodes / 15982 edges / 332 communities。 |
| 2026-09-23 | 查重清理默认展开全部重复歌曲：每首歌可勾选，右侧保留/删除；一键清理只删勾选项。 | Graphify AST 增量：7129 nodes / 16001 edges / 320 communities；更新歌单查重路由。 |

| 2026-09-25 | 同步修复与启动流程：list.vue 订阅 playlist-updated/ceru-favorites-updated 原地刷新；启动麦克风权限后按原进度自动续播（ceru-audio-session-ready）；服务端 remove 去掉 content_hash 级联、设备 revision 夹紧、事件清理保护慢设备；Android 云端插件脚本落盘 lx_plugins、导入登记 pending、RESTORE 空云端保护。 | 多轮增量；详见 CONTEXT_HANDOFF。 |

| 2026-09-29 | MPV 退出生命周期：真正退出时先摘出 Rust `Child`、释放运行时锁，再直接 `kill + wait`，不再等待可能卡住的 MPV IPC `quit`；关闭到托盘继续保持播放。 | 对照 Electron `src/main/index.ts` / `src/main/services/windowLifecycle.ts`；Tauri 仅适配 Rust 子进程回收。Graphify 更新待本轮文档写入后执行。 |
| 2026-09-30 | 启动恢复时序与失败播放链：欢迎动画和 `/home` 路由完成后才调用 `initPlayback()`；启动恢复统一复用 `playSong()` 的缓存校验、刷新 URL、候选换源与失败自动下一首；MPV 早到错误暂存到当前请求，避免首首失败停在暂停。 | 对照 Electron 欢迎页与播放入口；Tauri 适配仅处理 MPV 事件时序。`npm run build`、sidecar 语法检查、`git diff --check` 通过；Graphify 更新待执行。 |
| --- | --- | --- |
| 2026-09-17 | Initial AI search index and Top Graph created. | Full AST extraction, semantic document extraction, community labeling, `graph.html` export, root rules added. |
| 2026-09-17 | Aligned playback startup with Electron: mapped `service-plugin-initialize-system`, preloaded eligible sidecar plugin workers, deduplicated initialization, and added direct plugin-code reads. | Updated playback aliases and Top Graph flow; Graphify refreshed in the same session. |
| 2026-09-17 | 飞牛登录态持久化、启动同步、封面鉴权代理。 | 更新任务板 `FEINIU-02`/`COVER-01` 为代码已改待验收。 |
| 2026-09-17 | 修复「我的喜欢」为空：`albumId` 字符串解析失败被丢弃。 | 更新 `FAVORITES-01` 为代码已改待验收。 |
| 2026-09-17 | PLAYBACK-01: 切歌计时、飞牛流代理、缓存命中零网络。 | 更新 Playback 流与切歌别名；Graphify 本次刷新。 |
| 2026-09-17 | 飞牛封面改走稳定本地代理，列表滚动和底栏共用浏览器 HTTP 缓存。 | 更新 COVER-01；不改 Top Graph 主架。 |
| 2026-09-17 | PLAYLIST-01 已有歌曲封面回退；PLUGIN-01 修复 NAS schema 截断；VERIFY-01 证据记录。 | 更新任务板全部 P0/P1 为已完成或只读报告完成。 |
| 2026-09-17 | COVER-02：飞牛封面滚动空白和底栏缺图。代理加内存缓存，列表/底栏同步走稳定代理 URL。 | 新增 COVER-02；不改 Top Graph 主架。 |
| 2026-09-17 | 桌面歌词立刻显示；洛雪插件按 Electron `includes(lx)` 完整转换。 | 新增 LYRIC-01 / PLUGIN-LX；不改 Top Graph 主架。 |
| 2026-09-17 | 明文 HTTP 音频/封面走本地代理；喜欢列表按远程 position 重排；封面失败独立搜源。 | 更新 PLAYBACK-01 / COVER-02 / SYNC-01。 |
| 2026-09-17 | sidecar 落盘转换洛雪插件；歌词窗口 macOS screen-saver 置顶。 | 更新 LYRIC-01 / PLUGIN-LX；不改 Top Graph 主架。 |
| 2026-09-17 | 洛雪音源写回注册表；播客首页刷新收藏；切歌去掉固定 100ms。 | 更新 PLUGIN-01 / PLUGIN-LX / PODCAST-01 / PLAYBACK-01；不改 Top Graph 主架。 |
| 2026-09-17 | 混淆洛雪先解码再认；当前源切歌不探测；普通 http 播放链缓存对齐。 | 更新 PLUGIN-LX / PLAYBACK-01；不改 Top Graph 主架。 |
| 2026-09-17 | 当前源切歌写回原 URL 缓存；PLUGIN-01 注册表音源已落地。 | 更新 PLAYBACK-01 / PLUGIN-01。 |
| 2026-09-18 | 内存/CPU 优化：列表封面缩略图、播放队列防抖、KeepAlive 上限、sessionCache LRU、封面代理 16MB、后台停循环、全屏 PIXI 销毁、着色器 12fps、NAS 长轮询。 | Graphify AST 增量：6295 nodes / 13698 edges / 314 communities；不改 Top Graph 主架。 |
| 2026-09-19 | 底栏切源走当前插件平台名单 + 内置搜索；音质菜单读插件 qualitys；播放先按设置音质再降级。 | Graphify AST 增量：6565 nodes / 14390 edges / 315 communities；更新 Top Graph 选源流。 |
| 2026-09-19 | 修复窗口最大化/最小化/关闭/设置点不了：拖拽带让开右上角，全屏标题栏抬到播放层之上。 | Graphify AST 增量：6598 nodes / 14576 edges / 302 communities；更新 Runtime And Cost 验收项。 |
| 2026-09-19 | 播放 CPU：确认不是状态栏，而是 `澜音`+`WebContent` 自定义协议 IPC 风暴；降频本地时钟并丢掉无消费者歌词/进度噪声 emit。 | 更新 Runtime And Cost 验收项；Graphify 待本轮装包验收后增量刷新。 |
| 2026-09-19 | 钉死并修掉 `canplay`↔`mpv_set_playback_rate` 死循环；正式包装入 `/Applications/澜音.app` 后稳定点播：主进程约 1.7%、WebContent 约 2.3%、mpv 约 3.2%，合计约 7%。 | Graphify AST 增量：6606 nodes / 14624 edges / 307 communities；更新 Runtime And Cost 路由与 handoff 验收数字。 |
| 2026-09-19 | localhost 内存：列表 CDN 封面改走缩略图；发现/歌单 hover 模糊底按需解码；WKWebView NSURLCache 限 32MB。不改播放、开关、全屏封面和动效。 | Graphify AST 增量：6621 nodes / 14652 edges / 323 communities；更新 Runtime And Cost 路由与 handoff。 |
| 2026-09-19 | 启动完成后主动申请麦克风；MPV 低音/环绕/响度滤镜对齐 Electron 听感。 | Graphify AST 增量：6607 nodes / 14625 edges / 304 communities；更新 Playback And Media 音效流。 |
| 2026-09-19 | 全屏底栏点一下唤醒：隐藏 Dock 不再误关全屏；底部唤醒带 + pointerdown。全屏背景闲置层释放、烘焙缓存收紧、频谱不再每帧强制布局。 | Graphify AST 增量：6631 nodes / 14668 edges / 315 communities；更新 Runtime And Cost 验收项。 |
| 2026-09-19 | 修进全屏要点两下、重启第一首卡住、退出全屏内存/CPU 不回落：关全屏后全屏层移出底栏并卸歌词树；启动/缓存命中不再先 mpv_probe。 | Graphify AST 增量：6641 nodes / 14705 edges / 314 communities；更新 Runtime And Cost 与 Playback 验收项。 |
| 2026-09-19 | 点 Dock 进全屏会弹一下又落下：同一击二次 toggle。打开后短暂忽略二次切换；关全屏卸载 FullPlay 降内存。 | Graphify AST 增量：6641 nodes / 14708 edges / 315 communities。 |
| 2026-09-19 | MPV 环绕改为 WebKit 归一化 float IR + `afir` 并行 dry/wet；`dry=0` 会让卷积静音。 | Graphify AST 增量：6643 nodes / 14712 edges / 322 communities；更新 Playback And Media 音效流。 |
| 2026-09-19 | 修复打包后音乐/播客播不了：FFmpeg 9 `acompressor` `knee=20dB` 超范围导致 lavfi 建图失败；播放热路径去掉 `mpv_probe`。 | Graphify AST 增量：6644 nodes / 14713 edges / 316 communities。 |
| 2026-09-19 | 响度三档改为 mpv/FFmpeg `dynaudnorm`（maxgain 4/8/16），不再用会把热母带压小的 `acompressor`+limiter。 | Graphify AST 增量：6644 nodes / 14713 edges / 316 communities；更新 Playback And Media 音效流。 |
| 2026-09-19 | 欢迎页去掉启动更新弹窗；播客网格改固定封面轨道，缩成 4 列不再撑大封面。音效滤镜本轮不改。 | Graphify AST 增量：6644 nodes / 14712 edges / 319 communities；不改 Top Graph 主架。 |
| 2026-09-19 | 设置页切模块降 CPU/内存：分类按需挂载、去掉 KeepAlive、插件/均衡器/设备扫描不再进外观入口。 | Graphify AST 增量：6663 nodes / 14736 edges / 310 communities；更新 Runtime And Cost 验收项。 |
| 2026-09-19 | Mac 上一首/下一首媒体键与自定义全局快捷键：MPV 不再抢键；始终注册系统媒体键；保存后立刻重新注册。 | Graphify AST 增量：6686 nodes / 14808 edges / 311 communities；更新 Playback And Media 热键流。 |
| 2026-09-19 | 音效点一下等一下：mpv 带标签滤镜增量替换，换响度/环绕只换 `@loud`/`@sur`；三个房间 IR 预生成。 | Graphify AST 增量：6689 nodes / 14820 edges / 319 communities；更新 Playback And Media 音效流。 |
| 2026-09-19 | Mac Fn+F7/F8/F9 走 Now Playing；快捷键可录入媒体键；播放设置增加启动自动播放（默认关）。 | Graphify AST 增量：6727 nodes / 14914 edges / 321 communities；更新 Playback And Media 热键/Now Playing 流。 |
| 2026-09-19 | 关全屏/回主页/最小化释放 FullPlay 重树：卸歌词/频谱/封面，dispose AMLL，清烘焙缓存。 | Graphify AST 增量：6728 nodes / 14919 edges / 313 communities；更新 Runtime And Cost 验收项。 |
| 2026-09-19 | 启动闪退：Now Playing 去掉 define_class/block2，改 ClassBuilder + addTarget:action:；release panic=abort 下不再 abort。 | Graphify AST 增量：6733 nodes / 14938 edges / 299 communities。 |
| 2026-09-19 | 点播放/下一首卡住：暂停过渡音量 IPC 风暴堵住 mpv_load/mpv_play。切歌不再等 fade，播放立刻按目标音量起播。 | Graphify AST 增量：6734 nodes / 14941 edges / 314 communities。 |
| 2026-09-20 | 对齐安卓（shuxiamusic）：重启续播修复（暂停/seek 也落盘进度、关到托盘前强制 flush、恢复不再抹掉 wasPlaying、首次播放 seek 兜底保留）；失败自动下一首加 5s 延迟；播放音质逐级降档加声明预判（songDeclaresQuality）；确定性失败拉黑源 120s；设置页下载目录接通 sidecar（download.setDownloadDir）。 | Graphify AST 增量：6742 nodes / 14961 edges / 316 communities；不改 Top Graph 主架。 |
| 2026-09-20 | 起播没声音：聚合音源返回 CDN 根地址被当成可播（mpv success 但 idle）；收紧可播放校验并让坏缓存自愈。设置页：插件元数据并发+缓存、去掉强制重排轮询。 | Graphify AST 增量：6747 nodes / 14973 edges / 327 communities。 |

| 2026-09-20 | 全屏退出内存优化：歌词字体 CSS 改按需注入/释放（~12MB）；烘焙缓存 8→4 条目、maxSide 720→480；AMLL DOM 子树主动清空；卸载延迟 400→200ms；lodash 按需引入。 | 不改 Top Graph 主架；更新 Runtime And Cost 验收项。 |
| 2026-09-20 | 修复 Dock/Now Playing 封面不显示：Rust 端 set_info 收到 artwork_url 但未处理，新增 create_mpmedia_artwork 下载图片并设置 MPMediaItemArtwork。修复状态栏歌词不更新：移除 needsLyricConsumers 守卫、shouldDropNoiseEvent 不再丢弃歌词事件、scheduleNext 自带歌曲切换检测。 | 更新 Runtime And Cost 歌词流与 Now Playing 验收项。 |
| 2026-09-21 | Mac 插件在线升级校验下载响应，HTML 发布页不再作为脚本安装；失败兜底改用 Tauri shell 打开系统浏览器。 | 更新插件升级检索标签；Graphify 本轮增量刷新。 |

For every later change, append a row here and update `TOP_GRAPH.md` when the
architecture or ownership map changes.

## 2026-09-21 Sync identity and favorite acknowledgement
- `cloudLibrarySync.ts`: canonical favorite song IDs and retain stale outbox operations.
- `cloudList.ts`: normalize source-prefixed cloud IDs before local persistence.
- Favorite UI verifies local persistence before showing success or uploading.
- `App.vue` / `nasSyncPoller.ts`: start realtime polling before optional startup IPC and retry not-yet-ready plugin config every two seconds while visible.

## 2026-09-23 Sync safety and durable mutation queues
- `nasSyncPoller.ts`: AUTO 初次同步改为快照合并加明确 outbox flush，不再调用整库备份或隐式插件 union，避免新设备覆盖云端或复活删除。
- `cloudLibrarySync.ts`: Mac 歌单创建/编辑/删除增加持久化待办队列，网络失败或重启后继续重试。
- Android `LocalStorage.kt` / `SyncManager.kt`: 插件删除待办持久化稳定 operationId 和 sequence，跨重启重试仍保持幂等。
- 验证：Mac `npm run build`、Android `./gradlew test`、NAS `npm run typecheck && npm test` 均通过；Graphify/AI 索引已更新。
- `nasSync.ts`：播客排序改为独立持久化 reorder 待办，成员增删先提交，排序冲突时合并云端新增后重试。
- Android `SyncManager.kt`：实时播客 reorder 事件按服务器完整顺序更新当前状态；插件删除命中多个内部 key 时使用独立幂等 operationId。
- NAS 队列隔离：普通云端模式不创建或清理 NAS 歌单待办。

## 2026-09-24 Mac realtime sync device registration
- `nasSyncPoller.ts`: 自动轮询与 SSE 建流前统一调用 `/sync/register`，并以共享 Promise 防止冷启动并发注册；注册失败会重置状态并走既有重试路径，避免 Mac 静默停在旧 revision。
- 验证：`npm run build`（`vue-tsc --noEmit` + Vite）通过；待正式包启动后用 NAS 设备游标和事件 revision 做运行时验收。

## 2026-09-21 Sync safety first batch
- `nasSyncPoller.ts`: remote playlist restoration now requires a valid complete song detail response; failed or malformed detail reads abort before local replacement.
- `nasSyncPoller.ts`: `requiresRefresh` responses fail closed and do not advance the local cursor until a full-refresh workflow is implemented.
- Android `NasSyncApiService.kt` / `SyncManager.kt`: fixed favorite-summary URL encoding and preserve the cursor when the server requires refresh.
- Graphify incrementally refreshed: 7057 nodes / 15790 edges / 326 communities; generated aggregated `graph.html`.
