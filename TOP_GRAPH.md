# Ceru Music Tauri Top Graph

Last generated: 2026-10-04
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
| DLNA Output Backend | Discovery, playback, volume and position control for DLNA devices. Local HTTP server (file serve / loopback proxy) is started on demand inside `dlna_play` via `ensure_local_server()`, not at startup, so no `0.0.0.0` port is exposed while idle. | `src-tauri/src/commands/dlna.rs` |
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

Startup keeps plugin initialization inside the welcome screen. The minimum splash wait is 1500ms, then `/home` route replacement starts the overlapping transition; `initPlayback()` is delayed 720ms after route replacement so home mount and local playback-state restore do not compete with the dissolve animation. It restores the last song through the same `playSong()` pipeline as manual playback, preserving URL-cache validation, current-source refresh, candidate-source fallback, and bounded failure auto-next. MPV errors arriving before a per-song error handler is installed are held against the current playback request and replayed once the handler is ready.

Welcome-to-home uses an overlapping route transition: the starfield stays on top and dissolves (scale/blur/fade) while `/home` mounts underneath. The dissolve/reveal pair runs for 720ms with `linear` timing, so the old decelerating tail that made the final frames appear to pause is removed. FullPlay trackpad gestures are handled entirely in the frontend: two-finger horizontal swipe toggles `layoutMode` (`cd` vinyl vs square cover) with per-swipe latching. Once a segment crosses the 48px trigger it latches and **every** later wheel event is ignored until the latch is released; release only happens when two consecutive events are more than 250ms apart **in `event.timeStamp`** (event creation time, not handler time), with a 2s hard ceiling on the latch as a safety net in case some WebKit path never advances `timeStamp`. Using `event.timeStamp` is essential: toggling the layout swaps the whole CD/cover template, which blocks the main thread, so queued momentum events are handled in a burst where `performance.now()` gaps look like a "new swipe" — that misfire was the "one swipe flips back and forth several times" bug. Pinch (Safari `gesturestart`/`gesturechange`, plus `ctrl`+`wheel` fallback) toggles window fullscreen. Three-finger is intentionally not implemented. The earlier macOS AppKit local event monitor was removed because any Objective-C exception thrown inside `NSApplication sendEvent:` (for example `touchesMatchingPhase:inView:`) cannot be caught by Rust and aborts the whole process; the frontend-only path has no such native crash surface.

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

macOS CoreAudio AO silent-death recovery: after a default-output-device switch,
Bluetooth connect/disconnect, `coreaudiod` restart, or sleep/wake, MPV's audio
output can go silent while decoding and the clock keep advancing. The frontend
`nativePlayback.ts` listens to the `app-audio-device-changed` event — emitted by
`src-tauri/src/audio_device.rs`, which registers a CoreAudio
`kAudioHardwarePropertyDefaultOutputDevice` property listener (WebKit does not
expose audio-output devices on macOS, so `navigator.mediaDevices` `devicechange`
is only a fallback) — plus `navigator.mediaDevices` `devicechange` (debounced
800ms) and the `app-system-wake` event (emitted by `system_power.rs` from
`NSWorkspaceDidWakeNotification`), then calls the `mpv_reload_audio_output`
command, which cycles `aid` (`no` -> restore) in `mpv_player.rs` to tear down and
rebuild the whole audio chain (AO included) without reopening the network stream.
The reload is single-flight with a 1.5s cooldown and fails soft — an AO rebuild
error never surfaces as a playback error, so it does not trigger source switch or
auto-next.

Headphone auto-resume suppression: macOS sends the app system media commands
around an output-device change (pause on unplug, play/pause on replug/insert).
`globaPlayList.ts` `onGlobalCtrl` treats system-sourced (`source=media`)
`play`/`pause` inside a suppression window as device noise: `play` is ignored and
`pause` is pause-only (never toggles to play). The window is 6s after
`app-audio-device-changed`/`devicechange`, plus a 4s fallback after a system
`pause` that actually paused playback (covers earphones that plug into a USB
interface, where the default output device does not change). Outside the window
the existing toggle-on-`pause` semantics is kept (it compensates for stale
Now-Playing state), and UI-initiated play/pause is never suppressed.

