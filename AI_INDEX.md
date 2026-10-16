---

## 2026-10-16 启动遮罩预挂载化开 + macOS 原生麦克风授权

- **现象**：桌面端仍不像安卓端那样连续，主页首帧和星空淡出抢同一段主线程时间。
- **安卓参照**：`MainActivity.StartupPreloadOverlay` 先在 1.2s 挂主页，给 Discover/NavHost 1s 首帧准备；
  2.2s 开始 560ms 线性淡出，2.76s 透明后再留 90ms 卸载遮罩。星空渲染层自行计算淡出，
  不依赖 Compose 主线程动画。
- **修复**：桌面端改为同段时间轴：1.2s 路由到 `/home/find` 并在遮罩下挂载，遮罩先保持 1s；
  随后 560ms 线性透明度淡出，90ms 后卸载。主页首帧不与淡出重叠，播放恢复在遮罩卸载后开始。
- **权限**：新增 `permissions_request_microphone`，先调用 macOS `AVCaptureDevice` 原生授权，再进入
  WKWebView `getUserMedia`。Preview 实测已获得 MacBook Pro 麦克风、完成录音并返回搜索结果。
- 本次只改启动遮罩生命周期、共享过渡时间与麦克风权限边界；已编译唯一 Preview 测试包，暂不发布。

## 2026-10-16 发布中心补充项目来源署名

- 在发布中心 README 的标题介绍段落后新增来源说明：明确树夏Music 桌面版基于澜音 Music（Ceru Music）改进而来，并将原 Electron + Vue 架构迁移为 Tauri 2 + Rust + Vue 3。
- 在桌面端下载段落再次标注来源，并附上原项目 GitHub 与项目主页链接，感谢澜音团队的原项目与设计基础。
- 本次调整只涉及发布页 README（GitHub + Gitee），不改变软件界面、播放、插件、同步或发布架构。

## 2026-10-16 听歌识曲权限提示与并发修正 + 桌面版 v1.1.5 发布准备

- **复现**：测试 `1.1.4` 时点击麦克风后同时出现“麦克风权限未开启”和“启动麦克风采集失败”。录音启动函数
  只检查 `running`，快速点击会并发执行两个 `start()`：一次进入权限拒绝分支，一次进入 `getUserMedia`
  异常分支，形成两条提示。
- **修复**：`src/views/music/recognize.vue` 增加 `status === 'initializing'` 启动互斥，细分
  `NotAllowedError`、设备占用/不可用和其它采集错误；已重置 `com.shuxiamusic.tauri` 的 macOS 麦克风
  TCC 记录，下次点击应重新弹出系统授权。
- 开发版实测听歌识曲可用，版本升级为 `1.1.5`，开始公开 Runner 发布；正式版 `1.1.4` 不再作为
  听歌识曲修复载体。

## 2026-10-16 源码可见性调整：桌面公开、安卓源码收回

- `maiga512/shuxiamusic-desktop` 已改为 **public**，描述改为公开桌面端 Tauri 源码；真实更新签名私钥和密码仍在
  `.gitignore`，桌面仓库历史审计未发现提交私钥或令牌。
- `maiga512/shuxiamusic-release` 与 `songsong2020/shuxiamusic-release` 的 Git 历史已全量重写，仅保留
  `README.md`、`CHANGELOG.md`、`.gitignore`、`screenshots/product/*` 和公开构建工作流；
  `app/src`、Gradle、Android 资源、服务器、技能和临时目录不再出现在任何公开分支/Tag 树。
- Release 附件未删除：GitHub/Gitee 桌面安装包、Android APK、插件和 `latest.json` 均继续可下载；
  旧 Tag 的源码包已重写为 Release 中心最小树，不再暴露安卓源码。
- 公开工作流 `Desktop Release Public` 已删除 `SOURCE_REPO_TOKEN`，改为直接 Checkout 公开桌面仓库；
  公开仓库只保留签名和 Windows MPV Secrets。
- 索引记录新增：`公开桌面源码`、`安卓不开源`、`发布仓库历史清理`。

## 2026-10-16 低音增强去“假”：收窄低架 + 低中频防糊

- **用户反馈**：上一版低音增强听感发假、泛轰，不如成熟方案自然。根因是 `lowshelf@200Hz` 连 150–200Hz 一起抬高，再叠加 `tanh` 谐波，容易形成低中频淤积和人工染色。
- **公开方案对照**：GitHub `AnonymousV73X/WINDOWS-MUSIC-PLAYER` 的 EQ 引擎用低架和 headroom 做 Bass Boost；`Gomtanga/timbredock` 的 CircuitBass 把 shelf 收在约 68–92Hz、单独控制 body，并显式做 headroom/output protection。并联低通干湿支路经频率响应实测会产生相位抵消，不能交付。
- **本版实现**：用 `lowshelf@80Hz` 承担滑杆的真实 dB 增益，再在 `170Hz` 做 `-12%` 的轻度回撤，专门压住 150–200Hz 泛轰；不再使用 `asoftclip/tanh/WaveShaper` 或相位敏感的并联低通。
- **验证**：`+6dB` 对 80Hz 以下保留 +6dB 低架关系，170Hz 只回撤约 0.72dB；Rust 测试覆盖正/负增益、mud control 与无饱和滤镜，内置 MPV 实际建图检查通过。已执行本地 `v1.1.4` 编译并验证 Mac 包。
- 索引：路由别名、Playback And Media 低音图和 handoff 同步更新，Graphify 重新索引。

## 2026-10-16 听歌识曲失败修复 + 桌面版 v1.1.4 发布准备

- **根因**：`src/views/music/recognize.vue` 只探测 `audio/webm;codecs=opus`，失败后仍硬编码回退
  `audio/webm`；macOS WKWebView 只支持 `audio/mp4` 时，`MediaRecorder`/`decodeAudioData` 链路会直接失败。
  最小回放已红灯复现：支持集合只有 `audio/mp4` 时旧逻辑仍选 `audio/webm`。
- **修复**：新增 `src/utils/audio/recorderMime.ts`，按 WebM Opus / WebM / MP4 AAC / MP4 / Ogg Opus
  顺序选择运行时真正支持的格式；无可用 MIME 时交给 `MediaRecorder` 默认格式，不再强塞 WebM。
  AFP 脚本改用根路径加载且失败必须抛出可见错误；麦克风权限拒绝会提示并打开系统设置；
  20 秒无结果会明确提示“未识别到歌曲”，不再静默停在失败态。
- **验证**：`npx tsx --test src/utils/audio/recorderMime.test.ts` 3/3 通过；网易
  `audio/match` 接口真实请求返回 HTTP 200（测试指纹 `result:null`，接口与响应结构正常）。
  包配置已有 `NSMicrophoneUsageDescription`，签名无 App Sandbox；权限是按需申请，不是启动期抢麦。
- 版本已准备为 `1.1.4`（`package.json` / `src-tauri/Cargo.toml` / `Cargo.lock`）。收到发布授权后，
  已本地编译并验证麦克风声明、录音格式与稳定自签 Mac 包；创建 `desktop-v1.1.4` 标签后传
  `source_ref=desktop-v1.1.4` 给公开 Runner，继续走公开构建路径。

## 2026-10-16 响度三档方向修正 + 低音谐波激励补齐

- **根因**：FFmpeg `dynaudnorm` 的 `g` 是高斯平滑窗口、`m` 是最大增益倍数、`s` 是可选传统压缩；旧代码把 `g=3` 误注释成“最多 +9dB”，且轻度/标准/强力的 `s=3/6/10` 方向相反（`s` 越小压缩越强），造成档位听感与标签不一致。
- **响度修正**：按官方语义改为 `gentle: g=61/r=0.12/m=3`、`standard: g=31/r=0.18/m=6`、`strong: g=15/r=0.25/m=10`，三档 `s=0` 保留局部动态，`r` 直接以 RMS 对齐感知响度。
- **低音修正**：MPV `@bass` 从单个 `lowshelf` 扩为与 Electron 一致的并联结构：低架主路 + `lowpass@160 -> tanh asoftclip -> highpass@90 -> wet mix`；Web Audio 回退链同步补 `WaveShaper` 激励支路。设置页低音预设高亮会跟随当前 dB，避免滑杆与预设标签脱节。
- **验证**：仓库内置 MPV 实际加载新低音图与三档 `dynaudnorm` 均 exit 0；FFmpeg 6 秒安静素材输出 RMS 约 `-37.6/-31.5/-27.1 dB`，强度按轻度 < 标准 < 强力递进。按用户要求未执行 Rust/前端编译。
- 索引：更新音效/低音增强路由别名、Playback And Media 滤镜说明与 handoff；Graphify 增量 + 文档语义合并刷新生成物（7951 nodes / 16768 edges / 447 communities，聚合 HTML 447 社区节点）。外部 Claude/子代理语义通道分别因 403 配额与上游加密消息错误不可用，最终按技能回退由当前 host agent 内联抽取三份改动文档。

## 2026-10-16 发布桌面版 v1.1.3（GitHub + Gitee，含插件附件）

- 版本号升级为 `1.1.3`（`package.json` / `src-tauri/Cargo.toml` / `Cargo.lock`），准备发布 Mac Apple Silicon 与 Windows x64 桌面安装包。
- 桌面 Release 当前保留两份可导入插件：`feiniu-service.js`（飞牛音乐服务 v1.2.1）、
  `shuxia-sync-service.js`（多端同步 v1.0.6）。旧文件名 `ceru-nas-sync-service.js` 已从
  GitHub/Gitee 的 `desktop-v1.1.3` 与 `desktop-latest` 全部删除，不再作为兼容附件分发。
- 发布目标：GitHub `maiga512/shuxiamusic-release` 的 `desktop-v1.1.3` / `desktop-latest`，以及 Gitee `songsong2020/shuxiamusic-desktop-release` 的同名 Release；插件文件与桌面安装包一起挂在桌面端 Release 下载区。
- **免额度构建方案（历史）**：`v1.1.3` 发布时桌面源码仍私有，公开 Runner 曾通过
  `SOURCE_REPO_TOKEN` 读取 `maiga512/shuxiamusic-desktop` 的 `desktop-v1.1.3` 标签；本次公开构建 run
  `38855267488` 四个 Job 全部成功。后续桌面源码已公开，Token 已删除，工作流改为直接 Checkout。
- **Gitee 1GB 总附件配额**：旧版本累计会导致 Windows 包上传 400。按用户指示删除旧
  `desktop-v1.1.1`、混杂 `desktop-latest`、`desktop-v1.1.2` 三个 Release 后重建，完整上传 Mac/Windows/签名/插件。
- GitHub 与 Gitee 的 `desktop-v1.1.3` / `desktop-latest` 均已发布；Gitee `latest.json` 已校验
  `version=1.1.3`，`darwin-aarch64` 与 `windows-x86_64` URL 均指向 Gitee。
- 发布中心 README 已同步 Windows/macOS 标注、桌面插件与 `.fpk` 安装说明；Gitee 镜像此前缺
  `screenshots/product` 目录，现已通过 Git 推送 8 个文件。README 引用的音乐、播客、播放器三张
  界面图从 Gitee 原始地址实测均返回 HTTP 200，SHA 与 GitHub 对齐。
- 索引更新记录发布边界、公开 Runner、Gitee 配额清理、版本与插件附件归属，不改变桌面运行时架构。

## 2026-10-16 存储管理审计 + 封面缓存纳入管理（查看/清除）

- **背景**：用户反馈"下载进缓存目录、本地缓存把下载的歌算缓存、封面/在线听歌不进缓存目录、封面/歌词标签是假菜单"。审计发现上一轮「存储管理收口」的代码改动（下载/缓存分目录、`isCache` 守卫、`CERU_DOWNLOAD_DIR`/`CERU_CACHE_DIR` env 注入、`onTaskCompleted→finalizeDownloadedTask` 标签写入、在线播放落盘 `maybeApplyPlaybackFileCache`）已在工作区且**完整可编译**（`cargo check` + `vue-tsc` 均 exit 0）。用户看到旧行为，多为**改动未提交、仍在跑旧安装包**。
- **审计确认（已正确，无需再改）**：① 主动下载 `isCache:false` + `addTask` 的 `canonicalDir` 守卫 → 落"下载目录"；② `markCompleted` 只对 `isCache` 任务 `addCacheEntry`，下载不计入"本地歌曲缓存"，另有 `selfHealMisfiledDownloadTasks` 兜底搬运历史错落文件；③ 在线听歌受 `autoCacheMusic` 控制，走 `getSongRealUrl→maybeApplyPlaybackFileCache` 落 `cacheDir/playback/`，命中播本地 `file://`，LRU 按上限淘汰；④ 目录 `saveDirectories` 持久化到 DB（key `download_dir`/`cache_dir`）+ 同步运行中 sidecar + 启动 env 注入，key 三处一致；⑤ `remap_legacy_storage_dirs` 启动纠正旧 `com.cerumusic.tauri` 死路径。
- **本次新增（真实缺口：封面缓存不可见/不可清）**：封面走 `cover_proxy` 独立磁盘缓存（`app_data_dir/cover-cache`，200MB 上限 + 30 天淘汰），此前不在"存储管理"里、用户看不到也清不掉，正是"为什么封面不进缓存目录/我完全没搞懂缓存机制"的落点。改动：
  - `src-tauri/src/commands/cover_proxy.rs`：新增 `cover_cache_info`（扫描 `.bin` 统计 size/count + 返回 `maxBytes`）与 `cover_cache_clear`（删除全部 `.bin`/`.meta`），共用 `cover_disk_dir` 取 `app_data_dir/cover-cache`。
  - `src-tauri/src/lib.rs`：注册两个命令（`cover_proxy` 已 `use ...::*` 通配导入）。
  - `src/tauri-bridge.ts`：新增 `window.api.coverCache = { getInfo, clear }`。
  - `src/views/settings/sections/StorageSection.vue`：在"本地歌曲缓存"下方新增"封面缓存"块（张数/占用 + 清空按钮 + 独立上限说明），`onMounted` 拉取信息。
