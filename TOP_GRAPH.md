# Ceru Music Tauri Top Graph

Last generated: 2026-09-29
Graph source: `graphify-out/graph.json`  
Generated report: `graphify-out/GRAPH_REPORT.md`

This file is the curated Top Graph for AI agents. It intentionally omits
generated schema and vendor noise. The full node-level graph remains available
through Graphify.

## Graph Summary

- 352 code files are extracted structurally.
- 11 project documents are included in semantic extraction.
- Current node, edge, confidence, and community counts are authoritative in
  `graphify-out/GRAPH_REPORT.md`.
- `graph.html` uses an aggregated community view because the graph exceeds the
  5,000-node browser threshold.

## God Nodes

| Rank | Node | Role |
| --- | --- | --- |
| 1 | `Database` | Rust persistence hub for playlists, tracks, settings, downloads. |
| 2 | `httpFetch()` | Shared network path used by the sidecar and migrated SDK code. |
| 3 | `vue` | Renderer framework hub across the application shell and components. |
| 4 | `createTauriBridge()` | The boundary that maps Electron-style renderer APIs to Tauri commands. |
| 5 | `AudioFingerprintRuntime()` | Audio recognition runtime used by the recognition worker. |
| 6 | `tdesign-vue-next` | Primary component library dependency. |
| 7 | `LocalUserDetailStore` | Persistent local playback queue and user list state. |
| 8 | `pinia` | Renderer state-management foundation. |
| 9 | `tdesign-icons-vue-next` | Main icon dependency used by controls and menus. |
| 10 | `useListenTogetherStore` | Cross-player room state, queue, chat, and synchronization hub. |

## Main Community Map