Dock-bar volume is a **proportional (linear-amplitude) mapping**, because mpv's
own `volume` property is not linear: measured on the bundled mpv v0.41
(`ao=pcm` + `volumedetect`), `gain = (volume/100)^3` — `volume=50` is -18.0 dB,
`volume=80` is -5.8 dB. `nativePlayback.ts` therefore inverts that cubic:
`sliderToMpvVolume(p) = 100 * cbrt(p/100)`, so the effective gain equals the
slider percentage (100%→100 full scale = the full level of whatever the system
volume is set to, 80%→92.83 = -1.9 dB, 50%→79.37 = -6 dB, 0%→0). The previous
`p²/100` curve stacked a second power on top of mpv's cubic, so 50% landed near
-36 dB and 80% near -11.6 dB — the lower half of the slider was effectively
dead ("调到 80% 就很小了"). This also matches the Electron reference
(`audio.volume = v/100`). Both the frontend IPC merge (`flushMpvVolumeIpc`) and
the Rust `mpv_set_volume` early return dedupe with a 0.25 threshold in the
mpv-volume domain (1% of slider ≈ 0.33 mpv units at full scale). DLNA volume
sync still sends the raw slider percentage. 0% is a legitimate slider value
(mute): every `volume <= 0 -> 80` coercion was removed from `nativePlayback.ts`
(`nativeLoad`/`nativeSetVolume`), `LocalUserDetail.init()` (only non-finite /
out-of-range persisted values fall back to 80) and the `PlayMusic.vue` watcher —
otherwise dragging to the bottom bounced straight back to 80%.

Window-visibility wake
(`ceru-wake`: minimize/restore, hide/show, 15s idle wake) must NOT trigger the
reload: it only re-syncs the local progress clock. Rebuilding the AO on every
window restore caused an audible pause at click-to-restore (AO teardown gap), so
the rebuild is gated strictly on real system sleep/wake and device changes. It
does not cover a default-device change that neither adds nor removes a device (no
`devicechange` signal reaches the WebView).

At application exit, `src-tauri/src/lib.rs` routes `RunEvent::ExitRequested` and `Exit` to `mpv_shutdown`. The Tauri adapter takes the Rust-owned MPV `Child` out of the runtime state, releases the runtime lock, then calls `kill + wait` directly; exit does not depend on an MPV IPC `quit` response. `closeToTray` still hides the main window and intentionally leaves playback alive.

`--input-media-keys=no`. After MPV owns audio, WebKit Media Session cannot catch
Fn+F7/F8/F9. `now_playing.rs` registers `MPRemoteCommandCenter` with `ClassBuilder` + `addTarget:action:` (not `define_class!` / `addTargetWithHandler:`) for play/pause/next/prev
and publishes Now Playing info; recording mode emits `hotkeys:media-capture` instead
of dispatching playback. `hotkeys.rs` registers the standard media keys
MediaPlayPause / MediaTrackPrevious / MediaTrackNext / MediaStop (no hardcoded
F7/F8/F9) on every platform. On macOS the global-hotkey SystemDefined CGEventTap
catches NX_KEYTYPE events from the keyboard, wired earbuds, and Bluetooth/AirPods
and consumes them on hit, so media keys work in the foreground and background;
`MPRemoteCommandCenter` stays as the Now Playing display and fallback, with a
100ms debounce so the two channels never double-fire. The CGEventTap needs macOS
Accessibility permission; without it registration only logs and Now Playing takes
over — on macOS `hotkeys.rs` then raises the system permission prompt once and
retries in the background every 2s for up to 15 minutes (`ax_is_trusted` /
`spawn_ax_retry`), so a re-signed rebuild that invalidates the old TCC grant
self-heals after the user approves, without restarting the app. `MediaStop` is
deliberately not registered (no such hardware key;
global-hotkey returns `Unknown scancode`) and `stopCommand` is served by
MPRemoteCommandCenter only.

**Headphone (AVRCP) control needs a bundle identity.** Bluetooth/AirPods
play-pause and stem double-tap do not arrive as `CGEvent` media keys; they are
delivered by MediaRemote to whichever app owns the current Now Playing session,
and that requires a real `CFBundleIdentifier`. `tauri dev` executes
`target/debug/ceru-tauri` as a bare binary, where `bundleIdentifier` is `nil`, so
remote commands are silently never routed there. `src-tauri/build.rs` now writes
an `Info.plist` next to the built executable so the dev binary also reports
`com.cerumusic.tauri` (verified in `/tmp/ceru-media-keys.log`
`init: bundleIdentifier=...`). `useSmtc.ts` keeps the session alive with a 10s
Now Playing heartbeat while playing (metadata alone goes stale and the system
stops routing), `now_playing.rs` caches `MPMediaItemArtwork` per URL so the
heartbeat never re-downloads artwork, and `-[NSApplication
beginReceivingRemoteControlEvents]` must not be called from setup (it aborts the
process). `CERU_DISABLE_MEDIA_TAP=1` drops the CGEventTap so only the remote
command channel remains when diagnosing routing. User global hotkeys are stored in the `hotkeys` table, merged onto