- **概念澄清（写进 UI）**：三块互不混占——**下载目录**=点"下载"永久保存（写封面/歌词标签）；**本地歌曲缓存**=在线听歌自动落盘的音频（受"自动缓存音乐"开关 + 容量上限 LRU 控制）；**封面缓存**=列表/详情页封面，独立 200MB LRU。封面是独立有界缓存而非塞进歌曲缓存目录（`cover_proxy` 是常驻服务，迁移其运行期缓存位置风险高，故改为可见可清）。
- 验证：`cargo check` exit 0、`npx vue-tsc --noEmit` exit 0、`node --check sidecar/services/download/index.mjs` OK。**用户须重新出包**（改动均在工作区未提交，旧 `.app` 不反映修复）：设下载目录→下载→"打开目录"应到下载目录且本地歌曲缓存不再计这首；开"自动缓存音乐"在线听歌才落缓存目录；封面缓存在"存储管理"可见可清。
- 索引：TOP_GRAPH「Downloads / Storage」补"封面缓存纳入存储管理"；本条维护日志。

## 2026-10-16 替换设置页赞赏码图片

- `public/about_author_reward_qr.jpg` 替换为用户提供的 `IMG_7894.JPG`，源文件与项目资源 SHA-256 一致；新图为 `1152x1152` JPEG 方图。
- 展示入口保持不变：`src/views/settings/sections/AboutSection.vue` 的“设置 → 关于 → 关于我”继续读取同一资源路径。
- 本次仅替换静态图片资产，不改变页面布局、路由或数据流；按资源规则登记路径与归属，不对图片目录做语义展开。

## 2026-10-16 存储管理收口：下载/缓存分目录 + 下载标签真正生效

- **用户现象**：设好"下载目录"后点下载，文件却落到"缓存目录"，且"本地歌曲缓存"把这首下载的歌算成"已缓存一首"；封面/标准歌词/逐字歌词选项像是假菜单（选完没效果）。
- **根因一（下载进缓存目录）**：主下载走 Node sidecar，但其 `state.downloadDir/cacheDir` 只在"打开过设置页 / 点保存"时才从 Rust DB 同步（`saveDirectories`/`DirectorySettings.onMounted`）。冷启动直接下载会用默认 `appDataDir/downloads`，且配置值可能仍指向旧 bundle id `com.cerumusic.tauri`。修复：`node_sidecar.rs::spawn_sidecar` 读 DB `download_dir`/`cache_dir` 以 env `CERU_DOWNLOAD_DIR`/`CERU_CACHE_DIR` 注入 sidecar；`download/index.mjs::initializeSystem` 优先用 env（未注入才回退默认）→ sidecar 一启动就落在用户配置目录，不再依赖设置页。
- **根因二（下载被当缓存 / 缓存页统计串味）**：`normalizeTask` 丢掉 `isCache`，`markCompleted` 无法判断登记缓存索引；磁盘重建索引会扫进落在 cacheDir 的下载文件。修复：`normalizeTask` 保留 `isCache`；`addTask` 加守卫——非缓存任务若解析到 cacheDir 下就纠正回 `state.downloadDir`。
- **根因三（旧路径死值）**：`cache_dir`/`download_dir` 可能写死旧 `com.cerumusic.tauri`。新增 `lib.rs::remap_legacy_storage_dirs` 启动时把这类前缀纠正回当前 `app_data_dir` 并回写（配合 `migrate_legacy_app_data`）。
- **根因四（标签假菜单）**：Node 下载引擎只落盘音频字节，封面/基础信息/歌词从不写入。新增 Rust 命令 `download_finalize_metadata`（`download_engine.rs`，复用 `finalize_download_metadata`，exiftool 加 `/opt/homebrew`、`/usr/local/bin` PATH 兜底）；渲染层 `store/download.ts` 在 `onTaskCompleted` 调 `utils/audio/download.ts::finalizeDownloadedTask`：按 `tagWriteOptions`（basicInfo/cover/lyrics/downloadLyrics + `lyricFormat` 标准/逐字）按需 `getLyric` 抓歌词后经 bridge `download.finalizeMetadata` 下发真正写文件。
- **验证**：`cargo check`（仅既有告警）、`npx vue-tsc --noEmit`、`node --check sidecar download` 均通过。实机验收：设下载目录→下载→"打开目录"应到下载目录且不再进缓存/被 LRU 淘汰；开"自动缓存音乐"在线听歌才落缓存目录；下载完勾选的封面/歌词应真正写进文件。
- 索引：TOP_GRAPH「Downloads」补"下载 vs 缓存分目录"段；本条维护日志 + 新增路由别名。

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
  - 我的歌单
  - 本地歌单
  - 歌单刷新闪烁
  - 歌单封面角标
  - 歌单更新时间
  - 赞赏码
  - 打赏码
  - 飞牛插件
  - 多端同步插件
  - 桌面版发布
  - 公开 Runner
  - Actions 扣款
  - Gitee 附件配额
  - 公开桌面源码
  - 安卓不开源
  - 发布仓库历史清理
  - 听歌识曲失败
  - 麦克风权限
  - MediaRecorder WebM MP4
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
last_indexed: 2026-10-16
graph_stats_source: graphify-out/GRAPH_REPORT.md
---

## 2026-10-15 本地歌单卡片压缩与后台刷新闪烁修复

- `src/views/music/songlist.vue`：来源标识移到封面左下角，更新时间以“更新于 / 日期时间”两行放到封面右下角，删除卡片下方独立来源与时间区域并收紧信息、操作区间距。
- 刷新反馈拆分为首次加载、手动刷新和后台静默同步；并发歌单加载与云端收藏刷新使用共享 Promise 合并，后台同步不再驱动刷新按钮转圈或让整块网格透明度闪烁。
- 本次为歌单卡片 UI 与刷新状态收口，不改变歌单数据模型、同步契约、路由或 Top Graph 跨模块流。
- 验证：`npx vue-tsc --noEmit` 与 `npm run build` 通过；纯浏览器预览受 Tauri `window.api` 缺失限制，生产构建可正常编译。

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
- Desktop startup schedules a delayed background check (idempotent scheduler in `src/main.ts`; re-focusing the window no longer re-schedules a new 15s check) and repeats it every six hours when `autoUpdate` is enabled. A discovered update opens a global progress dialog (`src/components/UpdateDialog.vue`); the download shows a progress bar, and the actual install (in-place `.app` replace + relaunch) only happens when the user clicks "重启安装". Manual "检查更新" shows the dialog and waits for the user to click "立即更新".
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
| Discover and playlists | `src/views/music/find.vue`, `src/views/music/songlist.vue`, `src/views/music/list.vue` | `src/utils/playlist/playlistManager.ts`, `src/services/music/*` |
| Local music | `src/views/music/local.vue` | `src-tauri/src/commands/local_music.rs`, `src-tauri/src/db.rs` |
| Listen together | `src/store/ListenTogether.ts` | `src/api/listenTogether.ts`, `src/components/ListenTogether/*` |
| NAS/cloud sync | `src/api/nasSync.ts` | `src/services/nasSyncPoller.ts`, `src/utils/playlist/cloudLibrarySync.ts` |
| Settings | `src/views/settings/index.vue` | `src/components/Settings/*`, `src/store/Settings.ts` |
| Global hotkeys and media keys | `src-tauri/src/hotkeys.rs`, `src-tauri/src/now_playing.rs` | `src/components/Settings/HotkeySettings.vue`, `src/utils/hotkeys/recording.ts`, `src/utils/audio/useSmtc.ts` |
| 赞赏码、打赏码、请我喝杯咖啡、关于我图片 | reward QR image asset ownership | `public/about_author_reward_qr.jpg`, `src/views/settings/sections/AboutSection.vue` |

## Search Aliases

Use these aliases when searching issues, handoffs, or graph nodes:

| User wording | Canonical concepts | Primary files |
| --- | --- | --- |
| 左侧栏、侧边栏、导航栏、树夏Music 标题、侧栏居中、菜单间距 | main layout sidebar, logo-section, nav-section | `src/components/layout/HomeLayout.vue` |
| 收藏星、切源掉星、换源收藏丢失、换源爱心丢失、喜欢状态、取消收藏、重启后掉收藏、列表心形、底栏封面/歌名换源漂移 | favorite anchor（切源前用户选中身份）、`_originalIdentity`（换源队列项携带的原收藏身份，随 list 持久化、重启恢复锚点）、跨源身份匹配 `findFavoriteSongByIdentity`（歌名+歌手，精确 source:songmid 未命中时按歌曲本身判心形/删记录）、底栏锚点优先展示 `displayAnchor`/`displaySongName`/`displayCoverSrc`、source fallback、我的喜欢歌单、`favoriteSongKey`/`isLiked` 按原曲判定 | `src/store/GlobalPlayStatus.ts`, `src/components/Play/PlayMusic.vue`, `src/components/Music/SongVirtualList.vue`, `src/utils/playlist/cloudLibrarySync.ts`, `src/utils/audio/globaPlayList.ts` |
| 音源、切源、源切换、wyy、mg | current source, plugin candidates, fallback, source identity | `src/utils/audio/audioHelpers.ts`, `src/tauri-bridge.ts` |
| 音质、可用音质、下载音质、320K、无损 | preferred quality, plugin qualitys, declared quality, download source | `src/utils/audio/qualityAvailability.ts`, `src/utils/playlist/playlistManager.ts` |
| 播放慢、点播没反应、播客播放 | URL resolution, media gateway, native audio, MPV, sidecar latency | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/mediaGateway.ts` |
| 切歌慢、上一首、下一首、飞牛 401 | cache-hit syntax, Feiniu stream proxy, prev/next immediate | `src/utils/audio/globaPlayList.ts`, `src/tauri-bridge.ts`, `src-tauri/src/commands/media_stream_proxy.rs` |
| 快捷键、全局热键、自定义快捷键、媒体键、系统原生媒体键、键盘上一首下一首、F7 F8 F9、CommandOrControl 跨平台、启动自动播放 | global hotkeys, native media keys (OS-adapted), Now Playing, autoPlayOnLaunch | `src-tauri/src/now_playing.rs`, `src-tauri/src/hotkeys.rs`, `src/components/Settings/HotkeySettings.vue`, `src/store/playSetting.ts` |
| 首次播放慢、启动后点播慢 | plugin worker prewarm, legacy initialize channel, sidecar initialization dedupe | `src/main.ts`, `src/tauri-bridge.ts`, `sidecar/services/plugins/index.mjs` |
| 发现慢、歌单慢、播客加载慢 | request sequencing, stale response, session cache, concurrent fetch | `src/views/music/find.vue`, `src/views/music/podcast.vue`, `src/utils/cache/sessionCache.ts` |
| 发现/播客/歌单切走或重启重新加载、切 tab 重载、记住几排、列表缓存、会话级缓存、跨重启秒开、关 App 后列表还在、切板块一直秒出不闪、重启才刷新、无感更新 | session-level TTL + localStorage persistence (in-memory hot layer / localStorage cold layer fallback), SWR revalidate; 切板块=KeepAlive 常驻 + `onActivated` 不 fetch（无限期纯缓存秒出）；`SESSION_TTL_MS`, `persist` flag, `fetchedAt` freshness window (30min = skip request), `APP_LAUNCH_TS`（fetchedAt 早于本次启动 = 重启后首进必静默刷新、先秒出缓存） | `src/utils/cache/sessionCache.ts`, `src/views/music/find.vue`, `src/views/music/podcast.vue`, `src/views/music/songlist.vue`, `src/utils/navigation/homePrefetch.ts` |
| 点发现/播客/歌单重影、切页重影、抽屉残影、切页卡一下、旧页还留在下面 | page transition leave must be hidden in the same frame (`visibility:hidden` on `.page-leave-active`; Vue removes old page DOM only after one `nextFrame`) | `src/views/home/index.vue` |
| 桌面歌词、歌词锁定、双排歌词 | lyric window lifecycle, logical pixels, drag, resize, reveal | `src-tauri/src/commands/lyric_window.rs`, `src/views/DeskTopLyric/DeskTopLyric.vue` |
| Dock、底栏、全屏播放、卡顿 | dock layout, full player transition, visualizer, background | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` |
| 全屏手势、双指滑、捏合全屏、封面模式、黑胶、手势闪退 | two-finger cover/vinyl swipe, pinch window fullscreen, frontend-only | `src/components/Play/FullPlay.vue`, `src/store/playSetting.ts` |
| 启动动画、欢迎页化开、星空衔接、进主页动画、主页首帧预挂载 | welcome overlay lifecycle, home prepare-ahead, linear starfield fade | `src/views/welcome/index.vue`, `src/App.vue`, `src/utils/navigation/welcomeTransition.ts` |
| 听歌识曲权限、麦克风授权、macOS microphone permission | native AVCaptureDevice permission before WKWebView getUserMedia | `src-tauri/src/permissions.rs`, `src/tauri-bridge.ts` |
| 底栏进度一格一格、进度条跳、匀速进度 | dock bar compositor remaining-duration animation; Pinia/mpv clock stays 1s | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` |
| 全屏内存不回落、退出全屏内存、最小化内存、回主页内存、板块切换不重载 | hide/minimize release FullPlay heavy tree; list covers keep hot layer decoded, drop cold decoded bitmaps; KeepAlive group stays cached while the window is only occluded/backgrounded (shrinks to current page only after 1h off-screen) | `src/components/Play/FullPlay.vue`, `src/components/sImage.vue`, `src/views/home/index.vue` |
| 全屏底栏要点两下、Dock 唤醒、自动隐藏底栏 | idle dock wake strip, pointerdown, WKWebView transform hit-testing | `src/components/Play/PlayMusic.vue`, `src/components/Play/FullPlay.vue` |
| 全屏按钮退出后顶部一条黑条、黑条带到歌单页、全屏盖不住菜单栏/状态栏、全屏不是真全屏 | macOS 全屏路径**完全不用 Tauri 窗口 API**，整个进入/退出放进**同一个**主队列 AppKit 任务（`dispatch_async_f`+`_dispatch_main_q`）里按固定顺序执行。原因：tao 0.37 的 `set_decorations(true)` 设成 `Closable\|Miniaturizable\|Resizable\|Titled`（**丢掉 `FullSizeContentView`**）→ 内容被标题栏下推、顶部露黑条；`set_always_on_top(true)` 设 `NSFloatingWindowLevel(3)`（低于菜单栏 24）且异步；`set_position`/`set_size` 走事件循环而 `set_decorations` 走 GCD，两条队列顺序不可控；且增删 `FullSizeContentView` 本身会改变 frame 高度（=标题栏高）。进入：存 AppKit `frame`/`level`/`isZoomed` → 取消 zoom → 去掉 `Titled` → `setFrame:` 到 `[window screen].frame`（含菜单栏的完整屏幕）→ `setLevel: 1000`。退出：恢复 Overlay mask（含 `FullSizeContentView`）+ 透明标题栏 + 隐藏标题 + 隐藏红绿灯 → **再**写回保存的 frame（顺序关键）→ 恢复 level/zoom | `src-tauri/src/windowed_fs.rs`, `src-tauri/Cargo.toml` |
| 全屏双指横滑切封面来回跳、滑一下切好几下、触控板甩动重复切换 | 滑动段锁存：过 48px 触发一次后 `latched=true`，之后所有 wheel 事件一律忽略，**只有相邻事件的 `event.timeStamp` 间隔 > 250ms**（真的停手）才解锁（另加 2s 锁存硬上限兜底，防某些 WebKit 路径 `timeStamp` 不推进导致手势只能用一次）。必须用 `event.timeStamp`（事件生成时刻）而非 `performance.now()`（处理时刻）——切 layout 会整块换 CD/方形封面模板阻塞主线程，排队事件成批处理时 `performance.now()` 间隔看起来像"新的一甩"，就是"滑一下来回跳"的根因 | `src/components/Play/FullPlay.vue` |
| 窗口按钮、最大化、最小化、关闭、设置点不了、标题栏拖拽 | window drag strip, TitleBarControls hit-testing, FullPlay overlay stacking | `src/App.vue`, `src/components/TitleBarControls.vue`, `src/components/Play/FullPlay.vue`, `src/utils/windowDrag.ts` |
| 播客封面变大、一排 4 个封面撑大、播客网格 | 固定封面轨道 `--cover-size`，不用 `1fr` 撑满 | `src/views/music/podcast.vue` |
| 更新一直弹「正在检查更新」、切窗口反复检查、更新没进度条、装完自动覆盖重启、在线升级流程 | 更新走**状态机** `phase: idle/checking/available/downloading/downloaded/error`（`src/services/autoUpdateState.ts` 纯状态，避免 `window.api` 未就绪即实例化服务）。`checkForUpdates` 只检查+记录、不下载；`downloadUpdate` 复用缓存 `rid` 不再 re-check；**只有 `quitAndInstall()`（用户点“重启安装”）才 `relaunchApp()`**。发现新版 → 全局 `src/components/UpdateDialog.vue`（进度条含不定长兜底/速度）→ 下载完成弹“重启安装”由用户确认。后台静默检查发现新版自动下载(带进度)、不弹“正在检查更新”；手动“检查更新”只弹对话框等点“立即更新”。`main.ts`：幂等调度器（`autoUpdateScheduled`+`autoUpdateFirstTimer`）杜绝切窗口重排 15s 检查；`createTauriBridge()` 后动态初始化服务 + `initFromPersistedState()`（启动时若上次 pending **且** 当前运行版本 < 待安装版本才弹「重启安装」；当前版本已 >= 待安装版本视为“刚更新完重启过来、已生效”，`compareVersions` 判定后清 pending（`recordEvent UPTODATE`）不再弹——否则每次启动都弹、点了又重启回同版本，来回跳）。更新器配置/下载通道见 `src-tauri/tauri.conf.json`（Gitee+GitHub `latest.json`） | `src/main.ts`, `src/services/autoUpdateService.ts`, `src/services/autoUpdateState.ts`, `src/components/UpdateDialog.vue`, `src/tauri-bridge.ts`, `src/stubs/tauri-plugin-updater.ts`, `src-tauri/tauri.conf.json` |
| 快进 CPU、拖进度 CPU、seek 占用 | 拖动只改 UI，松手才 `nativeSeek`；短峰来自 mpv 重新解码 | `src/components/Play/PlayMusic.vue`, `src/utils/audio/nativePlayback.ts` |
| 音效点一下等一下、环绕房间卡、响度标准延迟 | mpv 带标签滤镜增量替换，换档只换 `@loud`/`@sur` | `src-tauri/src/commands/mpv_player.rs`, `src/utils/audio/nativePlayback.ts` |
| 麦克风权限、启动弹窗、均衡器、高级音效、MPV lavfi | startup microphone permission, mpv audio filters, bass/surround/loudness | `src/App.vue`, `src-tauri/src/commands/mpv_player.rs`, `src/utils/audio/nativePlayback.ts` |
| 响度均衡标反、轻度/标准/强力、dynaudnorm 参数、低音增强不对劲、低音假、低音闷、低音轰、bass boost | loudness strength preset mapping (`dynaudnorm g/m/r/s`), 80Hz lowshelf with real dB gain plus 170Hz mud cut, no saturation | `src/components/Settings/AudioEffectSettings.vue`, `src/utils/audio/audioManager.ts`, `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs` |
| 项目来源、澜音 Music、Ceru Music、Electron 改成 Tauri、架构迁移署名 | Release-center README project attribution and architecture migration disclosure | `docs/RELEASE_DUAL_PLATFORM.md`, `scripts/ci/update-hub-readme.py` |
| 音量百分比不真实、滑条不灵敏、80%就很小、50%不像一半响度、拖到 0% 弹回去、0% 点不了 | 等比例（线性增益）音量：mpv 的 `volume` 实测是三次曲线 `gain=(volume/100)^3`（50→-18dB、80→-5.8dB），故 `sliderToMpvVolume(p)=100*cbrt(p/100)` 反解它，使最终增益=滑条百分比（100%=设备满刻度即系统音量的完整音量，50%→-6dB，0%=静音；与 Electron `audio.volume=v/100` 一致）。**0% 是合法值**：`nativeLoad`/`nativeSetVolume`/`LocalUserDetail.init`/`PlayMusic.vue` watcher 里所有 `volume<=0 → 80` 的强制改写已移除（只有非数字/越界才回退 80），否则拖到底部会立刻弹回 80%。前端保持百分比域展示/持久化，仅下发 mpv 时换算；Rust `mpv_set_volume` 与前端 IPC 合并去抖阈值 0.25（mpv 音量域）；DLNA 同步仍发原始百分比 | `src/utils/audio/nativePlayback.ts`, `src/store/LocalUserDetail.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/PlayMusic.vue` |
| 下载完点文件夹图标没反应、打不开下载目录、找不到文件位置 | 下载列表的文件夹图标走 `download.openFileLocation` → Node sidecar `open -R`/`explorer /select`/`xdg-open`；此前 `sidecar/index.mjs` 漏注册该路由（服务实现存在但调用抛 `Unsupported sidecar method`，被 bridge 静默吞掉），已补注册；bridge 改 strict 调用 + store 对空响应/无路径弹提示 | `sidecar/index.mjs`, `sidecar/services/download/index.mjs`, `src/tauri-bridge.ts`, `src/store/download.ts`, `src/views/download/index.vue` |
| 下载进缓存目录、下载目录不生效、本地歌曲缓存把下载的歌算缓存、封面/歌词/逐字歌词选了没效果（假菜单）、自动缓存音乐、缓存容量上限 LRU、com.cerumusic 旧路径 | **下载 vs 缓存分目录不变量**：主下载走 Node sidecar（`isCache=false`）→ 配置目录在 `node_sidecar.rs::spawn_sidecar` 以 env `CERU_DOWNLOAD_DIR`/`CERU_CACHE_DIR` 注入、`download/index.mjs::initializeSystem` 优先用（不再依赖打开设置页才同步）；`normalizeTask` 保留 `isCache`、`addTask` 守卫非缓存任务不落入 cacheDir；在线听歌自动缓存受 `autoCacheMusic` 控制走 `musicCachePlaybackCache`（cacheDir/playback，LRU 淘汰见 `evictCacheIfNeeded`）；标签写入由渲染层 `finalizeDownloadedTask`（`utils/audio/download.ts`）在 `onTaskCompleted` 调 Rust `download_finalize_metadata`（复用 `finalize_download_metadata` + exiftool Homebrew PATH 兜底）补写封面/基础信息/标准·逐字歌词；遗留 `com.cerumusic.tauri` 存储路径由 `lib.rs::remap_legacy_storage_dirs` 启动纠正 | `sidecar/services/download/index.mjs`, `src-tauri/src/commands/node_sidecar.rs`, `src-tauri/src/commands/download_engine.rs`, `src-tauri/src/lib.rs`, `src/tauri-bridge.ts`, `src/store/download.ts`, `src/utils/audio/download.ts`, `src/components/Settings/DirectorySettings.vue`, `src/components/Settings/MusicCache.vue` |
| 封面缓存、封面不进缓存目录、封面缓存清除/占多少、缓存机制没搞懂、封面/在线听歌算不算缓存 | **封面缓存 = 独立有界 LRU**：`cover_proxy` 常驻服务的磁盘缓存（`app_data_dir/cover-cache`，200MB 上限 + 30 天淘汰），独立于"歌曲缓存"、不塞进用户缓存目录（迁移运行期缓存位置风险高，改为可见可清）。`cover_cache_info`/`cover_cache_clear`（Rust）+ `window.api.coverCache`（bridge）+ `StorageSection.vue`"封面缓存"块（张数/占用 + 清空 + 独立上限说明）。下载目录 / 本地歌曲缓存 / 封面缓存三者互不混占 | `src-tauri/src/commands/cover_proxy.rs`, `src-tauri/src/lib.rs`, `src/tauri-bridge.ts`, `src/views/settings/sections/StorageSection.vue` |
| 发布桌面版、GitHub/Gitee 双平台、Windows 包、artifact 配额、更新器 latest.json | 推送 tag `desktop-v<版本>` 触发 `Desktop Release`；构建作业把安装包**直传** `maiga512/shuxiamusic-release` 的 `desktop-latest`（不走 actions/upload-artifact，免费额度 500MB 容易被顶满），`publish` 作业等两平台结束后 `gh release download` 取回产物生成 `latest.json` 并清理历史附件；Gitee 侧本机跑 `scripts/ci/publish-gitee-local.sh <工作目录> <版本> "<说明>"` 直传（GitHub 境外 runner 跨境传 Gitee 会限速）。Gitee 的 `desktop-latest` 若混有旧版本附件需先 DELETE 整个 Release 再重建（Gitee API 不返回附件 id） | `.github/workflows/desktop-release.yml`, `scripts/ci/publish-gitee-local.sh`, `scripts/ci/publish-gitee.py`, `scripts/ci/make-latest-json.py`, `docs/RELEASE_DUAL_PLATFORM.md` |
| 重打包后辅助功能权限又没了、签名每次都变、能不能固定签名 | 用固定自签证书签名：`tauri.conf.json` 的 `bundle.macOS.signingIdentity = "Ceru Music Self-Signed"`（keychain 里已有该证书，含 Code Signing EKU）。ad-hoc(`-`) 的 designated requirement 是 cdhash（二进制哈希），每次重编译都变 → TCC 辅助功能权限失效；证书签名后 DR 变成 `identifier "com.cerumusic.tauri" and certificate root = H"..."`，只跟证书有关，跨版本稳定。安装时**不要**再 `codesign --sign -` 重签（`install-new-build.sh` 已改）。CI 无该证书，用 `APPLE_SIGNING_IDENTITY: "-"` 覆盖回 ad-hoc | `src-tauri/tauri.conf.json`, `install-new-build.sh`, `.github/workflows/desktop-release.yml` |
| 强杀 App 后双击打不开、LaunchServices 认为还在运行 | `kill -9` 会留下孤儿 mpv 进程（`Contents/Resources/mpv/bin/mpv`）占着 LaunchServices 注册，普通 `open` 只去激活那个已死的实例；`pkill -f "mpv/bin/mpv"` 后即可正常启动 | `src-tauri/src/commands/mpv_player.rs`（正常退出走 `mpv_shutdown`，只有硬杀才会漏） |
| 摘下耳机暂停、戴上又自动播、耳机自动恢复、耳机插拔后自己播放 | 抑制 macOS 在输出设备变化时替 App 发的系统媒体指令：`app-audio-device-changed`（Rust `audio_device.rs` 监听 CoreAudio `kAudioHardwarePropertyDefaultOutputDevice`，WebView `devicechange` 仅兜底）后 6s 内、或系统 `pause` 真的暂停后 4s 内，系统来源（`source=media`）的 `play` 忽略、`pause` 只当暂停（不再 toggle 成播放）；窗口外保留 toggle 语义兜底系统状态感知滞后；App 内播放按钮不受影响 | `src/utils/audio/globaPlayList.ts`, `src/utils/audio/nativePlayback.ts`, `src-tauri/src/audio_device.rs`, `src/tauri-bridge.ts` |
| 换输出设备没声、蓝牙连/断没声、睡眠唤醒没声、音频不跟随系统、最小化恢复窗口声音卡一下 | macOS CoreAudio AO 静默死亡恢复:`app-audio-device-changed`(Rust `audio_device.rs` 监听 CoreAudio 默认输出设备)+`devicechange`(800ms 防抖,兜底)+`app-system-wake`(Rust `system_power.rs` 监听 NSWorkspace didWake) 触发 `mpv_reload_audio_output`，`aid` 循环重建 AO（单飞+1.5s 冷却+失败软处理）；窗口级唤醒 `ceru-wake`（最小化/恢复/15s 闲置）只对齐进度时钟、绝不重建 AO | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/audio_device.rs`, `src-tauri/src/system_power.rs`, `src-tauri/src/commands/mpv_player.rs`, `src/tauri-bridge.ts` |
| 环绕、卷积、混响、afir、IR | WebKit-normalized surround IR, afir dry/wet mix | `src-tauri/src/commands/mpv_player.rs` |
| 内存、CPU、进程占用 | sidecar lifecycle, Rust buffers, cache growth, image cache | `src-tauri/src/commands/node_sidecar.rs`, `sidecar/index.mjs`, `src/utils/cache/sessionCache.ts` |
| CPU 160%、localhost 70%、倍速死循环、canplay 刷屏 | mpv playback rate loop, custom-protocol IPC storm, hot log `set_rate` | `src/utils/audio/nativePlayback.ts`, `src-tauri/src/commands/mpv_player.rs`, `src/components/Play/PlayMusic.vue` |
| localhost 400MB、内存、封面解码、hover 模糊底 | list covers decode 96, dock 128, cards 384; cold decoded bitmaps release on hide; HTTP cache remains | `src/utils/coverThumb.ts`, `src/components/sImage.vue`, `src/views/home/index.vue` |
| 设置 CPU、设置页切模块、插件管理占用 | 设置分类按需挂载，切走即卸载，设备扫描有列表就跳 | `src/views/settings/index.vue`, `src/views/settings/sections/PluginSection.vue`, `src/views/settings/sections/PlaybackSection.vue` |
| 插件、插件配置、插件安装 | plugin registry, sandbox, worker, source mapping | `sidecar/services/plugins/index.mjs`, `src/utils/plugin/pluginSandbox.ts` |
| 插件在线升级、更新失败、浏览器打不开 | plugin update download validation, system browser fallback | `src/components/PluginNoticeDialog.vue`, `src/tauri-bridge.ts` |
| 洛雪插件、洛雪歌单、导入失败、设置页空白 | lx includes check, `.lxmc` gzip playlist parsing, convertEventDrivenPlugin, pluginInfo fallback | `src/utils/playlist/playlistExportImport.ts`, `src/tauri-bridge.ts`, `src/components/Settings/plugins.vue` |
| 查重清理、歌单重复、一键清理、按建议勾选 | duplicate groups expanded, keep/delete per song, selected cleanup | `src/components/Music/DuplicateSongsDialog.vue`, `src/views/music/list.vue` |
| 我的歌单、本地歌单、歌单卡片太长、LOCAL、更新于、封面左下角、封面右下角、刷新图标闪烁、后台一直刷新 | playlist card cover metadata, compact playlist info, manual refresh loading, silent background refresh, concurrent refresh coalescing | `src/views/music/songlist.vue` |

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