| Community | Responsibility | Representative files |
| --- | --- | --- |
| Full Player Playback UI | Full player controls, quality switching, playback rate, source UI. | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` |
| Tauri Rust Application Shell | Tauri app setup, windows, tray, deep links, plugin registration. | `src-tauri/src/lib.rs` |
| MPV Audio Backend | MPV process lifecycle, direct-child shutdown, audio filters, progress and state events. | `src-tauri/src/commands/mpv_player.rs`, `src-tauri/src/lib.rs` |
| Tauri IPC Bridge | Renderer compatibility bridge from Electron APIs to Tauri commands. | `src/tauri-bridge.ts` |
| Playback Queue Resolution | Song URL lookup, queue advancement, fallback, current-song normalization. | `src/utils/audio/globaPlayList.ts` |
| Native Media Gateway | Native media probing, validation, proxy URL selection, playback fallback. | `src/utils/audio/mediaGateway.ts`, `src/services/media/nativeMedia.ts` |
| Media Validation Gateway | Cache and validation key for resolved media. | `src/utils/audio/mediaGateway.ts` |
| Node Sidecar IPC | Long-lived Node process transport and request/response correlation. | `src-tauri/src/commands/node_sidecar.rs`, `sidecar/index.mjs` |
| Sidecar Plugin Service | Plugin install, registry, config, worker execution, source mapping. | `sidecar/services/plugins/index.mjs` |
| Sidecar Music SDK Loader | Loads migrated Electron SDK modules and routes source operations. | `sidecar/services/musicSdk/index.mjs` |
| NetEase Podcast SDK | NetEase podcast APIs, login state, category totals, stale response control. | `sidecar/vendor/electron/src/main/utils/musicSdk/wy/podcastOfficial.js` |
| NetEase Comments SDK | Comment pagination, hot comments, emoji handling, current source requests. | `sidecar/vendor/electron/src/main/utils/musicSdk/wy/comment.js` |
| Kugou SDK Aggregation | Kugou source implementation, song lists, lyrics, quality, search. | `sidecar/vendor/electron/src/main/utils/musicSdk/kg/*` |
| QQ Music SDK | QQ/TX source implementation, signing, lyrics, quality, search. | `sidecar/vendor/electron/src/main/utils/musicSdk/tx/*` |
| Migu SDK | Migu source implementation, albums, lyrics, quality, search. | `sidecar/vendor/electron/src/main/utils/musicSdk/mg/*` |
| Download Store | Renderer download task state and status transitions. | `src/store/download.ts` |
| Rust Download Engine | File download, cover/task persistence, queue lifecycle. | `src-tauri/src/commands/download_engine.rs` |
| Node Download Service | Sidecar download queue, audio cache, task events. | `sidecar/services/download/index.mjs` |
| Desktop Lyric Window | Native window geometry, lock, drag, resize, reveal-after-render. | `src-tauri/src/commands/lyric_window.rs` |
| Desktop Lyric Settings | User options mapped to the native lyric window. | `src/components/Settings/DesktopLyricStyle.vue` |
| Local Music Library | Local scan, edit tags, cover/lyric lookup, playlist insertion. | `src/views/music/local.vue`, `src-tauri/src/commands/local_music.rs` |
| SQLite Database Layer | Playlists, tracks, settings, downloads, local metadata persistence. | `src-tauri/src/db.rs` |
| Discover Page Cache | Discover categories, tags, playlists, request IDs, stale response rejection. | `src/views/music/find.vue` |
| Podcast Discovery UI | Categories, shelves, blocks, login, radio loading. | `src/views/music/podcast.vue` |
| NAS Library Sync | Operation-driven local outboxes, server revision events, SSE wake-up with long-poll compensation, and responsive library/plugin updates. | `src/api/nasSync.ts`, `src/services/nasSyncPoller.ts`, `src/utils/playlist/cloudLibrarySync.ts`, `src/utils/playlist/pluginSync.ts`, `nas-sync-server/src/http.ts` |
| Listen Together | Room synchronization, chat, queue actions, notifier and overlays. | `src/store/ListenTogether.ts`, `src/components/ListenTogether/*` |
| DLNA Output Backend | Discovery, playback, volume and position control for DLNA devices. | `src-tauri/src/commands/dlna.rs` |
| Audio Quality Formats | Quality normalization, comparison, display names, verified capability. | `src/common/utils/quality.ts`, `src/utils/audio/qualityAvailability.ts` |

## Cross-Community Flows

### 1. Renderer To Native Sidecar

```text
Vue view/component
  -> src/tauri-bridge.ts
  -> @tauri-apps/api invoke/listen
  -> src-tauri/src/commands/node_sidecar.rs
  -> sidecar/index.mjs
  -> sidecar/services/{plugins,musicSdk,download,system}
  -> plugin or migrated Electron SDK
```

At renderer bootstrap, the bridge starts `plugins.initializeSystem()`, which
preloads eligible sidecar plugin workers before the first playback request.
This is the Tauri equivalent of Electron calling `initializePlugins()` before
`createWindow()` and the welcome page's `service-plugin-initialize-system`
compatibility call. The sidecar deduplicates concurrent initialization.


This is the primary latency boundary. Any synchronous work here can freeze the
WebKit UI. Network-heavy requests must remain asynchronous and out-of-order
safe.

### 2. Playback And Media

```text
src/utils/audio/globaPlayList.ts
  -> url-cache / isPlayableUrl (cache hit, zero network)
  -> getSongRealUrl -> tauri-bridge getMusicUrl
  -> sidecar plugin musicUrl
  -> wrapPlaybackStreamIfNeeded (Feiniu `{url,headers}` -> media stream proxy)
  -> src/utils/audio/playableUrl.ts
  -> src/utils/audio/mediaGateway.ts
  -> src/services/media/nativeMedia.ts
  -> node sidecar / native audio / MPV / media stream proxy
  -> src/components/Play/GlobalAudio.vue
  -> src/store/GlobalPlayStatus.ts
```

Equalizer and advanced effects no longer go through Web Audio. They sync into
`mpv_set_audio_filters` via `syncNativeAudioFilters()`, then become labeled mpv
filters in `mpv_player.rs` (`@eq` peaking, `@bass` lowshelf, `@sur` WebKit-normalized `afir`
surround with cached float IR, `@bal` pan, `@loud` `dynaudnorm`). Surround is
dry + wet convolution, not `aecho`. Microphone permission is requested once after
app ready so device labels and recognize features do not wait for first play.

At application exit, `src-tauri/src/lib.rs` routes `RunEvent::ExitRequested` and `Exit` to `mpv_shutdown`. The Tauri adapter takes the Rust-owned MPV `Child` out of the runtime state, releases the runtime lock, then calls `kill + wait` directly; exit does not depend on an MPV IPC `quit` response. `closeToTray` still hides the main window and intentionally leaves playback alive.

`--input-media-keys=no`. After MPV owns audio, WebKit Media Session cannot catch
Fn+F7/F8/F9. `now_playing.rs` registers `MPRemoteCommandCenter` with `ClassBuilder` + `addTarget:action:` (not `define_class!` / `addTargetWithHandler:`) for play/pause/next/prev
and publishes Now Playing info; recording mode emits `hotkeys:media-capture` instead
of dispatching playback. `hotkeys.rs` still registers MediaPlayPause /
MediaTrackPrevious / MediaTrackNext / MediaStop plus F7/F8/F9 fallbacks, mapping
them to Electron `toggle` / `playPrev` / `playNext` / `pause`. User global hotkeys
are stored in the `hotkeys` table, merged onto defaults, and re-applied after every
save. Launch autoplay is `playSetting.autoPlayOnLaunch` (default off) and only
starts after the restored URL actually loads.

The canonical current song and source must be normalized after every successful
URL fallback. Download quality checks read the same canonical state; do not let
the queue store and playback store diverge. Feiniu and other cookie-protected
plugin results must keep their auth headers via the local stream proxy; a bare
CDN/NAS URL will 401 and look like a source failure.

Every resolved URL must pass `isPlayableUrl` before it is cached or handed to
`mpv_load`. Aggregation APIs return CDN root addresses such as
`https://aqqmusic.tc.qq.com/` when no real direct link is available; `mpv
loadfile` reports `success` for those and then sits idle, so accepting them
silently disables both quality downgrade and source fallback. Cached URLs are
re-validated on read and invalidated in place so an old poisoned entry heals
itself instead of blocking startup restore.

### 3. Source And Plugin Selection

```text
current source
  -> renderer bootstrap prewarms sidecar plugin workers
  -> plugin/source identity normalization
  -> sidecar plugin registry
  -> selected plugin platforms only
  -> catalog search uses built-in SDK for wy/tx/kg/kw/mg
  -> selected plugin first for musicUrl
  -> preferred quality first, then plugin qualitys, then song types
```

Electron asks the configured plugin first and returns a usable URL immediately.
Do not pre-race all providers on the happy path.

### 4. Podcast And Radio

```text
src/views/music/podcast.vue | radio.vue
  -> src/api/podcast.ts
  -> tauri bridge / sidecar music SDK
  -> NetEase podcastOfficial.js or radio.js
  -> login/cookie state + category/shelf/block caches
```

First-screen work must be concurrent where Electron is concurrent. Category
totals, shelves, blocks, favorites, and login refresh must not serialize behind
one slow request.

### 5. Playlist Duplicate Cleanup

```text
playlist more menu -> 查重清理
  -> src/views/music/list.vue
  -> src/components/Music/DuplicateSongsDialog.vue
  -> keep/select/delete per expanded song
  -> songlist_remove_songs(source:songmid)
  -> favorites/cloud sync if needed
```

Duplicate groups stay expanded. Checkbox means pending delete; Keep unchecks; Delete removes that one song immediately; bulk cleanup only removes current selections.

### 5. Downloads

```text
download menu/dialog
  -> src/utils/audio/download.ts
  -> quality verification
  -> canonical playback source lookup
  -> download store
  -> Rust download engine and/or Node sidecar download service
  -> task event -> renderer store
```

Quality failure must not be confused with a current-source mismatch. The
download path must resolve the same effective source used by playback.

### 6. Desktop Lyrics

```text
settings/control
  -> src/utils/lyrics/desktopLyricBridge.ts
  -> src/tauri-bridge.ts
  -> src-tauri/src/commands/lyric_window.rs
  -> desktop-lyric WebView
  -> src/views/DeskTopLyric/DeskTopLyric.vue
```

Window geometry is in logical pixels. Preserve resize height, lock state,
transparent boot, and reveal only after render readiness.

### 7. Local Music And Persistence

```text
src/views/music/local.vue
  -> local music commands
  -> src-tauri/src/commands/local_music.rs
  -> src-tauri/src/db.rs
  -> SQLite
```

Playlist CRUD, download tasks, settings, local track metadata, and cloud sync
metadata share this persistence layer.

#### 9. Desktop Updates And Release Artifacts

```text
src/main.ts
  -> delayed periodic background check
  -> src/tauri-bridge.ts
  -> Tauri updater plugin
  -> shared GitHub Release latest.json
  -> platform-specific signed DMG / NSIS artifact
```

The shared repository can publish Android APKs alongside desktop artifacts. The
Tauri updater does not consume the APK; it selects the platform-specific entry
from `latest.json`. Mac Apple Silicon and Intel require separately built and
signed artifacts unless a universal binary is intentionally produced. Windows
continues using NSIS artifacts and needs its own updater entry/signature.


The main process, WebKit renderer, Rust native audio/MPV layer, and Node sidecar
all contribute to memory. Measure the full process tree before changing
architecture. A low Tauri shell number alone does not prove lower total cost.

## Start Here For A Task

| Task | First files | Verification focus |
| --- | --- | --- |
| Song cannot play | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/mediaGateway.ts`, `src/tauri-bridge.ts` | Electron ordering, URL normalization, fallback source, canonical state |
| Source switch is slow | `src/utils/audio/audioHelpers.ts`, `src/tauri-bridge.ts` | bounded candidates, timeout, plugin health, stale response |
| Quality menu stuck | `src/utils/audio/qualityAvailability.ts`, `src/services/media/nativeMedia.ts` | current source, real quality request, cache/inflight dedupe |
| Download fails | `src/utils/audio/download.ts`, `src/store/GlobalPlayStatus.ts`, `src/store/download.ts` | effective source, quality, task payload, queue error |
| Podcast/discover is slow | `src/views/music/find.vue`, `src/views/music/podcast.vue`, `src/utils/cache/sessionCache.ts` | concurrent first screen, request IDs, stale response rejection |
| Desktop lyric missing | `src-tauri/src/commands/lyric_window.rs`, `src/views/DeskTopLyric/DeskTopLyric.vue` | logical pixels, transparent boot, reveal, lock, drag |
| Full player animation stutters | `src/components/Play/FullPlay.vue`, `src/components/Play/PlayMusic.vue` | animation path, compositor properties, visualizer cost |
| Fullscreen dock needs two clicks | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` | idle wake strip, parked full-play off dock, hidden dock pointer-events |
| Dock progress jumps every second | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` | animate remaining duration with transform; do not raise `progressPublishInterval` |
| First song after restart is slow | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/audioHelpers.ts` | startup restore must not mpv_probe before mpv_load |
| Fullscreen CPU/memory stays high after close | `src/components/Play/FullPlay.vue`, `src/components/sImage.vue`, `src/views/home/index.vue` | hide/minimize release FullPlay; keep current-page hot covers; drop cold decoded bitmaps; KeepAlive max=1 while hidden |
| Window buttons / settings unclickable | `src/App.vue`, `src/components/TitleBarControls.vue`, `src/components/Play/FullPlay.vue` | drag strip right inset, TitleBar z-index above playbox, no-drag on buttons |
| Memory/CPU is high | `src-tauri/src/commands/node_sidecar.rs`, `sidecar/index.mjs`, cache stores | full process tree, idle work, cache bounds, retained listeners |
| Settings CPU/memory spikes when switching modules | `src/views/settings/index.vue`, `src/views/settings/sections/PluginSection.vue`, `src/views/settings/sections/PlaybackSection.vue` | current category only, no KeepAlive, plugins/EQ/device scan not on appearance |
| localhost memory ~400MB | `src/utils/coverThumb.ts`, `src/components/sImage.vue`, `src/views/music/find.vue`, `src-tauri/src/lib.rs` | decoded CDN covers, hover backdrop double-decode, WKWebView NSURLCache |
| Playback CPU both sides high (`澜音` + `localhost`) | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/PlayMusic.vue`, `src/tauri-bridge.ts` | first check `mpv_set_playback_rate` ↔ `canplay` loop and `/tmp/ceru-mpv-hot.log` `set_rate=`; then lyric noise / progress clock |
| Plugin/source mapping is wrong | `src/utils/playlist/pluginIdentity.ts`, `src/tauri-bridge.ts` | normalized source identity, plugin registry, duplicate IDs |

## Query Commands

```bash
graphify query "How does playback resolve a URL and update the current source?"
graphify query "Where is the desktop lyric window geometry controlled?"
graphify explain "createTauriBridge"
graphify path "PlayMusic.vue" "node_sidecar_request"
```

After any architecture change, update this file and the maintenance log in
`AI_INDEX.md`.