**Now Playing state must track real playback or earphone keys die.** MediaRemote
decides whether an earphone press sends `playCommand` or `pauseCommand` from the
session's last reported playback state, so the app must push the *real* state on
every transition: `globaPlayList.ts` `handlePause` now pauses on `isPlay` alone and
unconditionally calls `updatePlaybackState('paused')` (the old `url && audio` guard
silently skipped the sync in native mode); the `useSmtc.ts` 10s heartbeat reads the
native engine (`nativeIsPaused()`) and self-heals the system state back to paused if
it ever lags behind. `onGlobalCtrl` treats `pause` as a toggle (playing→pause,
otherwise→play) so a stale system perception can never make the button dead, and
dedupes same-action `source=media` events within 250ms because one physical press
can be delivered both by `MPRemoteCommandCenter` (Rust) and by the WKWebView's own
Media Session handler. `now_playing.rs` logs every `setPlaybackState` to
`/tmp/ceru-media-keys.log` (`np` lines) and `media_diag_log` records frontend
transitions in the same timeline. AirPods double-tap→next track additionally
requires the macOS setting (Bluetooth→AirPods→double tap→next track).

**Release builds must never route system-state reporting through `window.__TAURI__`.**
`tauri.conf.json` does not enable `withGlobalTauri`, so a packaged build only has
`__TAURI_INTERNALS__`. `useSmtc.ts` once reported Now Playing state via
`window.__TAURI__?.core?.invoke`; the missing global silently swallowed every
report, MediaRemote never learned the app was playing, and earphone presses were
routed to the other active session (a music page open in the browser). Anything
that feeds system state or diagnostics must go through `@tauri-apps/api/core`
(`safeTauriInvoke` in `useSmtc.ts`); the same defect in `HotkeySettings.vue`
recording is fixed the same way.

**macOS 27 removed `+[NSImage imageWithData:]`.** The class object still
exists but the class method is gone; calling it throws an uncaught
`NSInvalidArgumentException` that aborts the whole process. Now Playing
artwork must be built with the instance method `-[NSImage initWithData:]`
(or `initWithContentsOfURL:`) behind a `respondsToSelector:` guard, so a
future API removal degrades to "no artwork + log line" instead of a crash.

**The engine's real state comes from `mpv_get_state`, never from
`nativeIsPaused()`.** That frontend helper reads the store's own `isPlay`
(a circular alias), so it cannot detect desyncs. The 8s position tick in
`globaPlayList.ts` queries `mpv_get_state` while the frontend is paused and, after
two consecutive ~16s confirmations of "engine playing but `isPlay=false`" (a
startup sidecar-warmup race on `nativePlay`'s IPC), re-enters playback through
the canonical `nativePlay()` path and reports `playing` to the system.
defaults, and re-applied after every save; they use `CommandOrControl` so one config
resolves to Cmd on macOS and Ctrl on Windows, and any key (incl. F1–F12) can be
recorded. Launch autoplay is `playSetting.autoPlayOnLaunch` (default off) and only
starts after the restored URL actually loads.

The canonical current song and source must be normalized after every successful
URL fallback. Download quality checks read the same canonical state; do not let
the queue store and playback store diverge. Feiniu and other cookie-protected
plugin results must keep their auth headers via the local stream proxy; a bare
CDN/NAS URL will 401 and look like a source failure.

Favorite display follows a separate stable identity. `GlobalPlayStatus.player.favoriteAnchor`
is set once per `playSong` (the song the user picked) and is never rewritten by source
fallbacks inside that play session. The dock like star (`PlayMusic.refreshLikeState` /
`onToggleLike`) and favorites add/remove resolve against the anchor, so a song's star
survives automatic source switching and unliking always targets the picked identity
(`source:songmid`); the queue entry may still show the fallback instance. Queue eviction
on unliking (`evictUnlikedFromPlayback`) keeps using the current playback
instance, so the currently playing (possibly fallback) song still advances correctly.

When the exact `source:songmid` cannot identify the favorite, the dock like state
falls back to cross-source identity matching (`findFavoriteSongByIdentity` in
`cloudLibrarySync.ts`): the same song (normalized title + artist) may carry a
favorite record under a different source's songmid (auto source switch started from
a different instance, or a favorite synced from another device). `refreshLikeState`
then treats the song as liked, and `onToggleLike` removes that matched record, so the
displayed state and the "playlist removal -> cloud sync removal" chain stay
consistent. The dock title/artist/cover display is also anchor-first
(`PlayMusic.displayAnchor` / `displaySongName` / `displaySinger` /
`displayCoverSrc`): when the anchor and the current playback instance are the same
song, the bottom bar keeps showing the identity the user picked, and a missing or
different cover from the fallback source does not overwrite the original display.