| 2026-10-16 | **发现/播客「切板块永远秒出、重启才刷新」澄清 + 新鲜窗口放宽到 30 分钟**（用户追问：10 分钟新鲜缓存是不是只保留 10 分钟？能不能一直都不闪、一直切一直有、有更新就无感更新、或者重启时才刷新）。先澄清一个误解：**来回切板块（发现/播客/歌单）本就永不重拉数据**——页面 KeepAlive 常驻内存、`onActivated` 只恢复滚动不 fetch、封面 5 分钟内保持解码，所以"点了就有、不闪"是**无限期**的，不受任何分钟数限制。那个"10 分钟"只决定**本次启动后第一次进页 / 切分类**时要不要后台静默补一次新数据（无骨架、无转圈、卡片原位更新）。据此两处微调：① `src/utils/cache/sessionCache.ts` 新增导出 `APP_LAUNCH_TS = Date.now()`（模块在启动时被首次 import，初始化时刻 ≈ 启动时刻），用来区分"本会话拉过的缓存"与"上次启动遗留的持久化缓存"；② `find.vue` 的 `DISCOVER_FRESH_MS` 10→30 分钟，新鲜判断从 `age < 窗口` 收紧为 `fetchedAt > APP_LAUNCH_TS && age < 窗口`（须是本次启动拉过）；③ `podcast.vue` 的 `PODCAST_PAGE_FRESH_MS` 同样 10→30 分钟、加 `freshThisSession` 判断。**效果**：会话内切来切去永远是纯缓存秒出（30 分钟内连后台刷新都不发）；重启后第一次进页因 `fetchedAt` 早于本次启动 → 视为需刷新 → **先秒出持久化缓存、后台静默更新**，即"重启即刷新"且全程不空不闪。`songlist.vue` 已是同套 SWR（`playlists` 直接从 sessionCache 初始化 + 后台合并云端，`loading` 仅在无数据时点亮），无需改。 | `vue-tsc --noEmit` exit 0；graphify 增量重建 7906 nodes / 16503 edges / 485 communities，`graph.html` 按社区聚合导出 485 社区节点 / 899 跨社区边（>5000 节点自动聚合）。 |
| 2026-10-15 | **板块切换「重影 / 每次都加载」根因修复 + KeepAlive 不再被窗口可见性误伤**（用户诉求：点发现/播客/歌单不要重影；最小化再回来直接就有界面；板块间切换不要每次都加载、闪一下；同时尽量省内存）。诊断三宗根因：① `src/views/home/index.vue` 把 KeepAlive 的 `include`/`max` 绑在窗口可见性上（不可见就收缩成当前页）——macOS 下窗口被别的窗口遮住、切到其它 App、最小化都会让 `windowVisible=false`，而 `include` 一变 Vue 立刻 `pruneCache` 把其余缓存页 `unmount`，再切回来就是冷启动（骨架 + 重新拉网络 + 重新解码封面），这是「经常要加载一下才出来」的真凶；② `.page-leave-active` 缺 `visibility:hidden`——Vue 把旧页 DOM 移出文档要等一个 `nextFrame`，主线程忙着挂载新页时这一帧能拖到上百毫秒，旧页与新页左滑入同屏 → 肉眼重影；③ `sImage` 封面解码位图切走 tab 仅 60s 就释放，切回来整屏封面重走代理 + 重新解码 + 淡入 → 「闪一下」。改动：① KeepAlive 组恒定（`max=5`、`include=KEEP_ALIVE_PAGES`），只有「窗口真的不在屏幕上（最小化 / 托盘隐藏 / Cmd+H）」且持续 **1 小时** 才收缩回收内存（判断不再用 `document.hidden`，避免「被别的窗口遮住」这种听歌常态误伤），回到前台立刻恢复整组；② `.page-leave-active` 加 `visibility:hidden; pointer-events:none`，旧页首帧即让位、露出 `.content` 底色；③ `sImage` 释放分档：窗口隐藏 → 立即释放（原行为不变），整页被 KeepAlive 切走（`!el.isConnected`）→ 5 分钟宽限，仅滚出视口 → 60s；④ SWR 不再「先给缓存再后台换一遍」：`find.vue` 缓存条目加 `fetchedAt`，10 分钟内新鲜缓存直接复用（不发请求、不重排卡片），后台刷新改走 `refreshing` 静默标记（不点亮「加载更多」、失败不清空）；`podcast.vue` 分类树改 SWR（不再 `deleteSessionCache` + await 网络后才出首屏；有缓存时只换分类树、不动已渲染列表），首屏分类页同样加 10 分钟新鲜期 + 过期静默刷新；`homePrefetch` 预热改写 `fetchedAt` 并新增写入 `podcast:categories`。 | `vue-tsc --noEmit` exit 0；graphify 增量重建 7902 nodes / 16497 edges / 491 communities。实机验收项：点发现/播客/歌单无重影；最小化 1 小时内回来直接有界面、板块切换秒出；长时（>1h）后台后回来允许一次重建。 |
| 2026-10-15 | **暂时停用「一起听」（Listen Together）入口**（用户要求：暂时不用，注释即可、保留代码可恢复）。改动：`src/components/Play/PlayMusic.vue` 更多菜单里的"一起听 / 前往房间 / 创建房间 / 加入房间"入口用 `LISTEN_TOGETHER_ENTRY_ENABLED=false` 开关屏蔽、`else if` 同步收口；房间面板入口按钮（`lt-room-btn`）与 `ListenTogetherEntryDialog` 挂载改模板注释关闭；`src/components/layout/Provider.vue` 的 deeplink 邀请入口 `queueLtDeeplinkCode()` 用 `LISTEN_TOGETHER_INVITE_ENABLED=false` 提前 return 屏蔽。store / socket / 组件代码全部保留，把开关改回 `true` 即恢复。 | `vue-tsc --noEmit` exit 0。`FullPlay` 浮层/弹幕层因入口关闭而不可达，未改动。 |
| 2026-10-15 | **协议 scheme + bundle id 切到 shuxia（推翻之前"保留不动"）**（用户决定：把 `cerumusic://` 深链与 `com.cerumusic.tauri` bundle id 一并改成树夏）。改动：①`src-tauri/tauri.conf.json` identifier `com.cerumusic.tauri` → `com.shuxiamusic.tauri`（版本仍 1.1.2）；②`src/config/index.ts` Logto 回跳 `cerumusic://oauth/callback` → `shuxiamusic://oauth/callback`（含 logout-callback）；③`src-tauri/src/lib.rs` 运行时深链注册改为 `shuxiamusic://` 主 + `cerumusic://` 兼容，新增 `migrate_legacy_app_data()` 把旧 `Application Support/com.cerumusic.tauri` 迁到新目录；④sidecar 各 `APP_IDENTIFIER`/`DEFAULT_IDENTIFIER` → `com.shuxiamusic.tauri`；⑤签名身份新增 `Shuxia Music Self-Signed`。⚠️ 待办：Logto 后台补登记新 scheme；macOS 辅助功能/媒体键权限需重授。 | 三端同步不受影响（`/auth/pair` 配对码换 Bearer，按 `user_id`，不认 bundle id/scheme；安卓 `applicationId com.shuxia.music` 契约一致）。`cargo check --release` 通过（97 warnings 均既有）；`vue-tsc --noEmit` exit 0；`codesign --verify --deep --strict` 通过。已重编并替换 `/Applications/树夏Music.app`（v1.1.2）。 |
| 2026-10-15 | **修复更新「重启后反复弹安装 / 来回跳转」收尾 bug（手动检查全链路走通）**（用户反馈：点“检查更新”→ 想看到弹窗里有新版本号 → 点“立即更新”出进度条 → 进度完点确认 → 覆盖 → 重启；并反馈“一直在跳转”）。核对手动路径确认既有代码已满足该流程（`checkForUpdates` 手动不静默→`onUpdateAvailable` 置 `phase=available`+`dialogVisible`、版本经 `normalizeUpdateManifest(name=version)` 显示；点“立即更新”→`downloadUpdate` 复用缓存 `rid` 不 re-check→`DOWNLOAD_PROGRESS` 驱动进度条；下载完 `onUpdateDownloaded`→`phase=downloaded` 弹“重启安装”→`quitAndInstall` 才 `relaunchApp`）。**新增根因**：`autoUpdateService.initFromPersistedState()` 启动时只要 `status==='pending'` 就无条件弹“重启安装”，而 `quitAndInstall` 重启前**不清 pending**——更新完重启到新版后，新版启动仍读到 pending（版本号 = 当前版）→ 又弹“重启安装”，点了 `quitAndInstall` 判 pending 直接再 `relaunchApp` → **同版本反复重启死循环（“一直在跳转”）**。修复：启动读 pending 时用 `get-app-version`（Rust `package_info`，唯一来源 `package.json`）取当前运行版本，`compareVersions(current, pending)>=0` 说明“已更新生效”→ 置 `phase=idle` 并发 `recordEvent({status:'UPTODATE'})` 清 pending 不弹框；仅当前 < 待安装（下载完未重启）才弹“重启安装”。新增模块级 `compareVersions`（数值段比较，`1.1.2<1.1.13`）。 | `vue-tsc --noEmit` exit 0。逻辑核对：更新完重启→新版 current==pending→清 pending 不再弹；用户“稍后”+手动退出再开→磁盘已被 `download_and_install` 覆盖→current==pending→清 pending 不弹；下载完未重启就崩→current<pending→启动弹“重启安装”可恢复。索引：更新本路由行；未新增文件，graphify 无新增节点（仅 `autoUpdateService.ts` 内方法/模块函数变更）。 |
| 2026-10-15 | **修复在线更新「一直弹检查更新 + 无进度 + 自动覆盖重启」全链路**（用户反馈：更新机制一直在弹「正在检查更新」，下载没进度条，最后默认关掉 App 覆盖重启装了新版，全程用户无感知、无控制）。四个根因并修：①**窗口每次重新可见就重排一次 15s 检查**：`src/main.ts` 的 `visibilitychange` 隐藏/显示时 `stop/startBackgroundUpdateCheck`，而 `start` 每次都重新 `setTimeout(15s)` 且 `stop` 不取消该首检定时器 → 频繁切窗口反复触发检查（「一直弹」主因）。改为幂等调度器（`autoUpdateScheduled` 标志 + 独立 `autoUpdateFirstTimer`，`stop` 一并清首检定时器）。②**静默后台检查也在弹「正在检查更新」**：`autoUpdateService.onCheckingForUpdate` 无条件 `NotifyPlugin.info`。去掉该 toast，改为只驱动状态机（手动检查由按钮 loading 反馈）。③**一次检查跑两次 `checkUpdate`**：`tauri-bridge.checkForUpdates` 自己 `downloadAndInstall`，`onUpdateAvailable` 又 `downloadUpdate`→再 `checkUpdate` → CHECKING 发两次、两个「正在检查更新」叠加。解耦：bridge `checkForUpdates` 只检查+记录（不下载），`downloadUpdate` 复用缓存 `lastCheckResult` 的 `rid`（不再 re-check），下载完成只记 `pending`；**去掉所有自动 `relaunchApp()`**。④**无进度 + 无安装确认 + `handleDownloadStarted` 误置 `isDownloading=false`** 导致进度条从不显示、装完自动重启。改造为状态机 `phase: idle/checking/available/downloading/downloaded/error`（新增 `src/services/autoUpdateState.ts` 纯状态，避免 `window.api` 未就绪即实例化服务）+ 全局 `src/components/UpdateDialog.vue`（发现新版本→下载进度条(含不定长兜底/速度)→下载完成弹「重启安装」由用户点击才 `quitAndInstall()` 覆盖重启）。`main.ts` 在 `createTauriBridge()` 后动态初始化服务并 `initFromPersistedState()`（上次已下载 pending 则弹安装确认）。后台静默检查发现新版自动下载(带进度)、不弹「正在检查更新」；手动「检查更新」只弹对话框等用户点「立即更新」。**下载通道**：`src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints`（Gitee `songsong2020/shuxiamusic-desktop-release` + GitHub `maiga512/shuxiamusic-release` 的 `desktop-latest/latest.json`），Tauri updater 下载并校验签名后就地替换 `.app`，`relaunchApp()` 重启生效。 | `vue-tsc --noEmit` exit 0（本仓库未安装/配置 eslint，跳过）。待桌面实机：后台发现新版→弹框带进度→下载完→点「重启安装」→重启后 up-to-date 不再弹；切窗口不再反复弹「正在检查更新」；启动时已 pending 会弹「重启安装」。索引：新增 `autoUpdateState.ts`/`UpdateDialog.vue` 两节点，更新 TOP_GRAPH「Auto Update」段与本行路由；graphify 增量重建（见下方验证）。 |
| 2026-10-15 | **发现/播客/歌单列表缓存升级：会话级 TTL + localStorage 跨重启持久化**（用户诉求：切 tab / 切走再回来、以及重启 App 后，发现/播客/歌单列表不再重新加载）。改动：① `src/utils/cache/sessionCache.ts` 从纯内存 Map 升级为「内存热层 + localStorage 冷层」双层——`setSessionCache(key, value, ttlMs, persist)` 新增 `persist` 参数，`persist=true` 时同步写入 localStorage（键前缀 `shuxia_sc_v1:`，带 schema 版本号与 expiresAt；容量超限/序列化失败静默降级为仅内存）；`getSessionCache` 内存未命中时回落 localStorage 并按剩余 TTL 回填内存；`deleteSessionCache` 同时清两层。新增导出 `SESSION_TTL_MS = 24h`（会话级，实际关 App 即清空内存，localStorage 24h 后过期）。② 发现页（tags/playlists）、播客页（categories/page/shelf/block）、歌单页（playlists）、`homePrefetch` 预热共 11 个写点改用 `SESSION_TTL_MS + persist=true`；读点零改动（`getSessionCache` 自动回落）。**不持久化**：`audioHelpers.ts` 的 3 分钟音质/源排序缓存（临时数据）。注意：磁盘的 `MusicCache`（几 GB 音频文件 LRU，跨重启）是另一套东西，本次只加速「列表 + 封面 URL」，不影响音频缓存。 | vue-tsc：本次 5 个文件 0 错误（仓库另有 `UpdateDialog.vue` 既有的重复 `import watch` 2 处错误，属未跟踪的既有文件、与本次无关）；graphify 增量更新 7890 nodes / 16376 edges / 508 communities，graph.html 聚合导出 938 社区节点。 |
| 2026-10-15 | **全面清理 ceru 命名**（用户要求：所有相关 Ceru 全改为树夏Music）。改动范围（桌面仓库 57+ 文件 + 独立仓库）：①shared-contract 包名 `@ceru/shared-contract` → `@shuxia/shared-contract`，导出类型 `Ceru*` → `Shuxia*`（ShuxiaCloudSong / ShuxiaTrack / ShuxiaMusicSource 等）；②npm 包名 `@ceru/nas-sync-server` → `@shuxia/nas-sync-server`（npm 不支持中文包名，`@shuxia/` 是最接近树夏的 ASCII 写法）；③localStorage 键名 `ceru_*` → `shuxia_*`（26 个键），新增 `src/utils/storageMigration.ts` 一次性迁移（读旧键搬新键，老用户不丢同步游标/设备 ID/插件状态）；④全局属性 `__ceru*` → `__shuxia*`、CSS 变量 `--ceru-` → `--shuxia-`、自定义事件 `ceru-*` → `shuxia-*`、函数名/常量名同步；⑤插件沙箱新增 `shuxiaMusic` 别名（与 `cerumusic` 同一对象），新插件可用 `shuxiaMusic`，老插件 `cerumusic` 继续可用；⑥插件脚本 `cerumusic.request` 改为 `(shuxiaMusic || cerumusic).request` 兼容写法。**保留不动**（改动会破坏外部契约）：`cerumusic://` 深链（OAuth 回调地址，Logto 应用注册了该 scheme）、`com.cerumusic.tauri` bundle id（改了 macOS 辅助功能/签名权限全部丢失）、`api.ceru.shiqianjiang.cn` / `ceru.share.shiqianjiang.cn` 等服务端域名。独立仓库同步：本地 `nas-sync-server/` 为主版，合并独立仓库改进（超时 15s→25s、版本 v0.3.2），新增 `src/env.ts` 兼容层（`SHUXIA_SYNC_* > CERU_SYNC_* > 默认值`，DB 路径老文件 `ceru-sync.sqlite` 存在就继续用），docker-compose 容器名改 `shuxia-nas-sync`，插件文件改名 `shuxia-sync-service.js`（保留 `ceru-nas-sync-service.js` 兼容别名）。 | `vue-tsc --noEmit` 通过；`nas-sync-server` node --test 34/34 全过。独立仓库 GitHub + Gitee 均已推送（commit d89f9fd）。Docker workflow 自动触发，镜像 `ghcr.io/maiga512/shuxiamusic-nas-sync`（旧名 `ceru-music-nas-sync` 继续同步发布）。 |
| 2026-10-14 | **NAS 同步服务器改名 + 下载/部署文档 + Gitee 镜像**。GitHub 仓库 `maiga512/CeruMusic-NAS-Sync` → **`maiga512/shuxiamusic-nas-sync`**（`gh api -X PATCH` 改名，旧地址 301 重定向仍可用）；新建 Gitee 镜像 **`songsong2020/shuxiamusic-nas-sync`**（私有→推内容→转公开，Gitee 空仓库不允许直接设公开）。README 重写：新增「项目地址」（GitHub/Gitee 镜像）、「客户端下载」（安卓/车机 APK + Mac 桌面端 dmg 与 App 内自动更新说明 + Gitee 国内镜像）、完整部署教程（Docker Compose 快速开始、群晖/飞牛/绿联/铁威马/1Panel/宝塔/CasaOS/Portainer 对应位置、Web 管理后台、插件导入、反向代理、找回管理员密码）。Docker 镜像改名 `ghcr.io/maiga512/shuxiamusic-nas-sync`，**同时继续发布旧名 `ceru-music-nas-sync`**（两个 `latest` 指向同一 digest `sha256:c7e07bfb…`）以兼容既有部署；OCI 标签与仓库 URL 同步更新。发布中心首页（GitHub + Gitee 两份 hub README）里「树夏Music 同步服务器」行的链接已改为新仓库 + Gitee 镜像。 | 校验：GitHub 旧地址 301 → 新地址；Gitee 仓库 HTTP 200、`private=false`；插件 raw 地址（GitHub raw / Gitee raw）均 HTTP 200、5777 字节；Docker workflow run 38588332675 success，两个镜像名 `latest` digest 一致。**未改**：环境变量 `CERU_SYNC_*`、容器名 `ceru-nas-sync`、数据库文件名、插件文件名 `ceru-nas-sync-service.js`（改名会破坏既有部署与已导入插件）。注意：本仓库 `nas-sync-server/` 是独立仓库的 vendored 副本，已落后（如 `http.ts` 15s vs 25s），未同步。 |
| 2026-10-14 | **发布 v1.0.9（GitHub + Gitee 双平台）——已完成**。版本号 1.0.8 → 1.0.9（`package.json` 单一来源 + `src-tauri/Cargo.toml` 同步）。本版累积修复：①音量改为等比例（`sliderToMpvVolume(p)=100*cbrt(p/100)` 反解 mpv 三次曲线）+ 0% 可精确设置（移除所有 `volume<=0→80` 强制改写）；②耳机戴上不再自动播（CoreAudio 默认输出设备监听 `audio_device.rs` + 系统媒体指令抑制窗口）；③下载列表文件夹图标可用（补注册 `download.openFileLocation` sidecar 路由 + bridge 改 strict + store 弹提示）；④全屏双指横滑"滑一次只切一次"（改用 `event.timeStamp` 静默间隔重新武装 + 2s 兜底）；⑤全屏按钮两个 bug（退出后顶部黑条 / 盖不住菜单栏）——macOS 全屏路径完全弃用 Tauri 窗口 API，整套进入/退出放进单个主队列 AppKit 任务；⑥签名固定为自签证书 `Ceru Music Self-Signed`（DR 由 cdhash 改为证书根，辅助功能权限跨重编译保留）。**发布流程踩坑与改造**：首次触发（tag `desktop-v1.0.9`）两个平台都编译成功，却双双卡在 `actions/upload-artifact@v4` 报 `Artifact storage quota has been hit`（免费额度仅 500MB，一次发布 macOS 195MB + Windows 90MB，累积两次即满；配额要 6~12 小时才重算，删旧 artifact 也不能立刻恢复），`publish` 被跳过、发布中断。改造：构建作业改用 `softprops/action-gh-release` **直传发布仓库的 desktop-latest**（公开仓库 Release 附件不占 Actions artifact 配额），`publish` 作业 `needs` 两平台后用 `gh release download -p "shuxiamusic_<版本>_*"` 取回产物生成 `latest.json`，再只上传 `latest.json`；并新增一步自动清理 desktop-latest 里的历史版本附件（此前需人工清理）。 | **GitHub**：`desktop-latest` 仅 1.0.9 五件套 + latest.json（旧 1.0.8 附件已被新加的清理步骤自动删除）；`desktop-v1.0.9` 五件套；`latest.json` version=1.0.9、darwin-aarch64 + windows-x86_64 双平台；`releases/latest` 指针仍是安卓 `v2.5.113-139`（桌面未抢走）。**Gitee**：`desktop-latest`(id 1205808) 与 `desktop-v1.0.9`(id 1205815) 各五件套 + latest.json，匿名可读、version=1.0.9 且 URL 指向 Gitee；发布前按既有做法先 DELETE 混有 1.0.8 附件的旧 desktop-latest(1203804)，避免配额被旧附件顶满。发布中心首页（GitHub + Gitee 镜像）「树夏Music 桌面端」行均为 v1.0.9。CI run 38573021565 四作业全 success。 |
| 2026-10-14 | 修复用户反馈「全屏播放界面点全屏按钮」两个 bug：①退出全屏后顶部出现**黑条**，切到歌单页黑条还在；②全屏时**盖不住顶部菜单栏/状态栏**，不是真全屏。根因（读 tao 0.37.1 源码 + Swift/Rust 实测）：原实现用 Tauri 的 `set_decorations`/`set_always_on_top`/`set_position`/`set_size`，但 —— (a) tao 的 `set_decorations(true)` 把 styleMask 设成 `Closable\|Miniaturizable\|Resizable\|Titled`，**不含 `FullSizeContentView`**，内容视图不再延伸到标题栏下方 → 整页被下推一个标题栏高度、顶部露窗口底色（黑条）；(b) tao 的 `set_always_on_top(true)` 走 `set_level_async(NSFloatingWindowLevel = 3)`，低于菜单栏层（`NSMainMenuWindowLevel = 24`）且异步，盖不住菜单栏；(c) `set_position`/`set_size` 走事件循环消息、`set_decorations` 走 GCD 主队列，两条队列顺序不可控，而增删 `FullSizeContentView` 本身会改变 frame 高度（实测 620→588，差 32pt = 标题栏高），顺序错了 frame 就偏。修复：**macOS 路径完全弃用 Tauri 窗口 API**，把「改 styleMask / 设 frame / 设 level / 标题栏透明 / 隐藏红绿灯」放进**同一个主队列 AppKit 任务**（`dispatch_async_f` + `_dispatch_main_q`）按固定顺序执行：进入时快照 AppKit `frame`/`level`/`isZoomed` → 取消 zoom → 去掉 `Titled` → `setFrame:` 到 `[window screen].frame`（含菜单栏的完整屏幕 frame，不用 visibleFrame）→ `setLevel: 1000`；退出时恢复 Overlay mask（`Titled\|Closable\|Miniaturizable\|Resizable\|FullSizeContentView`）+ `setTitlebarAppearsTransparent:YES` + `setTitleVisibility:hidden` + 隐藏原生红绿灯 → **再**写回保存的 frame → 恢复 level/zoom。新增 `objc2-core-foundation`（`features=["objc2"]`，取 `CGRect`）依赖；非 macOS 保留原 Tauri 实现。 | Swift 实测：`setFrame(screen.frame)` 对 titled/borderless 窗口都不被 `constrainFrameRect` 约束；去掉 `Titled` 不改 frame；加回 `FullSizeContentView` 会让 frame 高度缩一个标题栏高（故必须后写 frame）。Rust 独立工程（debug，编码断言开启）实测整轮 enter/exit：frame 精确回环（`MATCH frame = true`）、level 0→1000→0，`initWithContentRect:`/`frame`/`setFrame:display:`/`level`/`setLevel:`/`screen`/`isZoomed`/`zoom:`/`standardWindowButton:` 全部通过 objc2 编码断言。`cargo check` 通过（96 warnings，与改动前持平，无新增）。已重新出包（release）替换 /Applications/树夏Music.app，版本号 1.0.8 未动。 |
| 2026-10-14 | 修复用户反馈「全屏播放界面点全屏按钮」两个 bug：①退出全屏后顶部出现**黑条**，切到歌单页黑条还在；②全屏时**盖不住顶部菜单栏/状态栏**，不是真全屏。根因（读 tao 0.37 源码确认）：`src-tauri/src/windowed_fs.rs` 之前用 Tauri API 做窗口化全屏，但 —— (a) tao 的 `set_decorations(true)` 把 styleMask 设成 `Closable\|Miniaturizable\|Resizable\|Titled`，**不含 `FullSizeContentView`**，于是内容视图不再延伸到标题栏下方，整个页面被下推一个标题栏高度、顶部露出窗口底色（黑条）；(b) tao 的 `set_always_on_top(true)` 走 `set_level_async(NSFloatingWindowLevel = 3)`，低于主菜单/状态栏层（`NSMainMenuWindowLevel = 24`），而且它是**异步派发到主队列**的，会覆盖同函数里同步执行的 `setLevel:1000` → 窗口盖不住菜单栏。修复：新增 `macos_fixup` 模块，用 `dispatch_async_f` + `_dispatch_main_q` 把修正派发到主队列（FIFO 保证排在 tao 的异步块之后），在 AppKit 层直接操作：**进入**时 `setStyleMask: mask & !Titled`（borderless）+ `setLevel: 1000`；**退出**时补回 `FullSizeContentView` + `setTitlebarAppearsTransparent: true` + `setTitleVisibility: hidden` + 隐藏原生红绿灯（本 App 用自绘标题栏控件）。同时删掉原来同步的 `set_native_window_level`（会被 tao 异步覆盖，且非主线程调用 AppKit 不安全）。 | 读 tao 0.37.1 `platform_impl/macos/window.rs` 与 `util/async.rs` 确认 `set_decorations` 的 mask 组成与 `set_level_async` 的异步语义；Swift 实测 `setFrame(screen.frame)` 对 titled/borderless 窗口都不被 `constrainFrameRect` 约束（所以帧不是问题）；Rust 实测 `_dispatch_main_q` + `dispatch_async_f` 可链接。`cargo check` 通过（仅既有 96 warnings，无新增）。已重新出包（release）替换 /Applications/树夏Music.app，版本号 1.0.8 未动。 |
| 2026-10-14 | 修复用户反馈「全屏双指横滑切封面时来回跳好多次才定住，应该滑一次只切一次」。根因：`FullPlay.vue` 的 `onFullPlayWheel` 用「固定冷却 + 幅度回升启发式」判定新甩动——`freshBurst = dt > SWIPE_GAP_MS(180ms) || (lastDelta < peakDelta*0.6 && absX > lastDelta*1.4)`，其中 `dt` 用 `performance.now()`（处理时刻）计算。而切换 `layoutMode` 会整块换掉 `v-if` 的 CD/方形封面模板，主线程被渲染阻塞；阻塞结束后排队的惯性 wheel 事件成批处理，`performance.now()` 间隔瞬间远超 180ms → 被误判成"新的一甩"→ 解锁重新累计 → 再次过 48px 阈值 → 又切一次。每次切换都触发同样的阻塞，形成"滑一下切好几下、来回跳"。修复：改为按**事件时间戳静默间隔**重新武装——过阈值触发一次后 `latched=true`，之后所有事件（含惯性尾）一律忽略；只有相邻事件的 `event.timeStamp` 间隔 > `SWIPE_REARM_MS`(250ms) 才解锁。关键是用 `event.timeStamp`（事件**生成**时刻，WebKit 为 DOMHighResTimeStamp，与 `performance.now()` 同基准）而非处理时刻：事件被主线程阻塞排队时 `timeStamp` 仍保持真实的 60Hz 间隔，不会误判。同时删掉脆弱的幅度回升启发式与 `peakDelta/lastDelta` 字段；垂直占优分支只清水平累计、不再清锁存；锁存期间仍 `preventDefault` 抑制 WKWebView 横滑导航。 | `npx vue-tsc --noEmit` exit 0；无残留旧字段引用。Graphify 增量重建并导出 html。已重新出包（release）替换 /Applications/树夏Music.app，版本号 1.0.8 未动。 |
| 2026-10-14 | **固定 macOS 签名身份**（用户反馈：每次重打包签名都变、辅助功能权限要重授）。根因：`tauri.conf.json` 的 `bundle.macOS.signingIdentity` 是 `"-"`（ad-hoc），ad-hoc 签名的 designated requirement 是 `cdhash H"..."`（二进制内容哈希），任何代码改动/重编译都会变，而 macOS TCC（辅助功能）正是按 DR 记录授权 → 每次都要重授。修复：改用 keychain 里已有的自签证书 `Ceru Music Self-Signed`（`CN=Ceru Music Self-Signed, O=CeruMusic`，Basic Constraints CA:FALSE，Key Usage Digital Signature，EKU Code Signing，有效期至 2036-10-07），DR 变为 `identifier "com.cerumusic.tauri" and certificate root = H"3fcb56609a8a5577c9cbbc19f53c04f94d764a77"`——只与证书绑定，跨重编译稳定；并把该证书加入用户信任设置（`security add-trusted-cert -r trustRoot -p codeSign`），`spctl -a` 判定 `accepted / origin=Ceru Music Self-Signed`。配套：`install-new-build.sh` 重写为**不再 `codesign --force --deep --sign -` 重签**（那会把证书签名换成 ad-hoc，前功尽弃），只 `cp -R` + `xattr -cr` + 校验；CI 运行器没有该证书，`desktop-release.yml` 的 macos job 加 `APPLE_SIGNING_IDENTITY: "-"` 覆盖回 ad-hoc，避免打包因找不到身份失败。 | 验证：构建日志 `Signing with identity "Ceru Music Self-Signed"`；`codesign -d -r-` 输出证书型 DR（非 cdhash）；`codesign --verify --deep --strict` 通过；`spctl -a -vvv` = accepted；app 正常启动运行。附带发现并记录：`kill -9` 会留下孤儿 mpv 占住 LaunchServices 注册导致双击无法启动，`pkill -f "mpv/bin/mpv"` 可解。Graphify 增量重建并导出 html。 |
| 2026-10-14 | 修复用户实测两项：①**音量拖到 0% 点不了、一放就弹回上面**；②**下载列表点文件夹图标没反应**。①根因：多处 `volume <= 0 → 80` 的"脏数据兜底"把 0 当成非法值——`nativePlayback.ts` 的 `nativeLoad`（`if (!(desiredVolume>0)) desiredVolume=80`）与 `nativeSetVolume`（`if (!(desiredVolume>0) && !transition) desiredVolume=80`）、`LocalUserDetail.init()`（`if (!(Number(volume)>0)) volume=80`）、`PlayMusic.vue` 的 `userInfo.volume` watcher（`if (next<=0 && Audio.volume<=0) setVolume(80)`）。用户把滑条拖到底 → store 写 0 → watcher 立刻 `setVolume(80)` → 视觉上"弹回 80%"。修复：0 改为合法值，仅非有限数/越界才回退 80（`LocalUserDetail` 只过滤非数字与越界；`nativeSetVolume` 用 `Number.isFinite` 判定；`nativeLoad` 保留 0；watcher 去掉 0 改写）。0% 与 1% 均可精确点选。②根因：`sidecar/services/download/index.mjs` 的 `openFileLocation` 实现早已存在，但 `sidecar/index.mjs` 的方法路由表**漏注册** `download.openFileLocation`，调用抛 `Unsupported sidecar method`，被 `tauri-bridge.ts` 的 `invokeNodeDownload` try/catch 静默吞成 `undefined`，store 的 `res && res.success===false` 判据永不成立 → 点图标毫无反馈。修复：补注册路由；bridge 改 `invokeNodeDownloadStrict` 并把异常转成 `{success:false,message}`；store 对"无路径/无响应"也弹提示。 | 实测：直接 spawn sidecar 发 `download.openFileLocation` 请求（真实文件 `downloads/七里香 - 周杰伦.mp3`）→ `{"ok":true,"result":{"success":true}}`，Finder 定位成功。`node --check sidecar/index.mjs`、`node --check sidecar/services/download/index.mjs` 通过；`npx vue-tsc --noEmit` exit 0。Graphify 增量：7818 nodes / 15428 edges / 537 communities；`graphify export html` 社区聚合 938 节点 / 923 边。已重新出包替换 /Applications/树夏Music.app。 |
| 2026-10-14 | 修复用户反馈两项：①**耳机戴上又自动播**；②**音量百分比不对（调到 80% 就很小）**。①根因：macOS 在输出设备变化/耳机插拔时会替 App 发系统媒体指令（拔耳机发 pause、插回发 play/pause），而 `globaPlayList.ts` `onGlobalCtrl` 的 `pause` 是 toggle 语义（在播→暂停、不在播→播放），插回时那条系统 `pause` 被反转成播放，`play` 也被直接执行——`/tmp/ceru-media-keys.log` 实锤 `mp-remote: pause` 后 2.56s 又来一条 `mp-remote: pause`，结果 `smtc-state: playing`。修复：新增 `src-tauri/src/audio_device.rs`（CoreAudio `kAudioHardwarePropertyDefaultOutputDevice` 属性监听 → 派发 `app-audio-device-changed`；WebKit 在 macOS 不暴露 audiooutput 设备，`navigator.mediaDevices` 的 `devicechange` 降为兜底），`nativePlayback.ts` 记录最近设备变化时间并同时触发 AO 重建；`onGlobalCtrl` 在「设备变化后 6s」或「系统 `pause` 真的暂停了播放后 4s」（兜底：耳机插在 USB 声卡上时默认输出设备不变、拿不到 devicechange）内，把系统来源（`source=media`）的 `play` 忽略、`pause` 只当暂停（绝不 toggle 成播放）；窗口外行为不变（保留 toggle 兜底系统状态感知滞后），App 内播放按钮不走该通道、不受影响。②根因：mpv 的 `volume` 属性**不是线性增益**——实测打包内 mpv v0.41（`ao=pcm` + `volumedetect`）为 `gain=(volume/100)^3`（volume 50 实测 -18.0dB、80 实测 -5.8dB）；上一版又叠了 `p²/100`，两层曲线相乘使 50% ≈ -36dB、80% ≈ -11.6dB，滑条下半段几乎全废。修复：`sliderToMpvVolume(p)=100*cbrt(p/100)` 反解 mpv 三次曲线，最终增益=滑条百分比（100%→满刻度=系统音量档位的完整音量、80%→-1.9dB、50%→-6dB、0%→静音），与 Electron 参考 `audio.volume=v/100` 一致；Rust 去抖/初值注释同步。 | 实测：mpv 0.41 `--volume` 100/90/80/70/60/50/40/30/20 → 0/-2.7/-5.8/-9.2/-13.3/-18.0/-24.1/-31.2/-42.1 dB，与 `60*log10(v/100)` 三次模型吻合；`--volume=50` ≡ `--af=volume=-18.06dB`。CoreAudio 常量用 C 程序核对（`kAudioObjectSystemObject=1`、`dOut=0x644f7574`、`glob=0x676c6f62`），Rust FFI 注册返回 noErr(0)。`cargo check` 通过（仅既有 96 warnings，无新增）；`npx vue-tsc --noEmit` exit 0。Graphify 增量：7818 nodes / 15427 edges / 546 communities；`graphify export html` 社区聚合 938 节点 / 923 边。听感与耳机端到端需重新出包实测。 |
| 2026-10-15 | **v1.1.0：修复在线更新全链路（点检查更新没反应的根因）**。用户反馈「点了检查更新没反应」。排查出 4 个 bug 叠加：①**判定逻辑错误（致命）**：`src/stubs/tauri-plugin-updater.ts` 的 `checkUpdate()` 从原生结果读 `available`/`shouldUpdate` 字段，但 Tauri `Metadata` 没这两个字段（只有「有更新才返回 Some、无更新返回 None」），导致判定恒为 false → 永远提示「已是最新」，自上线起在线更新完全失效；改为 `!!(result.available ?? result.shouldUpdate ?? result.version)`。②**下载命令缺必填参数（致命）**：`plugin:updater|download_and_install` 需要 `rid`（更新资源句柄），旧代码没传，判定修好后下载也会立刻报参数错误；改为 `{rid: result.rid, onEvent}`。③**重复下载**：`checkForUpdates()` 里 `recordCheckResult` 把 `pending` 状态覆盖成 `update-available`，守卫失效，每 6 小时后台检查都重下 94MB 全量包；改为写状态前先读旧状态做版本比对，同版本已 pending 则跳过下载。④**装完不重启**：macOS 更新是就地替换 .app，但运行中进程仍跑旧代码，「立即安装」点完无变化；`quitAndInstall()` 末尾调 `relaunchApp()`（`tauri-plugin-process`）重启进程。**验证**：打 1.0.8+修复包装机 → 自动检查真实检测到 1.0.9 → 下载 → 自动替换成功（`CFBundleShortVersionString` 1.0.8→1.0.9，`plutil` 实证）；当前 1.0.9+修复版反复点检查更新全部 `checking→up-to-date` 零报错。更新包下载到系统临时目录（不在用户下载目录），校验签名后直接替换 `/Applications/树夏Music.app`。 | `vue-tsc --noEmit` exit 0；`cargo check` 通过（仅既有 96 warnings）。v1.1.0 发 GitHub + Gitee（Mac+Win）双平台；本地不升级，留 1.0.9+修复版给用户实测在线升级流程。 |
| 2026-10-14 | **播放态 CPU 优化（实测驱动）**。用户要求：普通窗口播放中 + 最小化播放中都要降 CPU，且不得影响播放/动效/切歌链路。用「进程累计 CPU 时间增量法」（先用 `while :; do :; done` 标定 95.6%/100% 验证精度）实测：普通窗口播放中合计 **17.0%**（mpv 5.8 / 主进程 4.8 / WebContent 3.9 / GPU 1.6），最小化播放中 **12.4%**（mpv 5.8 / WebContent 3.7 / GPU 1.6 / 主进程 0.7）。关键发现：**暂停+最小化时 WebContent 仍占 3.5%、GPU 1.6%**（合计 5.2% 纯空转，与播放态无关）。`sample` 采样 20s 后按帧计数定位：`RemoteAudioDestinationProxy render thread` 的 `AudioDestinationResampler::render` 占 728/13498 采样 ≈ 0.7s，与实测 CPU 时间几乎完全吻合——**WebKit 在持续渲染整张 Web Audio 图**（`AudioNode::processIfNecessary` / `AudioBasicProcessorNode::pullInputs`，即 EQ 的 BiquadFilter 链）。根因：`getOrCreateAudioSource()` 一旦为 `<audio>` 建过 `MediaElementAudioSourceNode`，WebKit 就会永久渲染该图；而 `crossfade.ts` 的 `startRmsWatch()`（无感过渡观察窗）会创建它，`stopRmsWatch()` 只清定时器、**从不 suspend/close AudioContext**，于是图常驻空转。修复：①`audioManager.ts` 新增 `syncContextPlaybackState(el, forceSuspend)` / `syncAllContexts()`（元素不在播放即 suspend、开始播放前 resume；WeakMap 不可遍历，另存 `audioElements` 强引用集合）；②`GlobalAudio.vue` 在 `@play`/`@pause`、`onVisibilityChange`（隐藏时挂起）、`onMounted` 首帧对齐时同步；③`crossfade.ts` `stopRmsWatch()` 结束时同步一次。④mpv 侧：新增 `--load-scripts=no`（纯音频无窗口，osc/stats/console/select/positioning/commands/context_menu/ytdl_hook 全无用却常驻线程；本项目只播直链音频，不依赖 yt-dlp）与 `--media-controls=no`（系统「正在播放」/媒体键由本 App 的 `now_playing.rs` 负责，避免两套同时向 MediaPlayer 框架上报）。 | `npx vue-tsc --noEmit` exit 0；`cargo check` 通过（仅既有 96 warnings）。已重打包替换 /Applications/树夏Music.app（备份 ~/旧版树夏Music-1.0.8.app）。**复测结果（同一方法，稳定后测量，已确认）**：暂停+最小化 **6.96% → 1.77%**（-75%，WebContent 3.5→0.47、GPU 1.6→0.10、主进程 0.53）；普通窗口播放中 **17.0% → 8.93%**（-47%，WebContent 3.9→1.57、GPU 1.6→0.13、主进程 4.8→1.03、mpv 5.8→5.47）；最小化播放中 **12.4% → 9.83%**（-21%，WebContent 3.7→1.87、GPU 1.6→0.17、主进程 0.7→1.17、mpv 5.8→5.83）。`sample` 复查确认暂停时 `AudioDestinationResampler::render` 采样数为 **0**（音频图确已停止）。剩余大头 mpv 4~5% 经对照实验确认为固有开销：裸 mpv 播同一 URL 为 3.73%（最小参数）/4.93%（仅缓存）/4.33%（缓存+重连），即 MP3 解码 + CoreAudio 输出（44.1k→48k 由 CoreAudio 实时线程重采样），非本 App 配置引入，再压需动音频管线、有爆音风险，不做。注：窗口状态切换后 10~20s 内主进程有瞬态偏高（可到 8%），稳定后回落 ~1%，测量须先等稳定。 |
| 2026-10-14 | 修复抽屉过渡「卡重影」：上一版重叠过渡里旧页淡出（80ms）与新页滑入（260ms）双重运动同屏 → 肉眼重影，且新页 KeepAlive 复活时的布局计算与动画同帧竞争 → 滑动卡一下。改为**单动效抽屉**：①旧页零退出动画（瞬间隐藏，KeepAlive 立即 display:none）——无双重运动、无双影；②新页保留 28px 左滑入 + back-out 1.75 回弹（240ms），加 `will-change: transform` 提层走合成器，切页布局计算不再卡动画；③左侧 28px 间隙露出应用底色（.content 渐变），像拉开抽屉；④`prefers-reduced-motion` 回退改为直接切（无 transform）。设置页维持 60ms out-in（表单页轻，不受影响）。 | 纯 CSS 调整（`src/views/home/index.vue` 过渡块），`npx vue-tsc --noEmit` exit 0。重打包替换 /Applications/树夏Music.app（备份 ~/旧版树夏Music-1.0.8.app）。若仍觉首次点击慢，下一档方案：导航 hover 时预挂载目标页 DOM（常驻内存 +MB 级），待用户实测后决定。 |
| 2026-10-14 | 主页过渡抽屉化 + 消除「黑屏」间隔（用户反馈：点发现/播客/歌单还是「先黑一下屏再闪出来」，要「已经准备好了、拉开抽屉直接出结果」；接受一丢丢内存换秒开）。①黑屏根因：原 `mode="out-in"` 要旧页先完全淡出（100ms 纯空档）新页才入场，每次切换必有暗屏间隔。改：去掉 out-in 改重叠过渡——过渡期两页在 `.mainContent`（position:relative + overflow:hidden）里同时 absolute 叠放（五页根节点均 height:100%，无布局跳变），新页 28px 从左侧整块滑入（back-out 1.75、260ms、内容全程不透明）直接盖住旧页，旧页在底下 80ms 淡出，全程无空档。②设置面板退出 100ms→60ms（约 3 帧不可察觉）。③首屏预热 2.5s→1.2s。④封面释放宽限 30s→60s（用户认可的一丢丢内存：期间多留几十张解码封面、MB 级，窗口隐藏仍立即释放）。 | `npx vue-tsc --noEmit` exit 0。已重打包替换 /Applications/树夏Music.app（备份 ~/旧版树夏Music-1.0.8.app，签名校验通过），构建产物已验证重叠过渡 CSS。待实机确认：切换无黑屏、内容即点即现；会话首次点击若预热未完成仍有短暂加载（网络下限）。 |
| 2026-10-14 | 主页/设置页过渡「Q弹」调大 + 板块首屏提速（用户反馈：弹幅再大一点；发现/播客/歌单点进去「界面弹进来了内容没加载到」，要求点了马上有、又省内存）。①回弹加大：主页与设置面板的 back-out 曲线 `cubic-bezier(0.34,1.56,0.64,1)`→`(0.34,1.75,0.64,1)`，时长 240ms→260ms。②「内容没加载到」根因两宗：(a) sImage 的 release-on-hide 切走 tab 立即释放封面解码位图，切回时几十张封面重新解码，卡片区肉眼可见地「空」一下；(b) 会话内首次点某板块无任何缓存、纯网络等待。修复：(a)`src/components/sImage.vue` 释放加 30s 宽限——窗口隐藏仍立即释放（内存优先，原行为不变），仅切 tab（窗口仍可见）时保留解码位图 30s，快速来回切 tab 封面回来即有，停留 30s 自动释放不常驻；(b) 新增 `src/utils/navigation/homePrefetch.ts`：主页稳定 2.5s 后空闲预热「发现」（tags+hot 前 30 条）与「播客」（首个分类页 pageSize=15）首批数据写入 sessionCache，复用视图既有 SWR（命中即渲染+后台刷新），只缓存元数据不保留 DOM，失败静默不影响正常路径；`podcast.vue` 的 loadCategories 不再整删 `podcast:page:` 分页缓存（分类树仍每次强制刷新，对齐 Electron），改走 SWR 命中预热缓存。 | `npx vue-tsc --noEmit` exit 0。已重打包替换 /Applications/树夏Music.app（旧版备份 ~/旧版树夏Music-1.0.8.app，签名校验通过），构建产物已验证含新曲线与预热代码。待实机确认：回弹幅度、会话首次点击发现/播客是否秒出、内存占用（30s 宽限期间多留几十张解码封面，量级 MB 级）。 |
| 2026-10-14 | 主页/设置页板块切换加「Q弹」过渡（用户诉求：点左侧发现/歌单/播客/本地下载或设置子板块，右侧内容要有轻微回弹的滑入感）。方案 Slide in + Bounce（左侧滑入、过冲一点再弹回落定，back-out 曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)`，240ms 内完成，只动容器一层 transform 走 GPU 合成，零新增依赖）：①`src/views/home/index.vue` 页面 Transition 由原 120ms 纯淡入淡出改为「100ms 淡出 + 28px 左滑入过冲 + 160ms 淡入」；②`src/views/settings/index.vue` 右侧面板套 `Transition name="settings-panel"`（24px 滑入同款曲线），`.panel-content` 补 `overflow-x: hidden` 防滑入瞬间横向滚动条，保留既有「各卡片 animation:none + 窗口隐藏/空闲关动画」即时响应优化（面板过渡同样在 hidden/inactive/idle 下跳过）；③主导航 `.nav-button`（`HomeLayout.vue`）与设置 `.nav-item` 加 `&:active` 按压缩放反馈（0.97/0.98）；均带 `prefers-reduced-motion` 回退为纯淡入。 | `npx vue-tsc --noEmit` exit 0。纯 CSS/模板改动，未改符号图/数据流，graphify 未重跑。Q弹幅度待实机确认（过冲由 bezier 第二个 y 值控制：1.56 更弹、1.2 更收敛；滑入距离 28px 主页/24px 设置页）。 |
| 2026-10-14 | **v1.0.8 双平台发布完成（GitHub + Gitee）**。版本 1.0.7 → 1.0.8（`package.json` 单一来源 + `src-tauri/Cargo.toml`，随 commit 716ce14 推送 GitHub main）。①GitHub：`desktop-release.yml` run 38448755879 一次触发编出 Mac+Win 双平台（四 job 全 success）；`maiga512/shuxiamusic-release` 的 `desktop-latest` 已清掉混入的 1.0.7 旧附件（现为 1.0.8 双平台五件套 + 双平台 latest.json），版本化 `desktop-v1.0.8` 五件套完整。②Gitee（本机直传）：`gh run download 38448755879` 平铺产物后跑 `scripts/ci/publish-gitee-local.sh`，上传到一半 Windows exe 报 400「仓库附件配额 1 GB 已满」——根因：Gitee API v5 的 releases 列表/详情接口都不返回附件 id，`publish-gitee.py` 的「先清旧附件」循环空转，旧 `desktop-latest`（id 1202414）里 1.0.7 五件套+旧 latest.json 残留，叠加 1.0.8 新旧两版共约 1.07GB 顶满配额。处理（沿用 v1.0.7 先例）：API DELETE 全部三条 release（desktop-latest 1202414 / desktop-v1.0.7 1202420 / desktop-v1.0.8 1203796）→ 重跑发布脚本重建：新 `desktop-latest` id=1203804（六件套：5 安装件 + latest.json）、新 `desktop-v1.0.8` id=1203806（五件套），附件合计约 548MB、余量 ~450MB。注意：Gitee 写操作（DELETE release/attachment）只认 `?access_token=` 查询参数，用 `token:` 请求头会 401「登录失效」（GET 两者皆可）。 | 验证：Gitee `desktop-latest/latest.json` 回读 version=1.0.8，darwin-aarch64 与 windows-x86_64 的 URL 均指向 Gitee 且带签名；`desktop-v1.0.8` 五附件齐全；发布中心首页已由 `update-hub-readme.py` 同步（GitHub `maiga512/shuxiamusic-release` 与 Gitee `songsong2020/shuxiamusic-release` 的「树夏Music 桌面端」行 → v1.0.8）。本机 1.0.8 包已装到 /Applications/树夏Music.app（旧版备份 ~/旧版树夏Music-1.0.7.app）。本轮为发布操作，无应用代码改动，未重跑 graphify。 |
| 2026-10-13 | 修复「dock 栏音量滑条没有按真的百分之多少控制音量」。根因:滑条百分比此前按线性 1:1 直发 mpv `volume`（100=满刻度=系统音量档位完整音量），100%→50% 只有 -6dB、人耳几乎无感，滑条上半段完全不符合"按百分比减小"的预期（安卓端音量图标直接拉系统音量 UI，无应用内曲线可对照，属 Mac 端自身缺陷，Electron 版同为线性、一并纠正）。修复:①`nativePlayback.ts` 新增 `sliderToMpvVolume(p)=p²/100` 感知曲线——展示/持久化保持滑条百分比域，仅在下发 mpv 时换算（`applyMpvVolumeNow`/`nativeLoad` 请求体），100%→100(满)、50%→25(-12dB≈一半响度)、0%→0；②曲线后低音量段步长变小，前端 IPC 合并去抖与 Rust `mpv_set_volume` 早期返回阈值 0.5→0.25（mpv 音量域）；③Rust 初始 `state.volume=80.0` 保留并加注释——它不得与任何整数滑条百分比的映射值相等，否则首次设音量会被去抖吞掉。不变量:100% 永远是设备满刻度（系统音量档位的完整音量），不触碰系统音量；DLNA 音量同步仍发原始百分比。 | `cargo check` 通过(无新增警告);`npx vue-tsc --noEmit` exit 0。听感验收需重新出包:100% 应等于系统音量档位完整音量、拖到 50% 应听感约一半、低音量段 1% 步进可分辨。索引:TOP_GRAPH「Playback And Media」新增音量曲线段;路由表新增音量行;Graphify 增量重建 10781 nodes / 19672 edges / 938 communities,`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label` 重生成 graph.html(约 10MB)。 |
| 2026-10-13 | 修复「最小化后恢复窗口声音卡一下（暂停再播）」+ 仓库目录改名。根因:恢复窗口时 Rust 广播 `app-window-state-changed` → `appWindowState.ts` 派发 `ceru-wake`(窗口可见性/15s 闲置唤醒共用事件) → `nativePlayback.ts` 的 onWake 每次都调 `mpv_reload_audio_output`(`aid: no→restore` 拆装整条 CoreAudio AO) → 产生可听停顿;该重建原意只覆盖真实睡眠唤醒后的 AO 静默死亡。修复:①Rust 新增 `src-tauri/src/system_power.rs`——NSWorkspace `NSWorkspaceDidWakeNotification` 观察者(ClassBuilder 模式,同 now_playing.rs),真实系统唤醒时向 Webview 派发 `app-system-wake`;②`nativePlayback.ts` 拆分唤醒处理——`ceru-wake` 只 `syncClockFromMpv` 对齐本地进度时钟,`app-system-wake` 才 `reloadNativeAudioOutput()`(`devicechange` 800ms 防抖路径不变);③`tauri-bridge.ts` app 命名空间新增 `onSystemWake`;④`lib.rs` setup 接入 `system_power::init_system_power_watcher`。另:项目目录 `/Users/songsong/Movies/ceru-tauri` 改名为 `/Users/songsong/Movies/树夏Music-Desk-tauri`(用户要求去掉 ceru 前缀;Cargo 包名/npm 名/bundle id 均不变),仓库内 9 份文档绝对路径引用已同步;src-tauri/target 旧路径构建缓存已清理。 | `cargo check` 通过(无新增警告);`npx vue-tsc --noEmit` exit 0。运行时听感验证(最小化→恢复、合盖→开盖)需重新出包实测。索引:TOP_GRAPH.md「Playback And Media」AO 段已更新为 `app-system-wake` 触发;本行路由表已更新;Graphify 增量重建 10780 nodes / 19514 edges / 951 communities；`GRAPHIFY_VIZ_NODE_LIMIT=12000 graphify cluster-only . --no-label` 重生成 graph.html(约 10MB)。 |
| 2026-10-13 | **发布策略变更：Gitee 上传全部走本机直传**（用户拍板：GitHub 境外 runner 跨境传 Gitee 被限速，v1.0.6/v1.0.7 两次 Gitee CI 步骤分别卡死 80+ 分钟）。`desktop-release.yml` 删除「发布到 Gitee desktop-latest」与「更新发布中心首页版本」两个 CI 步骤，替换为本地操作指引 echo 步骤；CI 只负责 GitHub 侧（desktop-latest + 版本化 Release，均 make_latest=false）。`scripts/ci/publish-gitee-local.sh` 升格为 Gitee 正式主路径：CI 构建完成后本机`gh run download <RUN_ID>` → 产物平铺进 work/release-assets/ → 跑脚本（读 ~/.config/ceru/gitee_token，经多标签版 publish-gitee.py 发 desktop-latest + 版本化 Release，最后调 update-hub-readme.py 同步发布中心首页 GitHub+Gitee 镜像）。同次修复脚本两个小问题：SCRIPT_DIR 计算移到 cd 之前（相对路径调用失效）、校验 curl 补 -L（Gitee 下载 302 跟随后才是 JSON）。v1.0.7 发布实况：CI 发完 GitHub 侧（mac 产物 + 仅 mac 的 latest.json，Windows 构建未完成）→ 等 Windows 构建完成后取消 CI（Gitee 跨境步骤被掐掉）→ 本地删除混有 1.0.6 残留的 Gitee release 重建，全量传 1.0.7 六件套（含双平台 latest.json）+ 版本化 release；GitHub 侧本地补 Windows exe/.sig、删 1.0.5/1.0.6/历史残留附件、换双平台 latest.json、补建版本化 release desktop-v1.0.7；发布中心首页两端版本行已同步 v1.0.7。 | 验证：Gitee/GitHub desktop-latest 均为 1.0.7 六件套，latest.json 含 darwin-aarch64 + windows-x86_64（URL 各指各端）；版本化 release 双端各 5 附件（无 latest.json）；首页版本行 v1.0.7（GitHub+Gitee）。`bash -n` 脚本语法 OK、workflow js-yaml 校验 OK。索引：CI 发布流程/脚本改动，不涉及应用代码图，**未重跑 graphify 全量产物**，仅追加本日志。 |
| 2026-10-13 | 修复「换源后底栏爱心丢失 + 歌名/封面被新音源覆盖」：底栏心形此前按收藏锚点的精确 `source:songmid` 判定，当同一首歌的收藏记录挂在另一音源的 songmid 下（从另一实例播放、其他设备同步收藏、自动换源起点不同）时心形显示未收藏。改动（纯前端判定层，不碰播放链路/动效/UI 结构）：①`cloudLibrarySync.ts` 新增 `findFavoriteSongByIdentity`——精确 id 未命中时按「歌名+歌手」（trim+lowercase 规范化；双方都有歌手必须一致，缺一侧时按歌名）在「我的喜欢」记录里找同一首歌；②`PlayMusic.vue` 的 `refreshLikeState` 增加跨源身份兜底（`getSongs` 扫描收藏记录，命中即显示已喜欢）；③`onToggleLike` 取消喜欢时若心形是靠身份命中显示的，删除匹配到的那条收藏记录（`removeTarget`），「歌单移除 → `syncRemoveSongsFromCloud` 云端同步移除 → `evictUnlikedSongFromPlayback` 播放队列切歌」链路不变，仍用当前播放实例做队列移除；④底栏展示锚点优先：新增 `displayAnchor`（锚点与当前播放实例同一首歌才采用，避免切歌加载窗口提前显示下一首）、`displaySongName`/`displaySinger`/`displayCoverSrc`，模板歌名/歌手/封面改绑这三个计算属性——换源后新音源缺失或不同的封面不再覆盖原显示。版本号 1.0.6 → 1.0.7（`package.json` 唯一来源，`src-tauri/Cargo.toml`/`Cargo.lock` 同步对齐）。 | `npx vue-tsc --noEmit` 通过（exit 0）；`npx vite build` 通过（15.6s）。跨源心形与封面保持需桌面实播确认（收藏 QQ 版本后播放酷我实例、取消喜欢验证歌单+同步链路）。索引：TOP_GRAPH「Playback And Media」收藏段补跨源身份匹配与锚点优先展示；路由表「收藏」行更新；graphify 增量重建后重生成 graph.html。 |
| 2026-10-13 | 补发 v1.0.6 到 Gitee（本地直连兜底）+ 新增 `scripts/ci/publish-gitee-local.sh` 兜底脚本。背景：v1.0.6 workflow（run 38334195587）的 Gitee 步骤跨境限速卡死 80+ 分钟（GitHub 侧已发布成功）；既有 release 1198996（tag desktop-latest）混有 1.0.5 旧附件 + CI 半传的 1.0.6 + 两个 latest.json（一新一旧）——Gitee API v5 的 releases 列表接口不返回附件 id，`publish-gitee.py` 的清旧循环实际空转，且 `latest.json` 下载 URL 仍返回 1.0.5 旧清单，更新通道失效。处理：取消 CI（已确认 cancelled）→ API DELETE 整个 release 1198996 → 本机（国内直连 Gitee）在 desktop-latest 标签上重建新 release id=1201658，全量上传 1.0.6 六件套（aarch64 app.tar.gz/.sig/.dmg + windows exe/.sig + 指向 Gitee 的 latest.json）。新增 `scripts/ci/publish-gitee-local.sh`：令牌从 `~/.config/ceru/gitee_token` 读取（兜底 `~/.gitee-token`），缺 Gitee 清单时自动调 make-latest-json.py 生成，上传后 curl 回读清单校验。 | 验证：Gitee `latest.json` 返回 version 1.0.6 且 URL 指向 Gitee；六个附件下载 URL 全部 HTTP 200；release 仅含 1.0.6 附件（+自动源码包），无 1.0.5 残留。正常发布流程无需人工提供令牌（workflow_dispatch + GITEE_RELEASE_TOKEN secret）；本地兜底走 publish-gitee-local.sh + 本机令牌文件。索引：仅新增 CI 兜底脚本，不涉及应用代码图，**未重跑 graphify 全量产物**，仅追加本日志。 |
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
| 2026-10-16 | 低音增强去“假”：移除 200Hz 宽低架、tanh 谐波和会相位抵消的并联低通，改为 80Hz 真实 dB 低架 + 170Hz 轻度 mud cut。 | 未编译（按用户要求）；Rust 断言与内置 MPV 建图通过；更新 Playback And Media 音效流并重跑 Graphify。 |
| 2026-10-16 | 发布中心 README 新增项目来源署名：树夏Music 基于澜音 Music 改进，原 Electron + Vue 迁移为 Tauri 2 + Rust + Vue 3；GitHub/Gitee 发布页同步。 | 仅发布文档变更；更新发布页路由与 Graphify 索引。 |
| 2026-10-16 | 响度三档按 FFmpeg 官方 `dynaudnorm` 语义重设（`g/m/r` 单调、`s=0`）；MPV 低音补回 Electron 的并联 tanh 激励，Web Audio 回退同步，低音预设高亮跟随 dB。 | 未编译（按用户要求）；内置 MPV 滤镜加载与 FFmpeg 三档 RMS 实测通过；Graphify 增量刷新，更新 Playback And Media 音效流。 |
| 2026-10-16 | 开场动画改为 1.4s 起与主页交叉溶解，插件初始化不再阻塞进主页；新增 macOS 原生麦克风授权命令并实测识曲链路。 | 编译唯一 Preview 测试包；更新启动/权限路由与 Graphify 索引。 |
| 2026-10-16 | 对齐安卓 StartupPreloadOverlay：1.2s 主页预挂载、1s 首帧准备、560ms 星空线性淡出、90ms 后卸载遮罩。 | 编译唯一 Preview 测试包；更新启动生命周期路由与 Graphify 索引。 |

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