The anchor also survives restart and reaches list views through a persisted
per-item field. When a source fallback replaces a queue entry
(`replaceCurrentSongInList`), `stampOriginalIdentity` copies the user's original
(favorited) identity onto the new instance as `_originalIdentity`, which is
serialized with the queue in `localStorage`. On restart `playSong` seeds the
anchor from `(song._originalIdentity || song)`, so a QQ song that fell back to
Kuwo still restores its QQ star. The queue list heart (`SongVirtualList.favoriteSongKey`
/ `isLiked` / `onToggleLike`) also resolves against `_originalIdentity` when present,
so the fallback instance keeps the original favorite key and like/unlike edits the
original record. The queue list source badge also uses `displaySource` =
`_originalIdentity?.source || source`, so a QQ song playing via a Kuwo fallback still
shows the QQ tag. The front end therefore always shows one stable identity; the
cross-source swap is a playback-only concern.

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

**HARD CONSTRAINT — never parallelize source URL resolution.** The music source
APIs enforce a per-day request quota; exceeding it blocks the whole source for
the rest of the day and tanks real success rate. Source URL resolution
(`getSongRealUrl` / plugin `musicUrl` / candidate `search`) MUST stay sequential
and request-frugal. Never race providers, never fan out concurrent resolve
requests, and never propose parallel racing as a performance idea. Raise success
rate only by spending FEWER source requests (positive/negative caching,
remembered working source, local-file priority, faster dead-link detection),
never by sending more.

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

The completed-task folder icon calls `download.openFileLocation` through
`src/tauri-bridge.ts` into the Node sidecar, which runs `open -R` (macOS) /
`explorer /select` (Windows) / `xdg-open` (Linux). The route must be registered
in `sidecar/index.mjs`'s method table — the service implementation existing in
`sidecar/services/download/index.mjs` is not enough; an unregistered method
throws `Unsupported sidecar method` and the bridge's non-strict wrapper silently
returns `undefined`, so the click appears to do nothing.

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
| Welcome dissolve into home | `src/views/welcome/index.vue`, `src/App.vue` | splash stays on top, home mounts underneath, scale/blur fade |
| FullPlay trackpad gestures | `src/components/Play/FullPlay.vue`, `src/store/playSetting.ts` | two-finger layout, pinch fullscreen; frontend-only, no AppKit monitor |
| Desktop release (GitHub + Gitee) / artifact quota hit | `.github/workflows/desktop-release.yml`, `scripts/ci/publish-gitee-local.sh`, `scripts/ci/make-latest-json.py` | build jobs upload installers **directly to the release** `maiga512/shuxiamusic-release@desktop-latest` (public-repo release assets do not count against the 500MB Actions artifact quota); `publish` needs both platforms, then `gh release download -p "shuxiamusic_<version>_*"` → `make-latest-json.py` → upload only `latest.json`, plus a cleanup step for stale assets. Gitee is uploaded from the local machine (`publish-gitee-local.sh`); if the Gitee `desktop-latest` release still holds old-version assets, DELETE the whole release first (the Gitee API returns no attachment ids) |
| Black bar at top after leaving fullscreen / menu bar not covered | `src-tauri/src/windowed_fs.rs` | macOS path no longer uses Tauri's window APIs at all; it runs the whole enter/exit in **one** main-queue AppKit task (`dispatch_async_f` + `_dispatch_main_q`), because tao 0.37's `set_decorations(true)` sets `Closable\|Miniaturizable\|Resizable\|Titled` with **no `FullSizeContentView`** (content pushed down by the title bar → black strip), `set_always_on_top(true)` sets `NSFloatingWindowLevel(3)` (below the menu bar's 24) asynchronously, and `set_position`/`set_size` go through the event loop while `set_decorations` goes through GCD — two queues with no ordering guarantee, and adding/removing `FullSizeContentView` itself changes the frame height by the title bar height. Enter: save AppKit `frame`/`level`/`isZoomed`, unzoom, drop `Titled`, `setFrame:` to `[window screen].frame` (full display frame incl. menu bar), `setLevel: 1000`. Exit: restore the Overlay mask (`Titled\|Closable\|Miniaturizable\|Resizable\|FullSizeContentView`) + transparent titlebar + hidden title + hide traffic lights, **then** write the saved frame back (order matters), then restore the saved level/zoom |
| Fullscreen dock needs two clicks | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` | idle wake strip, parked full-play off dock, hidden dock pointer-events |
| Dock progress jumps every second | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` | animate remaining duration with transform; do not raise `progressPublishInterval` |
| First song after restart is slow | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/audioHelpers.ts` | startup restore must not mpv_probe before mpv_load |
| Fullscreen CPU/memory stays high after close | `src/components/Play/FullPlay.vue`, `src/components/Play/ShaderBackground.vue`, `src/components/Play/AudioVisualizer.vue` | shader/visualizer rAF only while fullscreen playing; dormant uses visibility:hidden only; hide/minimize can still release FullPlay; do not cut bake quality or cover caches |
| Window buttons / settings unclickable | `src/App.vue`, `src/components/TitleBarControls.vue`, `src/components/Play/FullPlay.vue` | drag strip right inset, TitleBar z-index above playbox, no-drag on buttons |
| Memory/CPU is high | `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/ShaderBackground.vue`, `src/tauri-bridge.ts` | production must not run mpv hot logger; pause hidden QR/DLNA/recommendation timers; keep listen-together ping and native playback clock |
| Settings CPU/memory spikes when switching modules | `src/views/settings/index.vue`, `src/views/settings/sections/PluginSection.vue`, `src/views/settings/sections/PlaybackSection.vue` | current category only, no KeepAlive, plugins/EQ/device scan not on appearance |
| localhost memory ~400MB | `src/utils/coverThumb.ts`, `src/components/sImage.vue`, `src/views/music/find.vue`, `src-tauri/src/lib.rs` | decoded CDN covers, hover backdrop double-decode, WKWebView NSURLCache |
| Playback CPU both sides high (`澜音` + `localhost`) | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/PlayMusic.vue`, `src/tauri-bridge.ts` | first check `mpv_set_playback_rate` ↔ `canplay` loop and `/tmp/ceru-mpv-hot.log` `set_rate=`; then lyric noise / progress clock |
| Headphone / Now Playing keys do nothing | `src-tauri/build.rs`, `src-tauri/src/now_playing.rs`, `src/utils/audio/useSmtc.ts`, `/tmp/ceru-media-keys.log` | bundleIdentifier must be non-nil for MediaRemote routing; 10s Now Playing heartbeat; artwork cached per URL |
| Favorites list keeps jumping | `src/views/music/list.vue`, `src/components/Music/SongVirtualList.vue` | silent refresh must merge into existing row objects, never replace the array; cover directive re-observes only when the bound song really changed |
| Plugin/source mapping is wrong | `src/utils/playlist/pluginIdentity.ts`, `src/tauri-bridge.ts` | normalized source identity, plugin registry, duplicate IDs |
| Accessibility permission lost after every rebuild | `src-tauri/tauri.conf.json` (`bundle.macOS.signingIdentity`), `install-new-build.sh`, `.github/workflows/desktop-release.yml` | sign with the stable `Ceru Music Self-Signed` cert so the designated requirement is `certificate root = H"..."` (stable) instead of ad-hoc `cdhash` (changes every build); never re-sign with `codesign --sign -` after copying to /Applications; CI overrides back to `-` via `APPLE_SIGNING_IDENTITY` |
| App won't relaunch after a hard kill (double-click does nothing) | orphaned `mpv` child process | `kill -9` on the app leaves `Contents/Resources/mpv/bin/mpv` alive holding the LaunchServices registration; `pkill -f "mpv/bin/mpv"` restores launching |

## Query Commands

```bash
graphify query "How does playback resolve a URL and update the current source?"
graphify query "Where is the desktop lyric window geometry controlled?"
graphify explain "createTauriBridge"
graphify path "PlayMusic.vue" "node_sidecar_request"
```

After any architecture change, update this file and the maintenance log in
`AI_INDEX.md`.
