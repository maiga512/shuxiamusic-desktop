## 2026-09-29 MPV 退出生命周期修复

用户确认：软件退出或替换后，MPV 进程仍可能继续播放。本轮定位并修复了正常退出路径。

根因：MPV 是 Rust 通过 `std::process::Child` 单独启动的子进程。旧的 `mpv_shutdown` 在持有运行时锁时先通过 Unix IPC 等待 `quit` 响应，再执行 `Child::kill()`；IPC 断开或卡住时，强制回收可能无法及时执行。

本轮修改：
- `src-tauri/src/commands/mpv_player.rs`：退出时先从运行时状态取出 `Child`，清空运行时句柄并释放锁，然后直接 `kill + wait`。退出不再依赖 MPV IPC 响应。
- `src-tauri/src/lib.rs`：保留 Tauri `RunEvent::ExitRequested` / `Exit` 的统一清理入口。
- 关闭到托盘仍然只隐藏窗口，不停止 MPV；只有真正退出应用才终止 MPV，符合 Electron 的 `closeToTray` 语义。

Electron 对照：
- 窗口关闭/退出策略对照 Electron `src/main/index.ts` 与 `src/main/services/windowLifecycle.ts`。
- Tauri 适配只位于 Rust MPV 子进程边界，因为 Electron 的播放进程由 Electron 管理，而 Tauri 的 MPV 是 Rust 直接创建的 `Child`。

验证：`cargo check`、`npm run build`、`node --check sidecar/index.mjs` 已通过。当前环境禁止读取完整进程表，因此实际播放后退出的 MPV 进程树仍需在可观测的桌面环境验收。

## 2026-09-25 启动播放被打断 + 同步页面不刷新

1. **启动"响一下→被掐掉→要手动点播放"**：
   - 根因：`App.vue` 在第一次播放 1s 后调 `getUserMedia({audio:true})` 申请麦克风，
     macOS 会重开音频会话，把正在播的 mpv 掐断；权限点完后没人续播。
   - 修复：`App.vue` 权限请求延后到播放稳定后 2.5s，结束后广播 `ceru-audio-session-ready`；
     `globaPlayList.ts` 新增 `resumePlaybackAfterAudioSessionChange`，
     收到事件后若"本来应该在播却没在播"（wasPlaying / autoPlayOnLaunch），
     用 cachedAudioUrl + currentTime 原生起播续上。
2. **歌单/我的喜欢详情页不实时刷新**：`src/views/music/list.vue` 原来零事件监听，
   远端同步改了本地数据也要"退出重进"才刷新。新增 `playlist-updated` /
   `ceru-favorites-updated` / `ceru-nas-sync-events` 订阅（250ms 防抖、静默重读、
   只对本地歌单页生效）。
3. 同步水位/快照并发安全（`nasSyncPoller.ts`）：由并行会话（Codex）同期修复，
   已确认事件应用成功后才推进 revision。
4. 构建安装：Android `2.5.84(109)` 已装到 R38M10LATKJ；Mac 新包已替换到
   `/Applications/澜音.app`（旧版保留为 `澜音.app.backup-<时间戳>`）。

验收：重启澜音应自动从上次位置续播；权限弹窗期间若被打断会自动续播；
打开"我的喜欢"页面时，安卓端收藏/取消应原地增删，不需退出重进。


## 2026-09-23 查重清理默认展开全部重复歌曲

用户：我的喜欢里查重清理打开后，每组只剩歌名一行，看不到两首分别是哪首，也无法判断按建议勾选删的是谁。要求每组有多少首就展开多少首；每首歌前面可勾选，歌名后面有「保留」和「删除」；可多选后再一键清理。

根因：分组卡片在限高列表里被弹性压缩，再加 overflow:hidden，歌曲行全部被裁掉，只剩组头。

本轮：
- `DuplicateSongsDialog.vue`：每组默认展开全部歌曲；左侧圆点勾选；右侧「保留」取消勾选、「删除」立刻删这一首；「一键清理」只删当前勾选项。
- `list.vue`：删除按 `source:songmid` 精确移除，并同步收藏/云端。
- 打开弹窗仍会按建议勾选（每组第 1 首默认保留），但每首歌都看得见、可改。

验收：
1. 歌单更多菜单 → 查重清理
2. 每组下面都能看到全部重复歌曲，不是只剩一行歌名
3. 勾选后点一键清理，只删勾选的歌；点删除则立刻从列表消失

## 2026-09-22 底栏进度匀速 + 普通页闲置 CPU

用户：普通播放界面底栏进度一格一格跳，希望细腻匀速；只有额外消耗很少才做。普通页闲置听歌还想再降一点 CPU，不能动播放链路、不能让切菜单更卡。

做法：
- 底栏进度不再跟 Pinia 每秒跳一次。`PlayMusic.vue` 用 compositor `transform` 按剩余时长匀速走到 100%。
- `progressPublishInterval` 仍是全屏 250ms / 前台 1000ms / 后台 2000ms。时间文字仍按秒。
- 拖动只改 UI，松手才 `nativeSeek`。窗口隐藏/暂停立刻钉住当前比例。
- 交叉淡化标记不再每秒空写；离结束还远时跳过 `updateMarkRange`。
- 不恢复 mpv 高频轮询，不加 60fps rAF。

验收：打开 `/Applications/澜音.app` 普通页播歌，底栏进度应匀速走，不是一秒一跳。活动监视器里 `localhost` 不应比现在更高。不要新开 `tauri:dev`。

## 2026-09-20 起播播放不了 + 设置页转圈

用户：启动时点设置菜单卡顿/转圈；歌曲起播播放不了。

根因（起播，已实测确认）：
1. 聚合音源在拿不到真实直链时会返回 CDN 根地址，例如
   `https://aqqmusic.tc.qq.com/`（只有 host，没有路径）。
2. `isPlayableUrl()` 以前只校验 scheme，这种死地址被判为可播。
3. `mpv loadfile` 对任何字符串都返回 `success`，实测加载该地址后
   mpv 直接 `idle-active=True`、`path=None`：加载"成功"但没声音。
4. 于是坏地址被写进 SQLite URL 缓存和 `userInfo.cachedAudioUrl`
   （库里 26 条 tx 记录），启动恢复优先用它，且因为"成功"永不触发降级换源。
   结果就是点播放/下一首没有任何声音。

本轮修复：
- `playableUrl.ts`：http(s) 必须有真实 path，CDN 根地址一律判死。
- `globaPlayList.ts`：`applyPlayableUrl` 先校验（否则抛错走降级）；
  `_getCachedUrl` 读到坏条目就地作废并返回 null；`_setCachedUrl` 拒绝写坏地址；
  启动恢复用 `isPlayableUrl` 判断 `cachedAudioUrl`。
- `playlistManager.ts`：`getSongRealUrl` 的字符串兜底也要过可播放校验。
- `qualityAvailability.ts`：降档候选排序修方向（原来把"最高档"取成"最低档"）。

验收（已在 /Applications/澜音.app 实测）：
- 重启后 mpv 加载的是完整直链
  `https://aqqmusic.tc.qq.com/M500001Sx0eI0Yzbei.mp3?...&vkey=...`，
  `idle-active=False`、`duration=173s`、`media-title=摇篮曲`，正常出声。
- 坏缓存自愈：`tx_004NCv1Z0PrtaY_320k` 与 `cachedAudioUrl` 已被真实直链覆盖。

设置页（转圈/卡顿）本轮修复：
- `tauri-bridge.ts`：插件兜底路径从"逐个 await plugin_load_config"改成并发且复用
  缓存，避免启动期一次性串行打上百个 IPC。
- `plugins.vue`：插件列表有内存缓存，切走再进不再整块转圈；类型/角色补全并行。
- `settings/index.vue`：分类切换恢复滚动位置不再用 20 次 nextTick + 50ms 轮询
  （每次读 scrollHeight 都强制同步布局），改成最多 12 帧的 rAF 重试。
- 实测插件数据本身不慢：`plugin.loadAll` 冷启动 31ms、热 0ms，21 个插件都已带类型。

## 2026-09-20 对齐安卓版：重启续播 / 降档预判 / 下载目录

对照 `/Volumes/致钛 2T/shuxiamusic`（安卓版）做的对齐修复：

1. 重启续播（用户反馈"重启后从头播"）：
   - 暂停时 `persistPlaybackPosition(true)` 立即写进度（原来只在播放 tick 写）；
   - `seekTo` 后立即写进度；
   - `App.vue` 关窗请求（含关到托盘，不触发 pagehide）前派发 `ceru-persist-playback-state`，强制落盘 userInfo + songList；
   - `initPlayback` 恢复时不再清 `wasPlaying`，"上次在播 + 启动自动播放"语义成立；
   - `applyPlayableUrl` 不再吞掉 `pendingRestorePosition`，`handlePlay` 的首次播放 seek 兜底重新生效；
   - `LocalUserDetail` 的 watch 不再把 currentTime 归零去重，进度变化按 3s 节流独立落盘。
2. 播放音质：保留桌面逐档降级，但对齐安卓 `songDeclaresQuality` —— 歌曲声明了 types 时，未声明的档位不发请求，降级只在声明档位内进行；首选未声明时取"不超过首选的最高声明档"。
3. 失败自动下一首：0ms → 5s（`AUTO_NEXT_ON_FAILURE_DELAY_MS`，对齐安卓/落雪），防止烂列表请求风暴。
4. 换源：确定性失败（鉴权/额度/403/401/VIP/无版权）拉黑该源 120s（对齐安卓 `blockProvider`），换源循环跳过。
5. 下载目录：设置页 `saveDirectories`/`resetDirectories` 会把 `downloadDir` 推给实际执行下载的 Node sidecar（新增 `download.setDownloadDir`）；`DirectorySettings.vue` 加载时也同步一次（启动校正）。

验收：`npm run build`（含 vue-tsc）通过；sidecar `node --check` 通过；Graphify 增量 6742/14961/316。


## 2026-09-19 点播放/下一首要等很久

用户：闪退修好后，启动再点播放要等很久，点下一首也一样。

根因：
1. 暂停过渡默认开。`nativePlay` 先把音量打到 0 再 30 步淡入，`nativePause` 切歌前还要淡出。
2. 每 80ms 一次 `mpv_set_volume`，一秒十几次 Unix socket IPC，真正的 `mpv_load`/`mpv_play` 被堵住。

本轮：
- 播放立刻按目标音量 `mpv_play`，不再先静音再 fade。
- 切歌 `nativePause({ fade: false })`，手动暂停才淡出。
- 音量 IPC 合并为最新值；相同音量不再 emit。
- 已替换 `/Applications/澜音.app`。

验收：点播放和下一首应马上出声，不再空等几秒。暂停过渡仍只作用于暂停按钮。

## 2026-09-19 启动闪退 Abort trap 6

用户：打开 `/Applications/澜音.app` 立刻闪退。

根因：
1. `init_now_playing()` 跑在 `NSApplication didFinishLaunching` 的 C 回调里。
2. 旧实现用 `objc2::define_class!` / `block2::RcBlock`，方法体是 `extern "C"`。
3. release `panic = "abort"`。ObjC 类注册或 block 编码一旦 panic，就变成 “panic in a function that cannot unwind” 然后 abort。
4. `MediaStop` 热键失败只是日志，不是闪退原因。

本轮：
- `now_playing.rs` 改成 `ClassBuilder` + `addTarget:action:`，不再 `define_class!` / `addTargetWithHandler:`。
- debug 和 release 都打印 `[now-playing] MPRemoteCommandCenter 已接管键盘媒体键`，进程保持存活。
- 已替换 `/Applications/澜音.app`。

验收：点开澜音不再闪退；F7/F8/F9 和 Now Playing 媒体键仍应切歌/暂停。

## 2026-09-19 全屏退出/回主页/最小化内存不回落

用户：全屏播放界面最小化、回到普通界面、回到主页时 CPU 会降，内存不降。

根因：
1. 关全屏只把界面滑走、停动画。歌词树、封面、频谱、烘焙背景还挂在 WebContent 里。
2. 窗口最小化时若全屏还开着，`onFullPlayWindowState` 直接 return，重内容一点都不卸。
3. WKWebView 不会主动把堆还给系统，要拆 DOM + dispose。

已改：
1. `FullPlay.vue` 关全屏滑出后 `releaseFullPlayHeavyResources({ unmountRoot: true })`：卸歌词/频谱/封面/节日层，dispose AMLL，清烘焙缓存。
2. 最小化/藏窗口也走同一条释放路径；恢复窗口时直接挂回，不再滑一次。
3. 父级 400ms 后仍卸整个 FullPlay。

验收：完全退出后打开 `/Applications/澜音.app`。进全屏再退回底栏、回主页、或全屏时最小化，`localhost` CPU/内存都应回落。不要新开 `tauri:dev`。

## 2026-09-19 Mac 媒体键录入 + 启动自动播放

用户反馈：
1. Mac 上 Fn+F8 / F7–F9 媒体键录不进自定义快捷键，默认也不该丢
2. 播放设置要加“启动软件自动播放”开关

根因：
1. 切到内置 mpv 后 WebKit Media Session 不再拥有音频，硬件媒体键是 NX_KEYTYPE，不会变成 WebView KeyboardEvent
2. `hotkeys.rs` 的 CGEventTap 媒体键没有辅助功能权限时常失败，且录入对话框只认组合键
3. 启动恢复一直 `nativeLoad({ autoplay: false })` 再强制暂停，没有启动自动播放开关

本轮：
- `now_playing.rs`：`MPRemoteCommandCenter` 接管播放/暂停/上一首/下一首；Now Playing 元数据同步；录入模式只发 `hotkeys:media-capture`
- `hotkeys.rs`：系统媒体键 + F7/F8/F9 兜底；录入时不派发播放
- 设置页可录入媒体键；显示 上一首 / 播放暂停 / 下一首
- `playSetting.autoPlayOnLaunch` 默认关；打开后只在启动 URL 真正 load 成功后 `start()`

验收：
1. 退出后打开 `/Applications/澜音.app`，键盘 F7/F8/F9（Fn 媒体键）应能切歌/暂停
2. 快捷键设置点“设置”后按 Fn+F8 应能录入并保存
3. 播放设置打开“启动软件自动播放”后重启应自动播；关掉则只恢复进度

# Ceru Music Tauri Handoff

Last updated: 2026-09-29 Asia/Shanghai

## 2026-09-29 全屏多首切歌性能审计状态

- 当前执行环境统一禁止本地端口监听（1421/1422/5173/4173 均返回 `EPERM`），无法启动新的 Tauri/Vite 交互实例；残留调试页是空 `#app`，不能进行真实播放、切歌或全屏采样。
- 静态审计确认播放链已有请求 ID、旧音频监听器移除、预取缓存上限、全屏重资源释放和本地进度时钟降频；没有证据支持直接改动播放时序。
- 修复 `FullPlay.vue` 的背景烘焙监听：从 `deep: true` 的颜色对象监听改为按歌曲/来源/颜色/显示状态生成稳定 key，避免同一首歌的深层响应式变化重复触发同步 Canvas 烘焙。`npm run build` 已通过。
- 完整性能结论仍需在允许端口监听的桌面环境按普通播放、多次上一首/下一首、全屏多首切歌、退出全屏、最小化恢复采集完整进程树后确认。

- 本轮实际检查到的调试页仍是空的 `#app`，没有 Vue DOM、播放控件或可操作播放器。
- 之前保存的 30 秒进程采样对应的是空页面与 `mpv --idle=yes`，不是普通播放，因此不能作为播放、切歌或全屏性能数据。
- 本轮尝试重新启动单实例 `npm run tauri dev`，Vite 被当前运行环境拒绝监听 `127.0.0.1:1421`，返回 `listen EPERM`；因此没有伪造播放/全屏测试结果，也没有继续盲改性能代码。
- 需要在允许本机端口监听的桌面环境重新启动应用后，按普通播放、连续切歌、全屏连续播放、退出全屏、最小化恢复五个阶段采集完整进程树。

- 已确认 `src/main.ts` 中插件预热与飞牛同步使用独立异步任务，不等待其完成后才挂载 Vue。
- `createTauriBridge()` 的封面代理基础地址预热改为首帧后的定时任务，减少挂载前的额外 IPC。
- `main.ts` 对桥接初始化增加 `try/catch`，避免桥接初始化异常直接中断后续 `createApp`/`app.mount` 执行。
- `npm run build` 通过。
- 仍需在可运行的 Tauri 窗口中确认 `#app` 已产生 Vue DOM；Graphify 更新因环境 `Operation not permitted` 暂未完成。

## 2026-09-19 音效点一下等一下

用户：环绕小/中/大房间、响度轻度/标准/强力，点一下都要等一下；质疑没对齐。要照 GitHub 上同类播放器做。

根因：以前每次 `set_property af` 都把整条 lavfi 拆掉重建。环绕 `amovie+afir` 和 `dynaudnorm` 都会重新初始化，所以会顿。

方案：mpv 官方 `af add @label:`（IINA / mpv.net 同路）。响度走内置 `@loud:dynaudnorm`，环绕仍走 WebKit 归一化 `afir`，但三个房间 IR 一次预生成。

已改：换档只替换 `@loud`/`@sur`；前端连点排队；滤镜 IPC 不再占着 runtime 锁。

验收：打开 `/Applications/澜音.app`，播放中连点环绕三档和响度三档，应立即换声，不要卡一下。不要新开 `tauri:dev`。

## 2026-09-19 设置页切模块 CPU/内存偏高

用户：进设置、切左侧模块时 CPU/内存都明显抬高。音效滤镜由另一份任务在做，本轮不动。

根因：一进设置就把 7 个 section 打进模块图；插件页 2384 行；播放设置一挂载就 `enumerateDevices` + 均衡器/音效；`<KeepAlive :max="2">` 把最重的两份 DOM 留着。

已改：
1. 设置分类改 `defineAsyncComponent`，去掉 KeepAlive，切走即卸载。
2. 插件页显式异步拉 `plugins.vue`，不再靠全局自动注册把 2384 行打进设置入口。
3. 播放设置里播放列表/输出/均衡器/音效按需挂载；设备已有列表就不再扫。
4. 各 section 入场 `fadeInUp` 删掉。

验收：打开 `/Applications/澜音.app` 进设置应只挂当前分类（默认外观）；连点左侧模块 CPU 短峰后应掉；切走插件后 `localhost` 内存应回落。搜索跳到均衡器/插件仍能滚到对应块。不要新开 `tauri:dev`。

## 2026-09-19 响度轻度/标准/强力不如关掉

用户：响度三档听感还不如关；以前是越来越加强。

根因：把 Electron DynamicsCompressor 硬译成 FFmpeg `acompressor` 后再接 `alimiter`。热母带会被压到比直出还小；`knee=20dB` 还曾经直接建图失败。
mpv/FFmpeg 实时响度用 `dynaudnorm`（常见 `--af=dynaudnorm`）。

本轮：轻度/标准/强力改为 `dynaudnorm` maxgain 4/8/16、compress 3/6/10；响度不再额外 limiter。白噪声实测三档都比关掉响，安静素材一档比一档抬得更明显。

验收：打开 `/Applications/澜音.app`，只开响度，轻度 < 标准 < 强力，且都不应比关掉更闷。

## 2026-09-19 打包后音乐/播客全部播不了

用户：打包后连不上网，音乐和播客都播不了。

不是网络。sidecar 还在拉网易/QQ URL，curl 和托管 node fetch 都是 200。
根因：
1. FFmpeg 9 `acompressor` 的 `knee` 只接 1–8。上一版写成 Electron 的 `knee=20dB`，lavfi 整图失败，mpv 报 `Audio filter initialized failed`，任何歌都没声。用户开了低音+响度，所以一装包就爆。
2. 播放失败后 `verifyPlayableUrl` 又拉起第二个 mpv 做 `mpv_probe`，插件 CDN 上挂着，看起来像断网。

本轮：
- 响度 `knee` 改成 6/7/8，`threshold` 改成线性增益
- `verifyPlayableUrl` 不再 spawn 探活 mpv
- `nativeLoad` 滤镜失败不再把整次加载打掉

验收：退出后打开 `/Applications/澜音.app`，音乐和播客应能直接播。开着响度/低音也要能播。

## 2026-09-19 启动更新弹窗去掉 + 播客封面不随 4 列撑大

用户：启动界面不要更新弹窗；播客窗口从一排 5 个缩到 4 个时封面反而变大；问快进/seek CPU 高一下是不是正常。音效对齐由另一份任务做，这轮不动 `mpv_player.rs`。

已改：
1. `welcome/index.vue` 进主页后不再 `checkForUpdates()`。设置里「检查更新」仍可手动点。
2. `podcast.vue` 网格改成固定 `--cover-size` 轨道，不再 `1fr` 撑满。列数可以 4，封面保持 5 列时的 156/172px。
3. 快进 CPU：拖动只改百分比，松手才 `nativeSeek`。短峰是 mpv `--hr-seek=no` 重新解码，不为降 CPU 改成高精度 seek。

请完全退出后打开 `/Applications/澜音.app`：启动欢迎页不应再弹更新；播客缩到 4 列封面不应比 5 列明显更大。不要新开 `tauri:dev`。

## 2026-09-19 MPV 环绕改走 WebKit 归一化卷积

用户：切到 MPV 后高级音效/均衡器没有 Electron Web Audio 好。前一轮已把低音改成 lowshelf、响度 makeup 改成线性增益，但环绕仍不对。

根因：
1. Electron 环绕是 Convolver 并行 dry/wet。WebKit `normalize=true` 用 RMS 再乘 -58dB GainCalibration。
2. 上一版 lavfi 把 `afir` 的 `dry` 设成 0。FFmpeg 9 里 `dry` 是送进卷积的输入增益，不是并行干声；`dry=0` 会让湿声变成静音。
3. FFmpeg 9 默认 `irnorm=1` 是 L1 归一化，会把噪声 IR 压得几乎听不到。`gtype` 已弃用。

本轮：
- IR 改成 float32 WAV v2，按 WebKit `calculateNormalizationScale` 写入缓存
- 构图：`aresample=48000,asplit` 后 `afir=dry=1:wet=0.3/0.5/0.8:irnorm=-1`，再 `amix` 干湿
- 只开环绕不加 limiter，避免把混响压闷
- ffmpeg/mpv 实测：旧图 RMS 等于干声；新图 small/medium 比干声稍响

验收：退出澜音后打开 `/Applications/澜音.app`，只开环绕 small/medium/large 应能听出空间感，关掉后不留回声。不要新开 `tauri:dev`。

## 站立口径：必须中文

所有 AI / agent 回答用户必须用中文。不要用英文交仓、不要把英文日志贴给用户。这是强制约定，不是建议。

## 2026-09-19 点 Dock 弹一下又落下 + 退出全屏内存不掉

用户：点底栏封面/歌曲进全屏，会先跳上来再掉下去；退出全屏后 CPU 掉了，内存还在。

根因：
1. 同一击把全屏打开后又关了。打开时 FullPlay 从屏幕外滑入，点击落到刚露出来的层上，第二次 `toggleFullPlay` 把它关回去。
2. 退出全屏只卸歌词树，FullPlay 根节点还挂着，烘焙图和封面解码还在 WebContent 里。

已改：
1. `toggleFullPlay` 打开后 450ms 内忽略第二次切换；空闲 pointerdown 延后绑定。
2. 关全屏滑出后卸载整个 FullPlay，并清烘焙缓存。

请完全退出后打开 `/Applications/澜音.app`：点底栏一下应直接进全屏并停住；退出全屏后 `localhost` 内存应跟着掉。

## 2026-09-19 进全屏要点两下 + 第一首卡住 + 退出全屏不回落

用户：底栏点进全屏第一下没反应；重启后第一首很慢，切下一首才正常；退出全屏后 CPU/内存还停在全屏水平。

根因：
1. 关全屏后 FullPlay 停在底栏位置（`top: 100vh - dock`），WKWebView 还可能吃掉底栏第一击；唤醒标志也会把“进全屏”那一击吞掉。
2. 启动恢复先 `mpv_probe` 再 `mpv_load`。探活会另拉一份 mpv，第一首卡住；下一首走正式 load，所以显得正常。
3. 退出全屏只把界面滑走，前台仍留着歌词树/封面/烘焙背景。

已改：
1. 关全屏后全屏层停到 `top: 100vh`，不再压住底栏；点底栏进全屏不再走唤醒吞击。
2. 滑出后卸掉歌词/封面/频谱/背景图，CPU/内存跟普通界面走。
3. 启动恢复和缓存命中直接 `mpv_load`，失败再换新链，不再先 probe。

请完全退出澜音后打开 `/Applications/澜音.app` 验收：底栏点一下应进全屏；重启后第一首应能直接起播；退出全屏后 `localhost` CPU/内存应掉下来。

## 2026-09-19 全屏底栏点一下唤醒 + 全屏内存轻减

用户：全屏底栏要点两下才弹出来；全屏 CPU/内存再压一点，动效/音效/播放链路都不能动。

根因：自动隐藏后 Dock 用 `translateY(100%)`。WKWebView 视觉移走了，点击检测还在原位；第一次点击打在看不见的 Dock 上，走 `@click.stop="toggleFullPlay"`，像要点两下。唤醒原先只听 `mousemove`，触控板轻点不一定能叫醒。

已改：
1. 隐藏 Dock `pointer-events: none`；底部单独留唤醒带，点一下立刻滑出。
2. 全屏层补 `pointerdown` 唤醒；这一击不会关全屏，也不会点到刚露出来的按钮。
3. 双层烘焙背景过渡完释放闲置层；缓存从 24 收到 8。
4. 频谱用缓存宽度画，不再每帧 `getBoundingClientRect`。

请关掉澜音后装本轮正式包，打开 `/Applications/澜音.app`：全屏等底栏藏起，点底部一下应立刻滑出。频谱/黑胶/取色背景/音效应与现在一致。

## 2026-09-19 localhost 内存：列表 CDN 封面缩略图 + hover 底图按需解码

用户：CPU 已经下来，不要动播放、开关、动效；活动监视器里 `localhost` 还有 400 多 MB。

当时 RSS：WebContent 约 214MB，活动监视器 Memory 栏常比 RSS 大。主因不是 mpv，是 WKWebView 把列表 CDN 原图整张解码；发现/歌单卡片还把同一张图铺进 hover 模糊底。

已改：
1. `coverThumb.ts` / `sImage.vue`：网易 `param=`、QQ `T00xRxx`、酷狗 `{size}` / 路径尺寸、酷我 size 改成 256–400。全屏封面不传 `max-edge`，仍走原图。
2. `find.vue` / `songlist.vue`：hover 模糊底只在鼠标进卡时才绑 `--cover-url`，离开 400ms 后清掉。
3. `lib.rs`：WKWebView `NSURLCache` 内存上限 32MB。

请在 `/Applications/澜音.app` 打开发现页滚一会，看 `localhost` Memory 是否从 400 多落下来。不要新开 `tauri:dev`。

## 2026-09-19 正式验收：倍速/canplay 死循环已断，CPU 回到个位数

用户纠正成立：不是状态栏歌词。活动监视器里第二个高占用叫 `localhost`，就是 WebContent / `tauri://localhost`。之前两边各 70–80%、合计约 160% 的主因是：

`canplay` → `mpv_set_playback_rate(1)` → `emit_state(set_playback_rate)` → 再次 `canplay`

通过自定义协议 IPC 把主进程和 WebContent 一起打满。热日志曾见每 2 秒 `ipc:5600–6100`，几乎全是 `mpv_set_playback_rate`。

已修并装进 `/Applications/澜音.app`：
1. `nativePlayback.ts`：`canplay` 去重；只在 `load` / `file-loaded` 发一次；同值倍速不打 IPC。
2. `PlayMusic.vue`：网页 audio 同值不重复写 `playbackRate`。
3. `mpv_player.rs`：`mpv_set_playback_rate` 同值直接返回，不 set / 不 emit；热日志加 `set_rate=`。

2026-09-19 06:01 稳定点播验收（普通界面，正在出声）：
- `ceru-music` 平均约 1.7%
- `WebContent`/`localhost` 平均约 2.3%
- `mpv` 平均约 3.2%
- 四进程合计平均约 7.2%；主进程+WebContent 约 4%
- `/tmp/ceru-mpv-hot.log`：`set_rate` 持续为 0；`frontend_ping` 每 2 秒通常只有 1–6 次 IPC，不再每秒几千次 `mpv_set_playback_rate`

安装注意：整包 `ditto` 时若旧进程还占着二进制，可能看起来没换上。先退出进程，再覆盖并 `codesign --force --deep --sign -`。`codesign` 后体积从约 39.06MB 收到约 38.83MB 是正常签名变化，不是回退旧包。

## 2026-09-19 播放 CPU：不是状态栏，是自定义协议 IPC

用户纠正：关了状态栏歌词还是约 160%。活动监视器里第二个高占用叫 `localhost`，就是 WebContent / `tauri://localhost`。

硬证据：
- 播放中：`ceru-music` 约 75–82%，`WebContent` 约 73–89%，`mpv` 约 15–25%
- 暂停/停播后三边都掉到约 0%
- `sample`：主进程大量 `WebKit::WebPageProxy::startURLSchemeTask`；WebContent 走 `fetch` / 自定义协议
- DB：`mac_status_bar_lyric=false`，桌面歌词 `isOpen=false`

已改（正在重打正式包验收）：
1. `nativePlayback.ts`：本地时钟降频（全屏 250ms / 前台 1000ms / 后台 2000ms），drift 对表 5s，volume no-op 去重
2. `PlayMusic.vue` / `GlobalAudio.vue`：Dock/进度节流
3. `tauri-bridge.ts`：`setProgress` 改走 `setProgressBar` + 去重；无歌词消费者时丢掉 `play-lyric-*` / `app:set-progress` / thumbar 噪声 emit
4. `desktopLyricBridge.ts`：把歌词消费者开关写到 `window.__CERU_*`，给 bridge 判断

验收标准：`/Applications/澜音.app` 点播后，`澜音` + `tauri://localhost` 不再各 70%+；目标合计尽量 <20%。音量不应从 0 起步。

## 2026-09-19 播放时 CPU 两边各 75%：进度事件 + 本地代理拷音频

用户证据：停播 `tauri://localhost` 2.4%、`澜音` 0.4%；一点播两边各 75% 多。搜「澜音」看不到 mpv，mpv 进程名是 `mpv`。

根因：
1. `mpv_load` 每首歌再挂一条 IPC 监听，观察 `playback-time`，每帧把完整 snapshot 灌进网页。
2. 播放 URL 还经 `127.0.0.1/stream/` 本地代理，Rust 把整首歌拷一遍，占用算在 `澜音` 上。

已修并重装 `/Applications/澜音.app`：
- 监听只挂一次；进度改为 100ms 问一次 `time-pos`，事件不再带完整 state。
- mpv 直接拉源 + headers，不再经本地 TCP 代理。
- 均衡器滤镜合成一条 lavfi，不再每段单独图。

请在 `/Applications/澜音.app` 点播验收：播放中 `澜音` + `tauri://localhost` 不该再各 75%。解码在 `mpv`。

## 2026-09-19 正式包已装上：播放只走内置 mpv

用户命令：不要网页兜底，解码 / 均衡器 / 低音 / 环绕 / 响度全部走 mpv；把 mpv 打进安装包；打包后听真实效果，看 `tauri://localhost` CPU/内存下来。不要新开第二份 `tauri:dev`。正在测的是 `/Applications/澜音.app`。

本轮实际完成：
1. 修了 `src/tauri-bridge.ts` 两处残缺 `if`，`vue-tsc --noEmit` 已过。
2. 删了致命参数 `--cache-min=512K`。mpv 0.41 没这个选项，带上会立刻退。
3. 播放只走 `mpv_load/play/pause/seek/set_volume/set_audio_filters`。`<audio>` 空壳不设 src。`needsAudioGraph()` 恒为 false。
4. 10 段 EQ、低音、环绕、声道平衡、响度只走 mpv lavfi。开均衡器不再建网页 AudioContext。
5. 可播链接探测也改成 `mpv.probe`，不再 `new Audio()`。预加载不绑网页 `<audio>` src。
6. `mpv_probe` 改成走应用内 `Resources/mpv/bin/mpv`，不再只走 PATH。
7. `npx tauri build --bundles app` 已过。`ditto` 覆盖到 `/Applications/澜音.app`，并 adhoc 签名。不要 `rm -rf` 这个 app。

安装包验收：
- `/Applications/澜音.app/Contents/MacOS/ceru-music` 约 37MB，带前端。不是 15MB 那个没嵌入前端的 cargo 二进制。
- `澜音.app/Contents/Resources/mpv/bin/mpv` + `lib` 47 个 dylib。`otool` 无 Homebrew 路径。mpv v0.41.0。
- 二进制字符串里没有 `--cache-min`。
- 2026-09-19 01:17 已打开。进程应该看到：`ceru-music`、sidecar node、`Resources/mpv/bin/mpv --idle=yes` 常驻。

用户怎么听：
- 直接用 `/Applications/澜音.app`。点一首歌。
- 出声后打开活动监视器：解码应该在 `mpv` / `澜音`，不在 `tauri://localhost`。均衡器可以开着测。
- 无感交叉淡化这轮不走网页双解码。暂停过渡用 mpv 音量步进。

禁止：
- 不要新开第二份 `tauri:dev`。
- 不要用 15MB `ceru-tauri` 覆盖 `ceru-music`。
- 不要装回 00:08 那个带 `--cache-min` 的旧包。
- 两条同名「经典老歌」不删不合并。

还没做完（不在这一刀里，下一轮再对）：
- 插件能力同步 / 歌单排序 / 播客收藏
- 飞牛封面、飞流歌单封面「我的喜欢」为空
- 洛雪旧插件完全兼容（野草能识别不等于完全对齐）
- 切歌慢、上一首/下一首
- 桌面歌词轻量入口
- 插件 worker 空闲回收（启动动画里预拉起）

## 2026-09-18 播放只走内置 mpv，不再回退网页

用户命令：不要网页兜底，解码、均衡器、低音、环绕、响度全部走 mpv；把 mpv 打进安装包；打包后听真实效果，看 `tauri://localhost` CPU/内存下来。不要新开第二份 `tauri:dev`。正在测的是正式包 `/Applications/澜音.app`。

做了什么：
1. `nativePlayback.ts` / `ControlAudio` / `globaPlayList.applyPlayableUrl` 只打 `mpv_load/play/pause/seek/set_volume/set_audio_filters`。`<audio>` 留空壳，禁止设 src。
2. `GlobalAudio.needsAudioGraph()` 恒为 false。10 段 EQ、低音、环绕、声道平衡、响度只走 mpv lavfi。
3. `scripts/prepare-mpv-runtime.mjs` 把本机 mpv + dylib 拷进 `packaging/mpv`，改 `@rpath`。`tauri.conf.json` 资源 `"../packaging/mpv": "mpv"`。打包脚本先 `mpv:prepare-runtime`。
4. Rust 优先找 `Resources/mpv/bin/mpv`，再找 Homebrew。找不到就报错，不回退网页。
5. 暂停过渡仍用 mpv `set_volume` 步进。无感交叉淡化这轮不开网页双解码。

验收：
- 点播有声音，解码在 `澜音`/内置 mpv，不在 `tauri://localhost`。
- 开均衡器/低音/环绕/响度，网页不再建 AudioContext。
- 没装系统 mpv 也能播，靠 app 内 `Resources/mpv/bin/mpv`。
- 暂停过渡、上一首下一首、seek、音量仍可用。
- Dock 点一下进全屏、最小化不闪封面，保持上一轮修复。


## 2026-09-18 活动监视器：tauri://localhost 10.8% / 396MB

用户截图来自正式包 `/Applications/澜音.app`，不是 tauri:dev。

拆开：
- `tauri://localhost` 10.8% / 396MB = WKWebView 网页进程。GPU 0%，说明不是在画界面，是 JS + 网页音频。
- `澜音` 8.0% / 61MB = Rust 主进程。闲置唤醒 152 次，更像出声/代理线程。
- Graphics and Media 2.3% / 86MB = 系统媒体。

根因：播放仍走网页 `<audio>`。默认第一次 play 还会 `applyToBoth()` 把声音接到 Web Audio（10 段 EQ 图），均衡器关着也建。解码算在网页进程上，所以 localhost 会到 10%。

本轮源码改动（安装包要重编才看得到）：
1. 没开均衡器/音效/无感过渡/全屏频谱时，不建 Web Audio，声音走 `<audio>` 直出
2. 窗口隐藏时不再把 timeupdate 灌进 Vue
3. userInfo 不再因为 currentTime 整份 JSON 落盘；最小化时才存一次进度
4. 菜单栏歌词隐藏后 2 秒一轮

要看到活动监视器变化，必须重新打包安装，不能只热更正在跑的 `.app`。

## 2026-09-18 点 Dock 第一次进不了全屏 + 最小化继续冻绘制

用户：点底部 Dock 第一次唤不起全屏，要等一下再点；关掉全屏也一样。要求点一下就有滑入/滑出。同时窗口最小化、普通界面、全屏界面继续极致压 CPU/内存，但不影响播放、切歌、动画。

根因：
1. 上一轮把 `content-visibility: hidden` 打在整个 `.home` 上。Dock 和 FullPlay 都在 `.home` 里，WKWebView 对跳过绘制的子树不做点击测试，第一次点被吃掉。
2. FullPlay 是 `defineAsyncComponent`，第一次点只开始拉模块，界面还没挂上。
3. 打开还多等一帧 rAF；关掉 320ms 就把歌词树卸了，再开要重挂 AMLL。

已修：
- 冻绘制只打在 `.home-container` / 设置页 / 全局背景，不冻 `.home`、不冻 `#app`（音频在 Provider）
- FullPlay 改同步引入，点一下立刻挂壳
- 打开：先强制一次布局再滑入，不再空等 rAF
- 关掉：滑出后前台留着歌词树，再点一下就能滑回来；窗口最小化后再卸重内容

请在现有窗口：点 Dock 一次应立刻滑入，再点一次立刻滑出。不要新开 `tauri:dev`。

## 2026-09-18 最小化冻绘制、唤醒不闪封面

用户确认：冻绘制、不拆树。不影响播放/控制；打开后不要闪、要很快显示。

做法：
1. `sImage.vue`：窗口隐藏时不把当前页封面当看不见卸掉。只有窗口可见、并且这张图曾经上过屏、现在又滚出屏幕，才释放。唤醒后等 IntersectionObserver 再次认为可见，才允许释放，避免中间一帧闪加载。已经卸掉的图不会在隐藏时重新去拉。
2. `App.vue`：隐藏时给 `.home` / 设置页 `.main-container` / 全局背景加 `content-visibility: hidden`，并用当时窗口宽高做 `contain-intrinsic-size`，避免盒子塌成 0。不冻 `#app`，因为 `GlobalAudio` 挂在 Provider 里。桌面歌词窗口排除。
3. 播放继续走原生/MPV；进度 rAF、着色器、CSS 动画、blur、NAS 后台间隔仍按原逻辑停。KeepAlive 不拆。

代价：当前页已经解码的封面会占着内存。这是唤醒不闪的必要成本，不是新缓存。

请在现有窗口：最小化 → 再点开，看发现/播客封面是否直接在。不要新开 `tauri:dev`。

普通界面在「不伤播放/控制/界面」前提下，再往下砍会伤体验（卸当前封面、拆树、流式解码、改菜单栏歌词滚动）。最小化这条到这里基本到顶。

## 2026-09-18 播客分类空白：官方链路登录态未灌入

用户反馈：播客是走官方的，但播客分类不显示。

结论：是走官方，不是插件。分类树接口本身能返回 16 个大类；真正的问题是 Tauri sidecar 的官方登录态没有灌进去，而且 `target/debug/sidecar` 复制的是过期 vendor。

根因：
1. `podcastOfficial.hydrateLogin` 只是 named export，default export 里没有；sidecar 启动时 `podcastApi.hydrateLogin` 为 undefined，`podcast-auth.json` 灌不进去
2. `target/debug/sidecar` 把 `projectRoot` 错算成 `src-tauri/target/debug`，重建 runtime 时继续用旧 vendor
3. 播客页分类加载没有像 Electron 那样 `getCategories(true)` 强制刷新

已修：
- vendor `podcastOfficial.js` default export 补上 `hydrateLogin` / `clearLogin`
- musicSdk `projectRoot` 解析改为优先真实仓库 vendor
- `ensureRuntimeDependencies` + runtime bump 到 `2026-09-18-podcast-4`
- `podcast.vue` 进入时强制刷新分类，并清掉空的 session cache
- 验证：`loggedIn=true`（松的森林），分类 16 个，分类页 radios 176

请在现有窗口重新进一次播客页查看分类 chips 和分类封面。不要新开 `tauri:dev`。


## 2026-09-18 发现页/播客页空白紧急修复

用户反馈：发现页和播客页突然没有内容。

根因：
- 上一轮为播客字段 bump 了 musicSdk `runtimeVersion`，并重启了 sidecar
- Tauri 运行时把 musicSdk 写在 app-data：`~/Library/Application Support/com.cerumusic.tauri/sidecar-runtime/musicSdk`
- 这里的 ESM 导入**不会吃 NODE_PATH**，旁边又没有 `node_modules`
- sidecar 一重启后，`axios` / `iconv-lite` 解析失败，`getPlaylistTags` / `podcast.getCategories` 全挂，页面就空了

本轮未改发现页/播客页 UI。修的是 runtime 依赖：
1. 立即补齐 app-data `sidecar-runtime/node_modules`（axios、iconv-lite 等）
2. `sidecar/services/musicSdk/index.mjs`
   - `runtimeVersion` → `2026-09-18-podcast-2`
   - `ensureRuntimeDependencies()`：重建/校验 runtime 时自动把依赖拷到 app-data
   - `getMusicSdk()`：导入失败时重建一次，避免半截 runtime 卡死
3. 同步到 `src-tauri/target/debug/sidecar/services/musicSdk/index.mjs`
4. 验证：`getPlaylistTags` / `getCategoryPlaylists` / `podcast.getCategories` / `podcast.getHomeChannel` 均已恢复

请你：在现有窗口切一下发现页、播客页；sidecar 会在下次请求时自动拉起。不要新开 `tauri:dev`。


## 2026-09-18 播客官方取链二次打通 + 跳歌折中加固

用户反馈：播客点播放仍跳下一首；音乐失败连跳太猛。要求对齐 Electron：播客走官方；音乐保留候选换源，但不能无限跳。

根因（播客）：
- 官方取链本身是通的（`podcast.getPlayUrl` / `getOfficialPlayUrl` 能返回可播 mp3）
- 播放前误用了持久 URL 缓存里的过期 `iot101.music.126.net` 链接（403）
- Tauri 对缓存只做了 `isPlayableUrl` 形态检查，没有像 Electron 那样 `verifyPlayableUrl`
- 过期链接一播就失败，再叠加失败自愈，看起来像“官方没走通 / 一直跳”

本轮修复：
1. `globaPlayList.ts`
   - 预取/SQLite 缓存命中前恢复 `verifyPlayableUrl`（对齐 Electron）
   - 播客不再读、不再写持久 URL 缓存
   - 预取播客时跳过 durable cache，改为现取
2. `playlistManager.ts`
   - 播客强制 `isCache: false`
   - 播客音质固定走官方默认 `exhigh`（不再拿音乐插件音质表乱试）
3. 清理本机已写入的播客/过期 `iot101` URL 缓存条目
4. bump sidecar `runtimeVersion` → `2026-09-18-podcast-1`，重建 `.sidecar-runtime` 里的 `radio.js` 字段

音乐跳歌折中（保持）：
- 普通音乐：保留 `getCandidateSongs` / `tryUrlSequential` 换源
- 自动跳歌：`(count >= limit || count >= 10) && count > 2` 才硬停
- 播客/长节目：失败后不搜音乐候选源、不自动连跳

验证建议（用现有窗口，不要新开 `tauri:dev`）：
1. 播客页点某个电台节目 → 应出声，不再连跳
2. 故意点一首会失败的普通歌 → 先同曲换源/刷新，再有限次跳下一首，不会一路跳到底
3. 若播客仍失败：看控制台是否打到 `podcast.getPlayUrl`，以及返回有无 `url`


## Start Here

This file is the continuation record for the Ceru Music Tauri migration. Read it
first, then inspect only the files relevant to the current task.

AI search entry points:

- Read `AI_INDEX.md` first for tags, aliases, and task routing.
- Read `TOP_GRAPH.md` for the curated architecture and cross-module flows.
- Use `graphify query "<question>"` for node-level code navigation.
- Follow `docs/AI_GRAPH_MAINTENANCE.md` after every code or document change.

Active project:

`/Users/songsong/Movies/ceru-tauri`

Read-only reference project:

`/Volumes/致钛 2T/CeruMusic`

The active Tauri project is outside the Electron project directory. Do not
assume the current workspace root is the project being edited.



## 2026-09-18 Windows 打包流程

用户问 Tauri 版能不能像 Electron 一样在 Windows 上编译后直接用。结论：以前不行，主要卡在 sidecar 依赖系统 Node；这一轮把 Windows 打包补成可自包含。

本轮：
1. `src-tauri/tauri.conf.json`
   - `productName/mainBinaryName`
   - NSIS：中/英、可改安装目录、用户/整机可选
   - WebView2：`embedBootstrapper`
   - resources 显式映射 `sidecar` + `sidecar-runtime`
   - `beforeBuildCommand` 会准备 portable Node
2. `scripts/prepare-sidecar-runtime.mjs`
   - 下载便携 Node（默认 22.14.0）
   - 复制 sidecar 运行时依赖（axios / iconv-lite 及其树）
3. `src-tauri/src/commands/node_sidecar.rs`
   - 优先启动内置 Node，再回退系统 `node`
   - 注入 `CERU_APP_DATA_DIR` + `CERU_TAURI_APP_DATA_DIR` + `NODE_PATH`
   - Windows 下 `CREATE_NO_WINDOW`，避免弹黑框
4. sidecar 路径适配
   - `musicSdk` 打包后把 runtime 写到 app-data，不再写只读 resources
   - plugins 同时认 `CERU_APP_DATA_DIR`
5. 文档 / CI
   - `docs/WINDOWS_PACKAGING.md`
   - `.github/workflows/windows-build.yml`
   - npm scripts：`tauri:build:windows` / `sidecar:prepare-runtime`

验证：
- `npm run sidecar:prepare-runtime -- --platform win32 --arch x64 --force` 成功，产出 `packaging/sidecar-runtime/node.exe`
- `cargo check` 通过
- sidecar `node --check` 通过

说明：真正编出 Windows NSIS 安装包仍需在 Windows 机器或 GitHub `windows-latest` runner 上跑；macOS 上只能准备 runtime，不能直接产出可用 `.exe`。

## 2026-09-18 FullPlay Lighting Covered By Black
- Symptom: Electron-style top-left / bottom-right cover lighting flashed, then a black layer replaced it. Song changes kept the same black screen.
- Cause: WKWebView paints negative-z background behind the window black; PIXI `PixiRenderer` is created with opaque `backgroundAlpha: 1`. After the 320ms enter delay the empty canvas faded in (`bg-render-active`) and covered `.bg-fallback`.
- Fix in `src/components/Play/FullPlay.vue`: keep fallback at z-index 0; only add `bg-render-active` after `setAlbum` actually created sprites and they faded in (`bgAlbumReady`). Make the PIXI canvas transparent; if album fade-in never starts, leave PIXI hidden so the corner lighting stays.
- PIXI params aligned to Electron `setRenderScale(0.5)` / `setFPS(30)`.

## 2026-09-18 Settings Color Picker + Storage Lag
- Desktop lyric color picker was clipped by settings `overflow: hidden`; the panel could not be scrolled. Attach TDesign popup to `body` and cap panel height with overflow-y auto.
- Storage tab froze because `directory_settings_get_directory_size` and `music_cache_get_info` scanned disks on the invoke thread. Page now paints paths first (`计算中...`), sizes load in the background, and Rust size/cache commands run in `spawn_blocking`.

## 2026-09-17 FullPlay Cover Tint
- Symptom: FullPlay tint flickered black/white/gray and lagged behind Electron on song change.
- Electron reference: `GlobalPlayStatus.ts` commits `player.cover` once (blob preferred, else original URL) then `analyzeImageColors` once. No intermediate displayUrl.
- Tauri adapter: keep cover-proxy for WKWebView CORS, but do not paint/extract the proxy URL first. Wait for blob, reuse cached palette by original cover URL, and do not reset to theme gray if a previous tint exists.

## 2026-09-17 FullPlay Enter Smooth + Default Window
- FullPlay open hitch: keep Electron 0.28s / cubic-bezier(0.8,0,0.8,0.43) motion, but slide with `translate3d` in WKWebView instead of layout `top`. PIXI attach waits 320ms so it does not steal the enter frame. Leave still disables pointer events immediately.
- Default window size set to the current user window `1100x670` (was `1200x800`). Min stays Electron `1100x670`; window remains resizable.
- Electron reference: `src/main/index.ts` createWindow `1100x750` default / `1100x670` min; FullPlay slide duration/easing in `FullPlay.vue`.

## 2026-09-17 FullPlay Leave Click Trap
- Symptom: collapsing FullPlay while a song is playing left sidebar/home/dock unclickable; idle open/close was fine. After next-track, opening FullPlay stuck again.
- Electron reference: `src/renderer/src/components/Play/FullPlay.vue` slide uses layout `top` (not transform); `.putawayscreen-btn` at left 90px / z-index 10; no global drag strip. PIXI stays on `bgRef` across hide (`pause/resume`), inner root is `v-if="props.show"`.
- Tauri adapter: WKWebView + PIXI/AMLL canvases can keep hit-testing the old box after a transform leave, and a detached WebGL canvas still intercepts clicks after the FullPlay box is destroyed. Restore Electron `top` slide, disable pointer events on leave (CSS + JS `done()` timeout), raise back-button z-index, ignore the App.vue drag strip while `body.full-play-open`, and re-parent the PIXI canvas into the live `.bg-render` on every open (never `resume()` an orphaned canvas).

## 2026-09-17 Status Bar / FullPlay / Home Grid
- Status bar lyric aligned to Electron `menuBarLyric.ts`: visual width 22, full/half padding, marquee 1200/380, clear lyrics on song change, marquee not gated by playStatus.
- FullPlay tint flicker: cover now commits once (blob preferred); color extract is generation-guarded, cached, and k-means init is deterministic.
- Dock/open FullPlay stutter: PIXI resume delayed (220ms resume / 420ms first init) instead of immediate resume on `shouldRenderFullPlay`.
- Home grids use fixed column counts (find/search 2/3/4/5/6, songlist 2/3/4/5, leaderboard fixed) so resize scales covers instead of reflowing row counts.


## 2026-09-17 Proportional UI Scale Lock
- Window min size raised to Electron-like `1100x670` so the UI floor stays at the 4-cover sweet spot.
- Find/search/songlist grids no longer drop below 4 columns; only expand to 5 when wide.
- Root rem scale uses `clamp(13px, min(1.35vw, 1.7vh), 18px)`; settings pages converted from fixed px to rem so sidebar/labels scale with the window.


## 2026-09-17 Menu Bar GUID Verified

- Status-bar lyric is visible and scrolling with switch ON (Accessibility reads live lyric text).
- Electron GUID `f4f8a5d8-9eb2-4f98-8fd7-3a3d5ec9b2cf` is now used as:
  - Tauri tray id on macOS
  - `NSStatusItem.setAutosaveName(GUID)`
- Migrated legacy `NSStatusItem Preferred Position Item-0` -> GUID key in `ceru-tauri` defaults (both = 318).
- Cleared forced 1x1 tray icon after create so the item is title-led like Electron empty image.
- Do not manually destroy the macOS tray on quit; let AppKit flush autosave position.

Note: Electron stores position under bundle `com.cerumusic.app::GUID`. Tauri/dev stores under process/`ceru-tauri` + GUID. Same sticky-ID behavior, separate app domains.

## 2026-09-17 Menu Bar Lyric GUID Parity

User reported status-bar lyric still missing / position not sticky. Electron keeps the item with a fixed GUID:

- Electron: `src/main/index.ts` `MAC_TRAY_GUID = f4f8a5d8-9eb2-4f98-8fd7-3a3d5ec9b2cf` via `new Tray(emptyImage, GUID)`
- Also avoids `tray.destroy()` on quit so AppKit can flush position to defaults

Tauri adapter:

- Same GUID constant in `src-tauri/src/lib.rs`
- After tray build, `with_inner_tray_icon` -> `NSStatusItem.setAutosaveName(GUID)`
- Clear the forced 1x1 tray icon (`set_icon(None)`) so the status item is title-led like Electron empty image
- Verified live: menu-bar title scrolls lyrics with switch ON

## 2026-09-17 Status Bar Lyric + Scale Finish

User said the previous turn ended abruptly. Continued and finished:

1. **Status-bar lyric verified live**
   - DB `mac_status_bar_lyric=true`
   - Accessibility menu-bar title shows live song / scrolling lyric (e.g. `背叛 - 曹格`)
   - Electron refs: `src/main/services/menuBarLyric.ts`, `src/main/events/lyric.ts`
   - Tauri: empty 1x1 tray icon + title marquee in `src-tauri/src/lib.rs`; frontend bridge in `src/utils/lyrics/desktopLyricBridge.ts`
   - Extra: seed `source_text` from persisted last song during tray init so title paints before renderer mounts

2. **Home proportional scale root cause**
   - TDesign `.t-layout__sider { width: 232px }` was overriding rem sidebar
   - Fixed with `t-aside width="15rem"` + CSS lock in `HomeLayout.vue`
   - Settings sidebar rem-locked similarly
   - Root rem floor raised to Electron-like `clamp(15px, min(1.4vw, 1.75vh), 18px)`

3. **Dock progress/volume color parity**
   - Restored Electron coverDetail tint in `PlayMusic.vue` (was incorrectly forced to brand tokens)

4. **FullPlay / Dock stutter**
   - PIXI wake delayed further: resume 320ms / first init 520ms
   - Render scale 0.32 / 20fps while slide finishes

5. **Memory**
   - Existing LRU caps kept (cover 96, validation 80, cover-proxy 128, download tasks 200)
   - Current debug process ~140MB RSS after restart; no new unbounded caches added

Still user-check:
- Resize window: sidebar + tags + 4-cover floor should shrink together
- Open FullPlay / restore from Dock: slide should feel smoother
- Progress/volume bar should follow cover tint like Electron

## 2026-09-17 Selection + Dock Colors
- Hardened WKWebView drag-selection: global CSS `user-select:none` + transparent `::selection`, HomeLayout lock, and `selectstart` capture guard (inputs/contenteditable/text areas still allowed).
- Bottom progress/volume colors fixed to theme brand tokens (`--td-brand-color-5/3`) instead of cover-extracted tint; FullPlay background tint still follows cover.

## Non-Negotiable Constraints

- **默认必须使用中文回答用户**，包括过程说明、最终总结、状态汇报、追问和错误说明。
  只有用户在当前请求中明确要求其他语言时才切换；代码、日志、命令、文件名和第三方
  API 名称可以保留英文，但解释和结论必须使用中文。
- Never modify the completed Electron project at `/Volumes/致钛 2T/CeruMusic`.
  It is the behavior and visual reference and must remain intact.
- Continue development only in `/Users/songsong/Movies/ceru-tauri`.
- **Electron parity is mandatory for every product change.** Before changing
  behavior, data flow, playback, caching, artwork, desktop lyrics, animations,
  layout, IPC, plugin selection, or UI styling, locate and read the equivalent
  implementation in `/Volumes/致钛 2T/CeruMusic`. Port the Electron behavior,
  ordering, thresholds, fallbacks, permissions, and visual values. A Tauri
  change may only adapt the shell/platform boundary (for example Tauri IPC,
  Rust window APIs, or WebView-specific APIs); it must not replace the Electron
  product logic with an unrelated local workaround.
- For every fix, record the Electron reference file/symbol in the commit or
  handoff entry, then state what Tauri-only adapter was required. If the
  Electron code cannot be reused directly, explain the concrete platform
  limitation before choosing an alternative. Do not guess from screenshots or
  invent a new flow when the Electron implementation exists.
- This rule applies to the complete playback chain (search, current-source
  selection, plugin ordering, URL resolution, fallback, next track, podcast,
  download), all loading/cache behavior, all artwork fallback, desktop lyric
  window lifecycle/geometry/dragging/locking, full-screen player motion and
  record/stylus geometry, visualizers, Dock layout, and every settings page.
- Do not implement a Tauri-only workaround merely because it appears to fix
  the symptom. If Electron has product logic for the behavior, that logic is
  the source of truth. Tauri/Rust/WebView code may replace only the platform
  boundary that Electron previously supplied through Node/Electron APIs.
- Every AI must perform the following migration check before editing, and must
  report the evidence in the handoff/commit. Omitting any step means the change
  is not ready to ship:
  1. Identify the Electron reference file, symbol, and line range.
  2. Read the complete Electron call order, not just the final helper. Record
     arguments, selected source/plugin, cache checks, timeout values, retries,
     fallback order, error handling, and UI-visible state changes.
  3. Compare the Tauri call chain from renderer/store through IPC/sidecar and
     list every semantic difference.
  4. Port the Electron behavior first. Add a Tauri adapter only at the
     Tauri/Rust/WebView boundary, and document the concrete platform reason.
  5. Add focused verification for the migrated path and test the same user
     actions in the existing `npm run tauri dev` instance.
  6. Record the Electron file/symbol, Tauri adapter files, tests, and remaining
     uncertainty in this handoff before moving to another area.
- A UI resemblance is not parity. Measurements, timings, cache lifetime,
  fallback rules, source identity, event ordering, and user-visible state must
  match Electron unless a documented platform limitation requires otherwise.
- Use only the existing `npm run tauri dev` instance for manual testing.
  Never use Computer Use's app-name lookup for `ceru-tauri`; it resolves to
  `/Applications/澜音.app`, launches duplicate Electron release instances, and
  shows the wrong UI. Do not launch or focus a second app window.
- Preserve playback, UI effects, full-screen player animations/spectrum,
  equalizer, desktop lyrics, NAS/LAN, plugins, podcast/radio, listening
  recognition, downloads, playlist sync, and source switching.
- Do not "optimize" by disabling user-visible features unless the user has
  explicitly approved removing that feature.
- Prefer exact permission and login prompts. Do not show unrelated system
  permission, login, Paste, context-menu, or right-click UI.
- Podcast and radio use NetEase official APIs. NetEase podcast login must not
  block or alter ordinary plugin-based song playback.
- Front-end bugs should normally be tested with `npm run tauri dev` and hot
  reload. Do not run a full Tauri release build after every small UI fix.
  Full builds are for Rust, sidecar, packaging, or final delivery changes.

## Current Architecture

- Frontend: Vue 3, TypeScript, Vite, Pinia.
- Desktop shell: Tauri 2.
- Background compatibility layer: Node sidecar containing the migrated
  Electron/Node music SDK and plugin support.
- Renderer calls the sidecar through Rust commands. Network-heavy sidecar
  calls must not run synchronously on the Tauri/WebKit main thread.
- Tauri command entry:
  `src-tauri/src/commands/node_sidecar.rs`
- Tauri command registration:
  `src-tauri/src/lib.rs`

## Important Fixes Already Applied

### Sidecar IPC and UI freezing

The main cause of long freezes in podcast, quality selection, source switching,
and plugin menus was synchronous `node_sidecar_request` execution. It blocked
the Tauri/WebKit main thread while waiting for NetEase or plugin network calls.

The sidecar request path now runs through `spawn_blocking`, and the sidecar wait
uses `recv_timeout` on a Tokio background thread.

Files:

- `src-tauri/src/commands/node_sidecar.rs`
- `src-tauri/src/lib.rs`

### Electron-parity network concurrency

The sidecar request path originally serialized every network operation behind a
single promise chain. It now dispatches requests immediately by default, matching
Electron's concurrent main-process behavior. An optional
`CERU_SIDECAR_CONCURRENCY` limit remains for diagnostics, but normal operation
does not queue requests behind playlist covers or other metadata calls.

Rust already supports out-of-order sidecar responses, so this is safe at the IPC
layer.

Files:

- `sidecar/index.mjs`
- `src-tauri/src/commands/node_sidecar.rs`

### Podcast and radio first-screen loading

The previous Tauri-only workarounds delayed podcast blocks for about 900 ms and
category totals for about 12 seconds. Those delays have been removed so the
first-screen flow matches Electron:

- Refresh login first.
- Load categories and the first category page.
- Load shelf, blocks, and favorites concurrently.
- Probe the category total immediately instead of waiting 12 seconds.
- NetEase QR polling uses a mutex and polls every about 2500 ms, preventing
  overlapping requests.
- The QR window closes only after the login state is confirmed and saved.

Files:

- `src/views/music/podcast.vue`
- `sidecar/services/musicSdk/index.mjs`

### Playback URL resolution

The normal playback path previously scanned multiple plugins, raced a built-in
source, and verified candidates before returning a URL. Tauri now follows the
Electron happy path:

1. Query the configured/selected plugin once.
2. Return its usable URL immediately.
3. Only after a real failure, try the built-in provider and other plugins.

Plugin candidate de-duplication also no longer collapses same-name plugins with
different IDs, so a broken duplicate cannot hide a working one during fallback.

`music.request` / `requestSdk` `getMusicUrl` now wrap Feiniu and other header-
authenticated results through the local media stream proxy. This is the Tauri
adapter for Electron `createServiceStreamUrl()` (`cerumusic-service://`). The
WebView `<audio>` element cannot send plugin `Cookie`/`Accept` headers, so a
bare Feiniu URL is judged unplayable (401 JSON) and falls into cross-source
retry. Persistent URL cache must not store `127.0.0.1/stream` or
`_servicePluginId` songs.

Prev/next already pass `{ immediate: true }`. Renderer cache hits use
`isPlayableUrl` only (zero network). Do not reintroduce `verifyPlayableUrl` on
that path just because Electron still calls it while its comments say
“hit means zero network”.

Files:

- `src/tauri-bridge.ts` (`wrapPlaybackStreamIfNeeded`)
- `src/utils/audio/globaPlayList.ts`
- `src-tauri/src/commands/media_stream_proxy.rs`
- `sidecar/services/download/index.mjs` (`urlCacheGet` suffix fallback)
- `scripts/playback-url-benchmark.mjs`

Verified with the running sidecar entry:

- Two concurrent `musicUrl` plugin requests returned usable HTTP URLs in about
  2.7 seconds total, rather than running serially.
- Podcast categories, home data, and Discover tags completed concurrently in
  about 0.25-0.35 seconds in the protocol-level check.

### Podcast login persistence

The NetEase podcast login state is persisted under:

`~/Library/Application Support/com.cerumusic.tauri/podcast-auth.json`

Rust injects `CERU_APP_DATA_DIR` so the sidecar can find the application data
directory.

Relevant implementation:

- `sidecar/services/musicSdk/index.mjs`

### Podcast and radio artwork

Podcast and radio detail artwork uses `s-image`, including HTTPS promotion,
no-Referer retry, lazy loading, and failure fallback.

Relevant views:

- `src/views/music/podcast.vue`
- `src/views/music/radio.vue`

### Appearance and window polish

- The normal bottom Dock is now opaque solid color instead of frosted glass.
- The full-screen player retains its original dynamic/translucent effects.
- Application window corners were increased from 12 px to 22 px.
- Dock and upper application surfaces share a unified background and rounded
  bottom corners.
- The "More" menu no longer uses its previous opening animation.

Files:

- `src/components/Play/PlayMusic.vue`
- `src/App.vue`
- `src/assets/main.css`

### Source switching

Source replacement search was changed from a very large cross-product of
keywords and providers to bounded lightweight search:

- Five music sources.
- Four-second timeout.

Relevant file:

- `src/utils/audio/audioHelpers.ts`

### Current playback source synchronization

Tauri's `globaPlayList.ts` keeps its own playback `songInfo`, while
`PlayMusic.vue` and the download UI read
`GlobalPlayStatus.player.songInfo`. Before this fix, automatic fallback could
leave the canonical store on `wyy` even after playback had successfully moved
to `mg`, so the download dialog reported the wrong current source and found no
downloadable qualities.

`applyCurrentSongInfo()` now normalizes the successful playback song once,
updates the canonical `GlobalPlayStatus` store immediately, and then records
`lastPlaySongId` / `lastPlaySongSource`. This covers manual source changes and
all automatic URL fallback paths. `download.ts` also resolves the playing
source when the requested download song matches the canonical playback song.

Relevant files:

- `src/utils/audio/globaPlayList.ts`
- `src/utils/audio/download.ts`
- `src/store/GlobalPlayStatus.ts`

## Latest Session Fixes

PLAYBACK-01 (2026-09-17): prev/next switch latency was dominated by Feiniu bare
URL 401 plus same-source `musicUrl` (1.5-2.5s) and cross-source search+URL
(~1s). Cache-hit syntax check is 0ms; HTTP probe of a still-TTL NetEase URL
was 47ms/403. Dev timings write `ceru_playback_timings_v1`. Manual UI timing is
still pending because no live `npm run tauri dev` instance is available.

The second playback/source/desktop-lyric pass was applied on 2026-09-16:

- Playback URL results are now normalized from either strings or objects such
  as `{ url, headers, urlInfo }`. This closes the case where a valid plugin URL
  was rejected by `getSongRealUrl` because the bridge returned an object.
- Source-candidate search now returns partial ranked results progressively,
  caches successful candidate sets for three minutes, and limits the dialog
  search timeout to 2.2 seconds. Fast providers appear without waiting for the
  slowest provider.
- Discover tag/category requests now use request IDs and source-aware cache keys.
  Stale responses cannot overwrite a newer source switch, and tags/playlists
  load in parallel.
- Podcast category requests now reject stale responses. Shelf and home-block
  results are session-cached, and login-state refresh no longer blocks the
  first category load.
- Network playlist first pages and loaded pages are session-cached for five
  minutes, with request sequencing to prevent duplicate or stale pagination.
- Desktop lyric geometry now uses logical pixels throughout the Tauri commands,
  matching Electron `getBounds`/`setBounds`. The previous physical-pixel use
  caused Retina scaling, drag/resize drift, and size snap-back.
- Desktop lyric option updates no longer overwrite a fresh resized height with
  an approximate font-derived height. The window remains transparent on its
  dedicated route and is revealed after render readiness.

Files touched in this pass:

- `src/utils/audio/playableUrl.ts`
- `src/utils/audio/audioHelpers.ts`
- `src/utils/audio/qualityAvailability.ts`
- `src/utils/playlist/playlistManager.ts`
- `src/views/music/find.vue`
- `src/views/music/podcast.vue`
- `src/views/music/list.vue`
- `src/views/DeskTopLyric/DeskTopLyric.vue`
- `src-tauri/src/commands/lyric_window.rs`

## Last Verification State

### Playback startup parity (2026-09-17)

The normal playback chain is already ordered like Electron, but Tauri was
missing Electron's plugin-system startup initialization. Electron initializes
the plugin hosts before creating the window and exposes
`service-plugin-initialize-system` for the welcome page. Tauri had neither an
equivalent startup call nor a mapping for that channel, so the first playback
paid the plugin worker cold-start cost.

Electron reference:

- `src/main/index.ts:1035-1043`: `pluginService.initializePlugins()` before
  `createWindow()`.
- `src/main/events/plugins.ts:371`: `service-plugin-initialize-system` waits
  for the same initialization.
- `src/main/services/plugin/index.ts:310`: each plugin host loads its worker.

Tauri adapter and files:

- `src/main.ts`: starts `window.api.plugins.initializeSystem()` immediately
  after the Tauri bridge is created.
- `src/tauri-bridge.ts`: maps the legacy
  `service-plugin-initialize-system` channel and exposes the equivalent
  `plugins.initializeSystem()` method.
- `sidecar/services/plugins/index.mjs`: initialization now preloads eligible
  plugin workers, deduplicates concurrent initialization, and provides a
  direct `getPluginCode()` reader.
- `sidecar/index.mjs`: registers `plugin.getPluginCode`.

Protocol-level verification:

- First `plugin.initializeSystem`: about 298 ms on the existing profile.
- Second call: about 1 ms, confirming the initialization promise is reused.
- `plugin.getPluginCode` for `0bbb...`: about 1 ms, 28,345 characters.
- `npm run build` and both sidecar `node --check` commands passed.

The remaining latency is plugin/network bound. A real click-to-audio timing
run in the existing `npm run tauri dev` instance is still required; no dev
instance was running during this pass, so no duplicate app was launched.


The following checks passed after the latest changes:

```bash
cd /Users/songsong/Movies/ceru-tauri
npm run build
node --check sidecar/index.mjs
node --check sidecar/services/musicSdk/index.mjs
cd src-tauri && rustfmt --check src/commands/lyric_window.rs
cd src-tauri && cargo check
```

No new release package was produced in this pass. The previously packaged
application remains:

`/Users/songsong/Movies/ceru-tauri/src-tauri/target/release/bundle/macos/ceru-tauri.app`

The latest source synchronization change was hot-reloaded into the existing
dev instance. The active test process tree was:

```text
80597 npm run tauri dev
80649 node .../tauri dev
98542 target/debug/ceru-tauri
98771 node .../target/debug/_up_/sidecar/index.mjs
```

An unwanted `/Applications/澜音.app` Electron process tree was observed and
closed. Do not recreate it during testing.

Last measured idle memory before the latest manual retest:

- Main Tauri process: about 105 MB, 0.2% CPU.
- Node sidecar: about 75 MB, 0.3% CPU.

These numbers are observations, not a guarantee. Re-measure from the currently
running build before making performance claims.

## User-Reported Items Still Requiring Manual Validation

The latest asynchronous IPC build was successfully produced, but the following
were not yet fully confirmed by real interaction at the point this handoff was
written:

1. "Discover -> Podcast" should switch immediately without freezing. Content
   and artwork may appear progressively as network calls finish.
2. Bottom Dock "More -> Share / Listen Together / Audio Quality / Change
   Source" and every submenu should remain responsive.
3. NetEase podcast QR login should finish authorization without an indefinite
   hang, persist `podcast-auth.json`, enter the content screen automatically,
   and render covers.
4. Compare the normal Tauri Dock with the Electron version and remove any
   remaining visual separation if it is still noticeable.
5. If podcast categories still wait too long for the official API, persist a
   category cache and return cached or fallback categories immediately while
   refreshing in the background.

## Known Areas to Inspect Next

- If dropdown submenus are still slow after the async IPC fix, inspect Naive UI
  `n-dropdown` behavior. A lightweight custom menu may be needed only if
  measurements prove Naive UI is the remaining cause.
- Verify that no login prompt is shown for ordinary playback or local content.
- Verify that no Paste menu or unwanted context menu appears in Discover.
- Verify that the Discover page's right side does not remain visually blocked
  while data loads.
- Verify window dragging across the whole intended drag region.
- Verify the corners match the Electron visual reference.
- Verify desktop lyrics and multi-device sync login fields were actually
  migrated; these were previously reported as missing.
- Verify the Feiniu/NAS plugin login and specifically the previous error:
  `cerumusic.utils.crypto.sha256 is not a function`.
- Verify source selection and playback end-to-end after a source is applied.
- Check whether ordinary song-list and cover requests have network access and
  whether failures are caused by network access, provider auth, or a renderer
  bridge mismatch.
- Review any repeated sidecar add-song logs. The Electron diagnostics previously
  showed `成功添加 X 首歌曲` more than 1700 times; do not assume this is benign.
  Investigate whether a synchronization flow is repeatedly adding the same
  batch, because this can grow CPU, memory, and database size.
- The user asked that the AI feature be removed because it is currently unused.
  Confirm the exact AI UI/feature scope before deleting shared code.
- NSFW image detection lazily loads TensorFlow and an image model for uploaded
  avatar/cover checks. Identify whether the user considers this feature worth
  keeping.
- Listen Together starts Socket.IO, room state, chat, and popup logic. The user
  wants its baseline connection cost measured before deciding whether to remove
  it.

## Performance Optimization Context

Earlier analysis found that safe optimization alone will not reduce total
Electron/Tauri memory to the desired low level. The major remaining structural
options are:

- Unify UI libraries: the project currently includes both TDesign and Naive UI.
  Replacing the smaller Naive UI usage with TDesign may save renderer memory
  and bundle size, but must be checked visually and behaviorally.
- Lazy-initialize AudioContext while preserving playback behavior.
- Avoid loading TensorFlow/NSFW models unless an upload actually needs checking.
- Defer or remove unused optional feature subsystems only with user approval.
- A Tauri shell already replaces Electron, but the Node compatibility sidecar
  still has its own memory cost. Do not estimate savings from the shell change
  alone; measure the full process tree.

## New-Thread Prompt

Use this in the new thread:

```text
项目目录是 /Users/songsong/Movies/ceru-tauri。先完整阅读
/Users/songsong/Movies/ceru-tauri/CONTEXT_HANDOFF.md，再继续处理 Ceru Music
Tauri 版。Electron 完整版只在 /Volumes/致钛 2T/CeruMusic 只读参考，绝对不要修改。
任何功能、播放链路、缓存、封面、桌面歌词、动画和布局改动，都必须先找到
Electron 对应文件/符号，逐项对照调用顺序、参数、超时、缓存和回退逻辑后再移植。
不能凭感觉另造流程；Tauri/Rust/WebView 只适配平台边界，并要在 handoff 中记录
Electron 引用和 Tauri 适配点。
普通前端问题先用 npm run tauri dev 热更新验证，不要每次完整编译。
```

## 2026-09-17 飞牛登录与封面

本轮只做了第二块：`FEINIU-02` 和 `COVER-01`。第一块 `PLAYLIST-01` / `FEINIU-01` 没有改 `createSongListFromService`。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/main/events/plugins.ts`：`testConnection` 后自动导入，启动时刷新 token，`autoImportVersion === 2` 时跳过重复迁移。
- `/Volumes/致钛 2T/CeruMusic/src/main/index.ts`：飞牛封面只给同源 `/music/api/v1/` 注入 `Cookie: music-token`。

Tauri 改动：

- `src/tauri-bridge.ts`：保存飞牛 `token`/`deviceId`，启动同步，封面鉴权头。
- `src/main.ts`：插件预热后后台同步飞牛，不阻塞首屏。
- `src-tauri/src/commands/plugin.rs`：图片代理支持自定义请求头。
- `src/components/sImage.vue`：只有飞牛保护 URL 才转 data URL。

还没手工验收：

- 配置文件是否写出 `token`、`deviceId`、`autoImportVersion`。
- 飞牛歌单封面、卡片封面、播放器封面是否可见。
- Rust 命令签名变了，现有 `npm run tauri dev` 需要重编译后封面鉴权才生效。不要新开第二个 dev。

这些后续任务已在 2026-09-17 剩余任务收口中完成或给出只读报告。

## 2026-09-17 我的喜欢为空

根因不是歌单没歌。库里 `favorites_playlist_id` 指向「我的喜欢」，有 1422 首。
Rust `Songs.album_id` 之前是 `Option<i64>`，真实 JSON 的 `albumId` 全是字符串，解析失败后 `list_songs` 把歌丢掉，页面就是空的。
飞牛歌单 699 首也是同一个原因。

修法：`src-tauri/src/models.rs` 改成 `Option<serde_json::Value>`，对齐 Electron `albumId: string | number`。
单元测试 `parses_string_album_id` 通过。没有删库，没有重建「我的喜欢」。

飞牛配置文件里仍然没有 `token`/`deviceId`。当前没有跑着的 `tauri dev`，要看封面和启动同步，需要让现有那个窗口把 Rust 重编译。不要新开第二个。

## 2026-09-17 飞牛封面滚动重拉与底栏缺图

用户反馈：飞牛歌单能播了，但虚拟列表滚动到某行要等一会才出封面，滚回去又消失再等；底栏 Dock 更是没有封面。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/main/index.ts`：`session.webRequest.onBeforeSendHeaders` 只给同源 `/music/api/v1/` 注入 `Cookie: music-token`。列表和底栏都直接 `<img src="原始 URL">`，走 Chromium HTTP 缓存。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/sImage.vue`：不转 data URL。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/Play/PlayMusic.vue`：底栏用 `player.cover`。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/store/GlobalPlayStatus.ts`：`getBlobUrlFromUrl` 直接 `fetch(url)`，依赖 session 层带 Cookie。

之前 Tauri 适配不对齐：每张飞牛封面都 `image_url_to_data_url`。虚拟列表 `release-on-hide` 卸载后缓存丢了；底栏不走 `sImage`，直接 fetch 原始 URL，WebView 带不上登录态。

本轮改动：

- `src-tauri/src/commands/cover_proxy.rs`：稳定本地代理 `http://127.0.0.1:<port>/cover/<url-safe-base64>`，从 `plugins/config/*.json` 读 token，只给同源飞牛 URL 加 Cookie。
- `src/tauri-bridge.ts`：`images.proxyUrl`，同一张原始 URL 返回同一个代理地址。
- `src/components/sImage.vue`：飞牛图改走代理 URL，不再转 data URL。
- `src/store/GlobalPlayStatus.ts`、`src/components/Play/PlayMusic.vue`：底栏和任务栏封面也走同一个代理。
- `src/main.ts`：全局图片出错重试不要把 `127.0.0.1` 改成 https。

已确认配置文件已写出 `token`/`deviceId`/`autoImportVersion=2`。「我的喜欢」1422 首、飞牛全部歌曲 699 首都在库里。

后续进展：

- 现有 `npm run tauri dev` 已重编译封面代理。不要新开第二个。
- `PLUGIN-01` / `PODCAST-01` 已完成；`SYNC-01` 只读报告已完成，两条同名“经典老歌”等用户确认再合并。


## 2026-09-17 封面滚动空白与底栏缺图

用户反馈：飞牛已经能播，但虚拟列表滑到某行要等一会儿才出封面，滑回去又空白再等；底栏 Dock 也没有封面，即使列表里同一首歌已经有图。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/sImage.vue`：可视时直接赋原始 URL，`release-on-hide` 卸图后靠 Chromium HTTP 缓存立刻恢复。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/store/GlobalPlayStatus.ts`：`getBlobUrlFromUrl` 直接 fetch 原始 URL，session Cookie 让缓存命中几乎零等待。
- `/Volumes/致钛 2T/CeruMusic/src/renderer/src/components/Play/PlayMusic.vue`：底栏用 `player.cover`。

上一轮 COVER-01 已经有本地代理，但还不够：

- 代理没有内存缓存，滚回同一张图还要再打飞牛。
- `sImage` 每次都 `isLoaded=false` 再 `await proxyUrl`，虚拟列表空白一段。
- 底栏先 revoke 旧 blob，再等 fetch；fetch 没完成时 `player.cover` 指向已失效 blob，Dock 就是空的。
- WKWebView 对 `127.0.0.1` 的 HTTP 缓存不可靠。

本轮改动（COVER-02）：

- `src-tauri/src/commands/cover_proxy.rs`：内存 LRU（256 张 / 32MB），命中立刻返回；补 `ETag`、真实 `Content-Length`、CORS；启动时 `ensure_cover_proxy`。
- `src/tauri-bridge.ts`：`cover_proxy_base` + `images.proxyUrlSync`，同一张原始 URL 同步算出同一个代理地址。
- `src/components/sImage.vue`：滚回时先同步填代理 URL，同一张图不再先清空再等 invoke。
- `src/store/GlobalPlayStatus.ts`：底栏先显示代理 URL，blob 只给颜色提取，旧 blob 等新图出来再释放。
- `src/components/Play/PlayMusic.vue`：任务栏封面也走同步代理地址。

证据：

- `cargo test --lib commands::cover_proxy`：4 个测试通过（token 往返、端口、缓存、ETag）。
- 现有 `npm run tauri dev` 需要把 Rust 重编译后，封面代理缓存才生效。不要新开第二个。

未做：

- 没有在现有窗口里手工滚动飞牛歌单确认封面立刻出来。
- 没有点底栏确认 Dock 封面。
- PLUGIN-01 sidecar 仍需现有窗口吃到新 JS。
- 两条同名「经典老歌」仍未合并。
- VERIFY-01 的滚动/底栏封面这一项要等用户看过再算过。

## 2026-09-17 剩余任务收口

本轮把任务板上未完成的代码缺口补完，并做了 VERIFY-01 证据记录。没有新开第二个 `tauri dev`，也没有改 Electron。

Electron 对照：

- `ManageSongList.findValidCoverFromSongs`：新歌没有封面时，回退到已有歌曲。
- `plugins.ts importServicePlaylistToLocal`：按 pluginId + remotePlaylistId 更新。
- `coverResolver.ts`：播放封面是独立通道，内存 Map，不绑播放源，不落磁盘。
- Electron 飞牛封面靠 session Cookie；Tauri 没有这层，所以 COVER-01 用本地 `cover_proxy_url`。

Tauri 改动：

- `src-tauri/src/commands/songlist.rs`：空封面先看新歌，再 `list_songs`。
- `sidecar/services/plugins/index.mjs`：`configSchema` 改成括号配对，NAS 嵌套 options 不再截成空数组。
- `src/tauri-bridge.ts`：`loadAllPlugins` 合并沙箱 `serviceRole`/`configSchema`；`pairCode` 类型收紧。

证据：

- `ceru-tauri` 唯一开发进程 PID 37156，Vite `http://127.0.0.1:1421/` 200。
- SQLite：我的喜欢 1422，飞牛全部歌曲 699 且只有 1 条。
- 飞牛封面无 Cookie 401，带 Cookie JPEG 200。
- `cargo check`、`parses_string_album_id`、sidecar `node --check` 通过。

还没做 / 等用户：

- 两条同名“经典老歌大放送”不删不合并。
- 不新增磁盘封面缓存。
- UI 点选切歌、再导入飞牛、播客收藏刷新仍建议肉眼确认。

## 2026-09-17 插件能力接口补齐

用户说封面看完了，继续把没做完的做完。对照后：`pluginSync.ts`、`nasSync.ts`、播客收藏 API 已和 Electron 一致；真正缺口在 sidecar。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/index.ts`：`getServiceRole()`、`getConfigSchema()`、`reloadAllPlugins()`。
- `/Volumes/致钛 2T/CeruMusic/src/preload/index.ts`：`service-plugin-getServiceRole`。
- 设置页 `plugins.vue` 在 `pluginType === 'service'` 且没有 `serviceRole` 时会再调 `getServiceRole`。

Tauri 改动：

- `sidecar/services/plugins/index.mjs`：补 `getServiceRole`、`reloadAll`；缓存为空时回读源码抽 schema；同一 pluginId 的重复文件按更长 schema 合并。
- `sidecar/index.mjs`：注册 `plugin.getServiceRole`、`plugin.reloadAll`。
- `src/tauri-bridge.ts`：刷新插件列表先清 sidecar 缓存，再走完整 `loadAllPlugins()`。

证据：

- `getServiceRole(飞牛)=feiniu`，`getServiceRole(NAS)=nas-sync`。
- NAS schema：`enabled/syncMode/host/port/useHttps/pairCode`。
- 飞牛 schema：`host/port/username/password/useHttps/accessCode`。
- 注册表已写回 6 项 schema。当前仍只有一个 `127.0.0.1:1421`。

未改：`PODCAST-01` 收藏逻辑与 Electron 相同，首页同样不监听 `ceru-podcast-favorites-updated`（电台详情页才听）。`SYNC-01` 只读结论保留，两条同名「经典老歌」不删。`VERIFY-01` 仍要你在现有窗口点设置页、播客收藏。

## 2026-09-17 播放失败、歌单顺序、独立封面

用户反馈：同样的源 Electron/落雪能播，Tauri 切歌大量失败；「我的喜欢」顺序和封面也对不齐。

Electron 对照：

- `service.ts getMusicUrl`：插件返回原始 URL，Chromium 可播 `http://`。
- `coverResolver.ts`：播放封面独立通道，内存 Map，不绑播放源，不落磁盘。
- `nasSync.ts`：播客收藏带 position/pin。
- Electron `pullFavoritesFromCloud` 只做增删，不做 reorder；Tauri 要补齐顺序，因为 WKWebView/SQLite 这边之前把喜欢列表排乱了。

Tauri 适配：

- `wrapPlaybackStreamIfNeeded` 对明文 HTTP 音频走 `media_stream_proxy`。
- 切歌缓存命中也先 `ensureWebViewPlayableUrl`，避免过期 `http://fsandroid...` 直接塞给 `<audio>`。
- 封面代理覆盖飞牛鉴权图和明文 HTTP CDN；列表加载失败再走 `coverResolver` 搜其他源。
- `applyRemotePlaylistSongs` 按远程 `pos`/`position` 排序后 `reorderSongs`。
- `tauri.conf.json bundle.macOS.infoPlist` 指向 `Info.plist`。
- 顺手修了 `lyric_window.rs` 的 borrow 编译错误，否则封面代理编不进当前窗口。

证据：现有 `npm run tauri dev` 重编译后进程 `target/debug/ceru-tauri` PID 72136。不要新开第二个。

还没做 / 等用户：

- 重新进入「我的喜欢」看顺序和封面。
- 点一首酷我/酷狗歌确认能播。
- 两条同名「经典老歌大放送」不删。
- 插件公益卡/登录错误仍要看当前选中的音源插件。

## 2026-09-17 桌面歌词窗口和洛雪完整兼容

本轮只做两件事：桌面歌词立刻显示，洛雪插件按 Electron 完整兼容。封面没再改。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/main/events/lyric.ts`：`change-desktop-lyric` 后立刻 `lyricWin.show()`。
- `/Volumes/致钛 2T/CeruMusic/src/main/windows/lyric-window.ts`：开发环境 `devUrl/#/desktop-lyric`，生产 `loadFile(index.html, { hash: 'desktop-lyric' })`。
- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/index.ts`：`type=lx` 只要 `toLowerCase().includes('lx')` 就过，然后一定 `convertEventDrivenPlugin`。

Tauri 改动：

- `src-tauri/src/commands/lyric_window.rs`：开发用 Vite 外链带 hash；生产用 initialization_script 写回 `#/desktop-lyric`；创建后立刻 `show()`，macOS 再主线程补一次。
- `src/tauri-bridge.ts`：洛雪校验对齐 Electron，不再要求 `lx.on(`。
- `sidecar/services/plugins/index.mjs`：同样改成 `includes('lx')`。
- `src/utils/plugin/converter-event-driven.ts`：转换结果带 `由 CeruMusic 插件转换器转换` 标记。
- `src/components/Settings/plugins.vue`：空 `pluginInfo` 兜底，设置页不会整页挂掉。

证据：

- `lx-玉宁熙-Pro` 源码没有 `lx.on(`，但含 `lx`，转换后带 pluginInfo `lx-玉宁熙-Pro` 和 Electron 同款标记。
- `野草` 源码里连 `lx` 字符串都没有，Electron 当洛雪导入也会失败；设置页仍能显示已在注册表里的记录。
- `cargo check` 通过；sidecar `node --check` 通过。
- 没有新开第二个 `npm run tauri dev`。现有 Vite 仍是 `http://127.0.0.1:1421/`。

还没做 / 等用户：

- 两条同名「经典老歌」仍不删。
- 切歌慢不在这一轮。
- PLUGIN-01 设置页飞牛/NAS 6 项表单仍要你点开看一眼。播客收藏只对照，不改数据结构。

## 2026-09-17 sidecar 落盘转换和歌词置顶

上一轮只在前端转换洛雪插件，sidecar 落盘仍是原文件，worker 一跑就报 `LX Music 环境未就绪`。这一轮把 Electron 转换器搬进 sidecar，安装和启动都会转并写回磁盘。歌词窗口补上 Electron 的 `screen-saver` 置顶。

Electron 对照：

- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/index.ts`：`type=lx` 先 `includes('lx')`，再一定 `convertEventDrivenPlugin`，转换后才落盘。
- `/Volumes/致钛 2T/CeruMusic/src/main/services/plugin/manager/converter-event-driven.ts`：注入 `globalThis.lx`，导出 `pluginInfo/sources/musicUrl`。
- `/Volumes/致钛 2T/CeruMusic/src/main/events/lyric.ts`：`setAlwaysOnTop(true, 'screen-saver')`。

Tauri 改动：

- `sidecar/services/plugins/converter-event-driven.mjs`：Electron 转换器的 sidecar 版。
- `sidecar/services/plugins/index.mjs`：`installFromCode` 和 worker 启动都走 `preparePluginCode`，转换后写回磁盘。
- `src/utils/plugin/converter-event-driven.ts`：前端转换器和 sidecar 对齐。
- `src-tauri/src/commands/lyric_window.rs`：macOS `setLevel(1000)`，窗口 `visible_on_all_workspaces(true)`。

证据：

- `lx-玉宁熙-Pro` 磁盘文件已带 `由 CeruMusic 插件转换器转换`，本地 vm 能跑出 `pluginInfo` 和 `musicUrl`，音源 `kw/kg/tx/wy/mg`。
- `野草` 源码没有 `lx`，Electron 当洛雪导入也会失败，没有强转。
- `cargo check` 通过；sidecar `node --check` 通过。
- 没有新开第二个 `npm run tauri dev`。现有窗口 18:33 自己重编后 PID 80245，sidecar PID 80318。Vite 仍是 `http://127.0.0.1:1421/`。

还没做 / 等用户：

- 点底栏桌面歌词，窗口要立刻出来，而且是歌词页。
- 设置页看 `lx-玉宁熙-Pro` 名字；需要的话再导入一次含 `lx` 的混淆插件。
- 设置页点开飞牛/NAS，确认 6 项表单。
- 两条同名「经典老歌」仍不删。


## 2026-09-17 插件音源写回、播客首页刷新、切歌去掉固定 100ms

用户问：洛雪和澜音两种插件都能用吗？多端同步每个细节都对齐了吗？并要求继续做插件能力、歌单排序、播客收藏、切歌慢。

结论先说清楚：

- 两种插件都能跑，但不是“随便丢进来都过”。澜音插件要带 `cerumusic`；洛雪插件要源码里真有 `lx`。`野草` 没有 `lx`，Electron 当洛雪导入也会拒，Tauri 同样拒。
- 多端同步**没有**每个细节都对齐。`pluginSync.ts` / `nasSync.ts` 和 Electron 同文件；歌单同步多了按远程 `pos` 重排。还没对齐或不做的：设置页音源标签要你看一眼；两条同名「经典老歌」不删不合并；播客收藏不会塞进普通歌单。

这一轮代码：

- sidecar 扫描转换后的洛雪插件时，不再把空的 `let sources = {}` 写进注册表。从 `originalPluginCode` / `MUSIC_QUALITY` 回填，没有就默认 `kw/kg/tx/wy/mg`。
- worker 初始化后把运行时音源写回 `registry.json`。
- 已转换插件启动时从 `originalPluginCode` 按 JSON 字符串完整解析后重转，不再被中间的分号截断。
- 洛雪 `musicUrl/getLyric/search` 不再固定等 100ms，handler 好了立刻请求。
- 播客首页监听 `ceru-podcast-favorites-updated`。

证据：`node --check` 通过。`lx-玉宁熙-Pro` 能抽出 original 并重转出 `waitForRequestHandler`。现有窗口 PID 80245 没新开。sidecar 旧进程已退出，下次插件请求会拉起带新代码的 sidecar。Vite 仍是 `http://127.0.0.1:1421/`。

还没做 / 等你：

- 设置页看音源插件是否出现酷我/酷狗等标签，飞牛/NAS 仍是 6 项表单。
- 播客页收藏后，“我的收藏”不用手动刷新。
- 点上一首/下一首，体感还慢再说。
- 两条同名「经典老歌」仍不删。


## 2026-09-17 野草识别和切歌链路

用户纠正：洛雪能识别「野草」，不能只看明文有没有 `lx`。同时上一首/下一首仍然很慢，要求识别源到开播整条链路对齐 Electron。

结论：

- 「野草」明文没有 `lx`，字符串是 `\x6c\x78` 这种混淆。洛雪运行时解码后能认。Electron 导入校验如果只做 `includes('lx')`，明文同样会失败。Tauri 现在先解码 `\xNN` / `\uXXXX` 再判断，混淆洛雪可以当洛雪导入并转换。磁盘上的「野草」已转成带 `由 CeruMusic 插件转换器转换` 的文件。
- 切歌慢的主因不是 300ms 防抖（上一首/下一首是 `immediate`）。`getMusicUrl` 过早把普通 `http://` 包成本地代理，代理 URL 不能进缓存，每次切歌都重新问插件；`tryUrlSequential` 还对当前源做 1.2s 的 `<audio>` 探测，WKWebView 对明文 HTTP 会失败，再去搜别的源。

这一轮：

- 洛雪识别先解码再 `includes('lx')`。没有 `module.exports` 的混淆洛雪会走转换器。
- `getMusicUrl` 只对飞牛/带鉴权头的流包代理，普通直链保持原 URL，才能缓存。
- 当前源拿到 URL 立刻播，不再先探测。探测如果还发生，会先包代理再探。
- 播放时 `ensureWebViewPlayableUrl` 仍会把明文 HTTP 包给 WKWebView。

多端同步要对齐的部分：

- 要对齐：插件能力、音源标签、飞牛/NAS 6 项、播客收藏独立存储、歌单按远程 `pos` 排（Tauri SQLite 之前排乱了，这是修乱序）。
- 对齐 Electron「不按歌单名合并」：两条同名「经典老歌」仍然不删不合并。
- 播客收藏不会塞进普通歌单。

没新开 `tauri dev`。现有窗口 PID 80245，Vite `http://127.0.0.1:1421/`。sidecar 已退出，下次切歌/插件请求会拉起新代码。


## 2026-09-17 切歌写回原 URL 缓存

上一轮去掉当前源探测后，切歌仍可能每次问插件：当前源成功 URL 没有写入持久化缓存；预加载还可能把代理地址写进缓存，下次又被丢掉。

这一轮：

- `tryUrlSequential` 当前源成功就按原 URL 缓存。
- `playSong` 在包 WKWebView 代理之前先缓存原 URL。
- 换源成功后按实际在播的那首歌缓存。
- 预加载：原 URL 进 SQLite，代理 URL 只进内存副槽。

PLUGIN-01：注册表音源字段已经有了，不再等设置页才算代码完成。两条同名「经典老歌」仍不删。桌面歌词仍要你点底栏看一眼。

没新开 `tauri dev`。现有窗口 PID 80245，Vite `http://127.0.0.1:1421/`。sidecar PID 97587。

## 2026-09-18 00:21 切歌控制 + 桌面歌词轻量入口

用户反馈：上一首/下一首会中断或不可用；托盘和 APP 内桌面歌词都不显示；开桌面歌词可能白闪；另一位 agent 建议桌面歌词不要二次加载整套 Vue 应用。

本轮结论与改动：

1. **切歌控制**
   - 根因仍是托盘/热键不能一律走 `toggle`。`emit_music_control` 已发 Electron 同款 `playPrev` / `playNext` / `toggle`。
   - 全局热键表为空时，Tauri 以前一个快捷键都不注册。现已按 Electron 默认热键兜底，并写入本地 `hotkeys` 表。
   - 热键匹配不能用 `shortcut.to_string()` 字符串相等（`CommandOrControl+Alt+D` Display 后是 `super+alt+KeyD`）。现已按解析后的 `Shortcut` 对象比较，并补齐 seek/volume/playMode 映射。
   - 手工验证：`Cmd+Opt+Right/Left` 能切歌，主窗口标题从《Malaysia Chabor》→《清明雨上》→《北京欢迎你》。

2. **桌面歌词显示**
   - 创建路径以前只建窗不 `reveal`，只能等 ready；ready 若没到就永远看不见。
   - 现已创建后立刻 `show()`（alpha 先 0，约 350ms 淡入），ready 立即淡入，另有 1200ms 兜底。
   - 手工验证：桌面出现标题为「桌面歌词」的透明窗，DB `isOpen=true`。

3. **轻量入口（降内存）**
   - 新增 `desktop-lyric.html` + `src/desktop-lyric-main.ts` + `src/desktop-lyric-bridge.ts`。
   - 歌词窗不再二次加载完整 `main.ts`/路由/插件/飞牛同步。
   - `DeskTopLyric.vue` 改用本地 `LyricIcon.vue`，不依赖 naive-ui。
   - Vite 已加 multi-page input；开发态 `http://127.0.0.1:1421/desktop-lyric.html` 可访问。

现有 `npm run tauri dev` 未新开第二实例。当前 app PID 以 `pgrep -f target/debug/ceru-tauri` 为准，Vite 仍是 `127.0.0.1:1421`。

## 2026-09-18 00:37 桌面歌词拖动反向 + 切歌纯音乐残留

用户反馈：桌面歌词拖动跟手反了；切下一首时有时一直显示「纯音乐，请欣赏」，再切一次才恢复。

改动：

1. **拖动**
   - 去掉错误的 macOS Y 轴二次翻转（Tauri/tao 已是 top-left）。
   - 拖动改用原生 `get_cursor_position` 的帧间增量，不再依赖 webview `screenY`。
2. **歌词同步**
   - 切歌时不再先推送空歌词数组。
   - 歌词还在 loading 且 lines 为空时，保留上一帧，避免粘在「纯音乐」。
   - 歌词加载结束后再推送快照；桌面歌词窗在歌名变化时先显示「歌词加载中...」。

## 2026-09-18 自动连跳过久（相对 Electron）

用户反馈：Tauri 失败后一直下一首/换源，跳很久；Electron 不会这样。不是人工/agent 操控。

根因（同款逻辑在 WKWebView 上被放大）：
1. `start().catch(...).then(() => autoNextCount=0)`：Promise 语义下 catch 处理后仍进 then，失败也会清零跳过计数。
2. 旧上限条件还要求 `count > 2` 才生效，小队列更容易多跳。
3. Tauri 对明文 HTTP 还要走播流代理/探活，失败率高于 Electron Chromium，所以同 bug 表现更夸张。

修复（`src/utils/audio/globaPlayList.ts`）：
- 去掉 play()-resolve 清零；只在真实 `playing`（以及成功 slotSwap）时清零。
- 跳过上限改为 `count >= min(limit,10)` 立即停。

## 2026-09-18 底栏进度/音量/歌名颜色对齐 Electron

用户反馈：进度条、Dock 歌名、按钮、音量条不像 Electron，Electron 是基础白色感。

根因：
1. 底栏曾改成实心 `--player-dock-bg`，封面白字在首页糊掉，进度看起来像主题绿。
2. `analyzeImageColors` 失败时 reject，落到 brand green；Electron 会 resolve 淡蓝+白字兜底。
3. 音量弹层 Teleport 到 body，scoped 样式/颜色容易丢。

改动：
- `PlayMusic.vue`：底栏恢复 Electron 毛玻璃 `v-bind(bg)`；音量弹层改回 absolute + `v-bind` 颜色。
- `colorExtractor.ts`：load/error 与 Electron 一样 resolve 兜底色。

验证：播你截图那首（深色黑白封面），全屏底栏应是白字/白进度；悬停音量条颜色跟进度一致。

## 2026-09-18 状态栏歌词半步滚动 + Dock 全屏 + 首页等比

用户反馈：状态栏歌词像卡 PPT；Dock 进全屏仍掉帧；首页缩小时边栏不动、热门歌单偏窄。

改动：
- `src-tauri/src/lib.rs`：滚动改成视觉半步（中文奇数帧用半宽空格 lead-in），间隔 110ms，起步 900ms；热路径不再每帧重设 monospaced 字体。
- `FullPlay.vue`：离开全屏才 dispose PIXI；Dock 隐藏只 pause，恢复已有实例 90ms resume / 首次 360ms。
- `base.css`：`font-size: clamp(15px, 1.25vw, 18px)`，去掉 vh 夹死 rem。
- `tauri.conf.json`：窗口默认/最小 1280×720，锁住一排 4 封面舒适宽度。
- find/search/songlist：5 列门槛提到 1600px。

验证：现有 `tauri dev` 已热更；播一首长中文歌词看菜单栏；从 Dock 回全屏听滑入；缩到最小看边栏与封面是否一起变。

## 2026-09-18 00:41 状态栏歌词滚动顺滑

用户反馈：状态栏歌词滚动像卡 PPT，观感难受。

改动（`src-tauri/src/lib.rs`）：

- 跑马灯从「每 380ms 跳 1 个字符」改为「每 160ms 按 1 个视觉宽度单位推进」。
- CJK 相当于大约每 320ms 移半步，比整字硬跳顺很多，同时仍能看清文字。
- 启动延迟 1200ms → 900ms。
- 对齐 Electron 的 monospaced 标题字体，减少比例字体造成的跳动。

## 2026-09-18 内存/CPU 优化（注释 2、4-12、15）

用户圈定要做：桌面歌词轻量入口、GlobalPlayStatus 不 persist 歌词/评论、播放队列防抖写入、首页 KeepAlive 上限、封面代理缩略图、sessionCache LRU、后台停循环、全屏频谱保持现状、离开全屏销毁 PIXI、着色器 12fps 且不可见时停、NAS 长轮询。明确不做：插件空闲回收、流式解码、菜单栏 380ms 滚动、默认关频谱。

本轮代码：

- 列表 `sImage` 走 `:max-edge="128"`，`applyImageSrc` 统一 `withThumbEdge`。HTTPS 封面只有列表缩略图才包进封面代理；Dock/全屏不传 max-edge，保持原分辨率。
- 发现页卡片 hover 背景也走 128 缩略图，避免 CSS 再拉一张原图把省下的内存吃掉。电台详情封面不加 max-edge。
- 封面代理缓存 `Arc<[u8]>`，16MB / 192 张；`edge` 查询单独缓存键。
- `GlobalPlayStatus persist: false`；`LocalUserDetail` 歌单 400ms 防抖写入；首页 `KeepAlive :max="4"`；`sessionCache` LRU 80。
- `GlobalAudio` / 着色器听 `ceru-sleep`；着色器降到 12fps，窗口不可见彻底停循环，不销毁 GL，回来只重启 rAF，避免重新编译卡一下。
- 离开全屏销毁 PIXI。NAS 前台改长轮询 20s，空结果最少隔 2s。

验证：

- `cargo check --offline --manifest-path src-tauri/Cargo.toml` 通过。
- 本轮没有跑着的 `ceru-tauri` / `tauri dev` 进程，所以没有实测 CPU/内存数字。不要把代码改完当成占用已经下降。
- 不要新开第二份 `npm run tauri dev`。现有窗口自己热更/重编后再看 Activity Monitor。

## 2026-09-18 全屏播放点不进去 / 设置页点不了

用户反馈：全屏播放器界面打不开；播放时侧栏菜单和设置页也都进不去。

原因：全屏层用 `transform: translate3d` 滑入。WKWebView 视觉上把层移走了，点击检测还在原来的整屏盒子上。于是全屏看起来没打开，菜单/设置其实被看不见的层挡住。底栏 z-index 更高，所以播放条还能点。

改动：

- `FullPlay.vue` 滑入改回 Electron 的 `top` 动画，关闭时立刻 `pointer-events: none`。
- 打开时明确恢复 `pointer-events: auto`，避免上一轮残留 `none`。
- 离开全屏时把 PIXI canvas 隐藏并摘掉，防止 WebGL 画布继续吃点击。
- 第一次点底栏会先挂上 FullPlay 再切换，避免组件还没加载。

不要新开第二份 `tauri dev`。现有窗口热更后再点底栏封面/空白处打开全屏，再试侧栏和设置按钮。

## 2026-09-18 列表封面分辨率上调

用户说 128 太糊。列表缩略图改为：

- 歌曲行 40px 封面：`max-edge=256`（够 Retina）
- 发现页/排行榜/播客大卡片：`max-edge=384`
- Dock / 全屏 / 电台详情仍不传 max-edge，继续用原图

现有窗口热更后滚发现页和歌单即可看到。不要新开第二份 tauri dev。

## 2026-09-18 初始窗口对齐 Electron

用户反馈 Tauri 初始界面太长，和 Electron 对不齐。

对照 Electron `createWindow`：默认 `1100x750`，最小 `1100x670`。
Tauri 之前是 `1280x760` / 最小 `1280x720`，窗口更扁，侧栏和发现页都会被拉长。

改动：

- `src-tauri/tauri.conf.json`：默认/最小改回 `1100x750` / `1100x670`。
- `src/assets/base.css`：根字号改回 Electron 的 `min(max(1.4vw, 15px), 18px)`；底栏高度改回 `max(min(10vh, 80px), 70px)`。

现有 `tauri dev` 窗口不会自动缩回去，需要关掉当前窗口再开一次，或手动把窗口拉到约 1100x750。不要新开第二份 dev。

## 2026-09-18 全屏背景：取消流光，只留取色打光

用户反馈：打开全屏会先闪一下 Electron 那种封面取色打光，随后被 PIXI「流光」盖住；封面是白绿色时背景却像平蓝，样式也不对。

结论：
- 用户要的不是流光，而是 Electron 同款 `.bg-fallback` 封面取色打光。
- 之前为了修 WKWebView 黑底，把 PIXI 提前 reveal，结果流光层盖住了正确的取色背景。

本轮改动：
- `src/components/Play/FullPlay.vue`：彻底去掉 AMLL/PIXI 流光背景（不再创建 WebGL、不再挂 `.bg-render`）。全屏只保留封面取色双层渐变打光。
- 取色链路保留上一轮修复：远程 https 封面走本地 cover proxy / blob，失败的默认蓝不永久缓存。
- `GlobalPlayStatus.resetColors()` 会清掉 `ColorObject`，避免旧色残留。

验证：
- 现有 `npm run tauri dev` 已在跑，不要新开第二份。热更后打开全屏，应只看到取色打光，不应再闪一下再被流光盖住。
- 用白绿封面歌打开全屏，背景应跟封面主色走，不应长期卡在默认蓝。

## 2026-09-18 播放设置对齐核查 + DLNA invoke 修复

用户问：高级音效 4 项、均衡器、DLNA 投屏、音频输出设备，是不是无损完美移植？

核查结论（相对 Electron，文件 diff 为空）：
- `AudioEffectSettings.vue` / `EqualizerSettings.vue` / `AudioOutputSettings.vue`
- `AudioEffects.ts` / `equalizer.ts` / `audioOutput.ts` / `dlna.ts`
- `audioManager.ts` / `PlaybackSection.vue` / `GlobalAudio.vue` 应用链路

这些 UI + Web Audio 逻辑是同款移植，不是“看起来像、参数不同”。
四个高级音效细节也一致：
1. 低音增强：lowshelf 200Hz，gain -12~12，预设 light/medium/heavy
2. 环绕：Convolver IR，small/medium/large
3. 声道平衡：StereoPanner -1~1
4. 响度均衡：DynamicsCompressor + makeup，gentle/standard/strong

真实差距：
1. **DLNA 之前坏了**：`dlna.ts` 仍走 `window.electron.ipcRenderer.invoke('dlna:...')`。
   频道名映射已补，但 invoke 仍把 payload 包成 `{ args }`，导致
   `dlna_play({url,location,title})` / `dlna_seek({seconds})` / `dlna_set_volume({volume})`
   对不上 Rust 命令。现已在 `src/tauri-bridge.ts` 增加 `packInvokeArgs`：
   - 0 参数 → undefined
   - 单对象 → 原样透传
   - seek/setVolume 标量 → `{ seconds }` / `{ volume }`
   - `dialog:openFile` 仍走 `{ args: [...] }`（Rust 专门吃这个形状）
2. **音频输出设备**：前端与 Electron 同；WKWebView 的 `setSinkId` 支持弱于 Electron Chromium，列表能出，切换可能静默失败。
3. Tauri 另有 `native_audio` / `mpv` EQ 后端，但设置页默认仍驱动 Web Audio `AudioManager`，和 Electron 一致，不是两套 UI。

所以：功能层是对齐的 Web Audio 移植，不是 bit-perfect 原生重写；DLNA 属于桥接 bug，不是设置页没移植。

## 2026-09-18 全屏打开卡顿 + 发现页封面宽度

用户反馈：
1. 从 Dock/底栏点开全屏仍有掉帧感
2. 发现页热门歌单一排封面偏窄，4 列时更好；侧栏也要跟着 rem 缩放

本轮：
- `FullPlay.vue`：去掉每次 `v-if` 整页卸载/重挂。首次打开后保留挂载，只切 `is-open` 做 `top` 滑入；首次仍先挂关闭态再 rAF 打开，保证有进场动画。
- PIXI 流光此前已移除，卡顿主因变成“反复挂载全屏树”，不是 resume 延迟。
- `find.vue`：默认继续 4 列，1600px 才到 5 列；左右内边距 `2rem → 1.25rem`，同窗口下封面更宽。
- 侧栏本身已是 `15rem` + 根字号 `min(max(1.4vw, 15px), 18px)`，会随窗口等比缩放；不要再写死 px。

## 2026-09-18 音频输出设备列表 + 去掉均衡器频谱框

用户反馈：
1. Electron 能列出音频输出设备 / A/B 对比；Tauri 这边是空的
2. 均衡器下方动态频谱预览耗资源，要整块去掉，黑色框也不能留空

本轮：
- `EqualizerSettings.vue`：删除 canvas 频谱预览及其 rAF/analyser 逻辑，黑色框一并移除；保留开关、预设（爵士等）、滑条、导入导出。
- `audioOutput.ts`：先 `enumerateDevices`，若为空/无标签则请求麦克风权限再扫；并调用 Rust `native_audio_list_output_devices`（cpal）兜底，保证设置页至少能看到真实设备名和 A/B 选择。
- `native_audio.rs` + `lib.rs`：新增并注册 `native_audio_list_output_devices`。
- `Info.plist`：补 `NSMicrophoneUsageDescription`，否则权限弹窗可能起不来。
- 说明：若最终只有 `cpal:` 设备 ID（浏览器没给出 sinkId），列表/A/B UI 能用，但真正 `setSinkId` 路由仍可能受限；有浏览器 deviceId 时优先用它。

## 2026-09-18 插件更新弹窗对齐结论

用户问：音乐源插件能不能像 Electron 一样主动弹窗提示更新。

结论：**半对齐，主路径有，但有两个断点，所以经常弹不出来。**

Electron 链路：
1. 洛雪插件 `lx.send('updateAlert', { log, updateUrl })`
2. `converter-event-driven` 转成 `NoticeCenter('update', { title, content, url, pluginInfo })`
3. `CeruMusicPluginHost` / worker 调 `sendPluginNotice`
4. 主进程格式化成带「稍后更新 / 立即更新」的 DialogNotice
5. 渲染进程 `PluginNoticeDialog` 弹窗，点立即更新走 `downloadAndAddPlugin`

Tauri 现状：
- UI 弹窗组件已有：`src/components/PluginNoticeDialog.vue`
- sidecar 正式链路也有：`sidecar/services/plugins/pluginNotice.mjs` 会发完整 DialogNotice
- 洛雪转换器也接了 `updateAlert`

断点：
1. 前端沙箱 fallback（`src/utils/plugin/pluginSandbox.ts`）只发原始 `{type,data}`，没有 `dialogType/title/actions`
2. `src/tauri-bridge.ts` 的 `normalizeDialogNotice()` 会直接丢掉这类原始通知；旁边注释还写着“已安装插件启动时不应弹窗”，这和 Electron 行为不一致
3. 通知策略还有 3 秒冷却：同一插件短时间重复更新提示可能被压住

所以：不是完全没有更新能力，而是“能更新的插件发出提示后，Tauri 不一定弹得出来”。下一步如果要修，优先让沙箱原始 notice 也走和 Electron 一样的 DialogNotice 格式化，并允许 update 弹窗。

## 2026-09-18 播客分类页码位置 + 歌单加载闪一下

用户反馈：
1. 点播客分类时，封面还没来，分页条会先跑到中间
2. 点侧栏「歌单」每次都要先转圈才出列表

本轮：
- `podcast.vue`：分类区始终保留网格高度；无数据时用同尺寸骨架卡片占位，PagerBar 固定在下方；切换分类先清空再填入，避免旧分类错位。
- `songlist.vue`：已有列表时后台刷新，不再 `v-if="loading"` 整页空白；本地歌单先渲染，云端合并后补齐。
- `list.vue`：点进详情若已有歌曲不整页空白转圈。
- 给 `podcast`/`songlist`/`list` 补 `defineOptions({ name })`，`KeepAlive max` 4→8，减少侧栏来回被挤掉重载。

## 2026-09-18 歌单查重清理交互改造

用户要求：查重清理不要系统硬定保留/删除；每首歌左边勾选，右侧「保留 / 删除」；一键清理只删当前勾选项。

本轮改动：
- 重写 `src/components/Music/DuplicateSongsDialog.vue`
- 仍按规范化歌名分组找重复
- 打开弹窗时默认按建议勾选（每组第 1 首保留，其余勾选待删），但用户可改
- 每行：左侧 checkbox + 歌名信息 + 右侧「保留」「删除」
- 「保留」= 取消勾选；「删除」= 立即删这一首
- 「一键清理」只删当前勾选的歌
- 额外提供「按建议勾选」
- 父组件 `list.vue` 的 `@remove` / `@remove-many` 接口未改

验收：
1. 打开歌单 → 查重清理
2. 每首歌都有勾选框、保留、删除
3. 取消勾选 / 点保留后，一键清理不会删它
4. 点删除会立刻删单首

## 2026-09-18 查重清理交互再收紧

用户继续要求：不要系统硬定保留/删除；每首歌前面勾选；右侧左「保留」、右「删除」；勾完再一键清理。

本轮相对上一版再收紧：
- `DuplicateSongsDialog.vue`：每首歌「保留 / 删除」始终可点，不再把「保留」在未勾选时禁用
- 勾选语义写清：勾选 = 准备删除；「保留」= 取消勾选；「删除」= 立刻删这一首；「一键清理」只删当前勾选项
- 打开弹窗仍会「按建议勾选」（每组第 1 首默认保留），但只是默认建议，用户可改
- 父组件 `list.vue` 的 `@remove` / `@remove-many` 未改

请在现有 Tauri 窗口验收：
1. 歌单更多菜单 → 查重清理
2. 每行都有勾选框 + 保留 + 删除
3. 点保留后，一键清理不会删它
4. 点删除会立刻删单首

## 2026-09-18 播客「我的收藏」默认两排折叠

用户要求：播客页「我的收藏」右边加「折叠 / 展开」；默认只显示两排，折叠仍是两排，展开后显示全部。收藏多了不能一直无限往下铺。

本轮：
- `src/views/music/podcast.vue`
- 标题右侧增加「展开 / 折叠」按钮（只有超过两排时才出现）
- 折叠上限 = 当前窗口列数 × 2（复用分类区的列宽估算）
- 默认折叠；点展开显示全部收藏

## 2026-09-18 Dock 底栏黑图标融合

用户反馈：底栏按钮/菜单有时变黑，和底栏融在一起；Electron 是白灰图标 + 深色磨砂底。

原因：封面取色 `useBlackText` 会把 Dock 的 `textColor/hoverColor` 切成黑色。亮封面时图标变黑，再叠半透明底就糊掉。不是两套菜单，是取色链路把 Dock 文字色带跑了。

本轮：`PlayMusic.vue` 底栏固定白灰图标 + 深色磨砂底；封面主色只驱动进度条/音量填充，不再翻转 Dock 图标颜色。全屏歌词页仍可用 `useBlackText`。

## 2026-09-18 全屏背景改安卓烘焙打光

用户确认：全屏播放背景换成安卓方案——多层取色打光先合并烘焙，再贴图；外观接近，播放中持续占用更低。

本轮：
- 新增 `src/utils/color/bakedAmbientBackdrop.ts`
  - 按安卓 `PlayerGpuBackdrop` 的光斑/方向雾/Overlay 结构烘焙
  - 长边封顶 720，结果缓存
- `FullPlay.vue`
  - 去掉播放中持续叠 CSS `::after` 柔光
  - 切歌/开全屏/窗口尺寸变化时烘焙成 `url(data:...)`，双层 A/B 淡入
  - 播放过程只贴烘焙图，不再每帧合成多层渐变

验收：
1. 打开全屏，背景仍是封面取色打光，不是流光
2. 切歌时背景平滑过渡
3. 播放中不应再有额外 CSS 伪光斑层

## 2026-09-18 取消喜欢时踢出当前播放

用户场景：在「我的喜欢」听到不喜欢的歌，取消喜欢后，如果这首正在播，应同时从播放队列移除并切下一首。

本轮：
- 新增 `src/utils/playlist/evictUnlikedFromPlayback.ts`
  - 本地队列：先解析下一首，再删目标，再切播；没有下一首则暂停
  - 一起听：有控制权时只发队列删除（与播放列表抽屉一致）
- 接入点：
  - `SongVirtualList.vue` 列表点心取消喜欢
  - `PlayMusic.vue` 底栏点心取消喜欢
  - `list.vue` 从「我的喜欢」移出单曲

验收：
1. 播放「我的喜欢」里的歌 A
2. 在列表取消 A 的喜欢 / 移出我的喜欢
3. A 应从播放队列消失，并自动播下一首

## 2026-09-18 播客封面放大 + 歌单页去空白闪烁

用户反馈：
1. 播客页窗口放大后封面反而更小，缩到最小窗口封面更大；希望按“最小窗口那种更大封面”来展现
2. 每次点侧栏「歌单」都先空白/创建歌单，再加载出列表

本轮：
- `podcast.vue`：提高网格 `minmax`（约 196/220），分类列数封顶 4/5/6，窗口变宽时不再把封面挤小
- `home/index.vue`：KeepAlive 不再 exclude `songlist`，max 提到 8，侧栏来回保留歌单页
- `songlist.vue`：会话缓存首屏；本地列表尽快写入；加载中不展示“创建歌单”空态

## 2026-09-18 播客封面尺寸纠偏

用户纠正：小窗口要保持以前的小封面，不要变成三列大封面。

本轮：
- 恢复小窗口 `132/156` 小封面密度
- 宽屏仍保留列数上限（约 5/6/7），避免最大化后封面被挤得过碎

## 2026-09-18 飞牛播放 + 描述文案 + 暂停过渡

用户反馈：
1. 飞牛歌单歌曲点播报「插件未返回播放链接」
2. 歌单描述仍显示「由服务与插件 UUID 导入」
3. 暂停/播放过渡感觉没对齐 Electron

根因：
1. Tauri sidecar 的 `cerumusic.request` 没返回 `response.url`，还会把整首 audio/mpeg 读进 worker；飞牛 `musicUrl` 因此超时/失败
2. 详情页路由会先把旧描述塞进 `playlistInfo.desc`；卡片虽已格式化，详情仍可能露 UUID
3. `transitionVolume` 把 `isPageIdle()` 也当成跳过条件；用户主动暂停时前台也可能被 idle 掐掉淡入淡出

本轮：
- `sidecar/services/plugins/pluginWorker.mjs` / `index.mjs`：二进制音视频跳过 body，并返回 `url: response.url`
- 同步到正在跑的 `src-tauri/target/debug/_up_/sidecar/...`，并重启 sidecar 子进程
- `tauri-bridge.ts`：飞牛取链失败时，直接用配置拼鉴权流地址 + Cookie
- `list.vue` / `songlist.vue`：描述归一化加强；路由描述也走「由飞牛服务插件导入」
- `volume.ts`：暂停/播放加长过渡不再被页面 idle 跳过

验收：
1. 打开「飞牛全部歌曲」，描述应显示「由飞牛服务插件导入」
2. 点任意飞牛歌，不应再 toast「插件未返回播放链接」；实际 src 应是本地 `/stream/...` 代理
3. 开着「暂停播放过渡」时，暂停应慢慢停、播放应慢慢起；「无感过渡」默认关，需手动开才有切歌交叉淡化

## 2026-09-18 播客播放乱跳修复

用户反馈：播客点播放会连续跳下一首；音乐失败时也会一直跳。

根因：
- 播客失败后仍走音乐候选换源（`getCandidateSongs` / `tryUrlSequential`）
- 换源失败再 `tryAutoNext`，形成连跳

本轮：
- 播客识别后：不搜音乐候选源、不跨源换源
- `tryAutoNext` 对播客/长节目直接停并报错，不再连跳
- `getSongRealUrl` 对播客只打官方链路，不带当前音乐插件乱试

## 2026-09-18 全屏播放卡住 + 顶部拖不动

用户反馈：
1. 全屏播放听着听着歌词不滚、频谱不跳；点一下又恢复
2. 全屏页顶部左右拖不动窗口

根因：
1. 全局 `idleSleep` 15 秒无操作后会 `ceru-sleep`；频谱/着色器直接停，进度刷新掉到极低，歌词看起来像卡住
2. Electron 靠 `-webkit-app-region: drag`；Tauri/WKWebView 不吃这个。全屏打开时 App 顶部拖拽带又被 `pointer-events:none` 关掉，所以全屏页顶部拖不动

本轮：
- `idleSleep.ts`：增加 `suppressIdleSleep` / `releaseIdleSleep`
- `PlayMusic.vue`：全屏打开时抑制全局 idle，关闭/卸载时释放
- `FullPlay.vue`：顶部增加 `fullplay-drag-strip`，并显式 `startWindowDrag`
- `TitleBarControls.vue`：根节点补 `data-tauri-drag-region` + `startWindowDrag`

验收：
1. 打开全屏播放，手放着不动超过 15 秒，歌词应继续滚、频谱应继续跳
2. 全屏页顶部空白区域应能左右拖动窗口；按钮仍可点

## 2026-09-18 播客官方取链打通 + 音乐跳歌折中

用户要求：
1. 播客必须走通官方，对齐 Electron
2. 音乐失败不能无限连跳，但也不是完全不换源

本轮：
- `radio.js` 节目字段补齐 `podcastProgramId` / `podcastMainSongId`（对齐 Electron mapProgram）
- `tauri-bridge.ts` 播客取链改为直打 `podcast.getPlayUrl`（官方 getOfficialPlayUrl），不再误走普通 getMusicUrl
- 播客失败：不搜音乐候选源、不自动连跳
- 普通音乐失败：保留候选换源；自动跳歌对齐 Electron（有限次，不是无限）

## 2026-09-18 随机模式上一首回到真正上一首

用户反馈：随机模式下点上一首，会再随机一首，而不是回到刚听过的那首。下一首继续随机。

本轮：
- `globaPlayList.ts` 增加播放历史栈
- 每次 `playSong` 切歌时记下刚离开的那首
- 随机模式 `playPrevious` 弹出历史；没有历史才退回列表顺序
- 从历史返回时不再把当前曲重新入栈，避免来回污染

验收：
1. 随机播放 A → 下一首到 B → 再下一首到 C
2. 点上一首应回到 B，再点上一首应回到 A
3. 再点下一首仍走随机，不是固定前进

## 2026-09-18 全屏打开必须显示已开功能

用户反馈：
1. 全屏歌词过一会儿，鼠标移上去反而停滚/雾蒙蒙，得点一下才恢复
2. 全屏打开时该显示的功能都要在；关掉全屏再省电

根因：
1. Tauri 给 AMLL 多绑了 `:disabled` / focused 门闩，失焦或状态抖动会 pause 歌词
2. 全屏 auto-hide idle 时改 `lyric-player` 高度，WKWebView 下 ResizeObserver 把 AMLL 打停
3. 全局 15s idle 也会停频谱；全屏打开时应抑制

本轮：
- 歌词属性对齐 Electron：只传 `:playing="isAudioPlaying"`，去掉 disabled 门闩
- `page-hidden` 只在窗口真正不可见时降级，不看 focused
- 去掉 idle 时 `lyric-player { height: 100vh }`
- 退出 idle / 打开全屏时 `nudgeLyricPlayback()` 强制拉回当前行
- 全屏打开继续 `suppressIdleSleep()`，关闭再释放

验收：
1. 打开全屏：开着的歌词模糊/跳动、频谱、左栏布局都应按设置显示
2. 手放着不动再移鼠标：歌词应继续滚，不应雾住卡死
3. 关掉全屏后，省电休眠可恢复

## 2026-09-19 底栏切源、音质菜单、播放默认档

用户反馈：
1. 底栏更多切源直接显示未找到；应只在当前选中插件的 QQ/酷我/酷狗/网易云/咪咕里找
2. 音质菜单只剩当前正在播的那一档，不能选其他音质
3. 设置了 320K/无损后，播放也要先按这个要，源没有才降级

根因：
1. `requestSdk('search')` 先打洛雪插件搜索；插件通常只会取链，空结果被当成成功，内置 SDK 进不去
2. 切源对话框用 2.2 秒轻量搜索 + 0.86/0.72 严匹配
3. 音质菜单和取链都只看 `song.types`，没读插件 `qualitys`，设置音质被提前降掉

本轮：
- `tauri-bridge.ts`：wy/tx/kg/kw/mg 的 search/tipSearch/searchPlaylist 直走内置 SDK
- `audioHelpers.ts`：切源只扫当前插件平台名单，对话框恢复 8 秒完整搜索，匹配分 > 0.45
- `qualityAvailability.ts`：菜单读插件 qualitys；播放先按设置音质，再插件档位，再歌曲 types
- `playlistManager.ts` / `nativeMedia.ts` / `globaPlayList.ts` / `PlayMusic.vue` 共用同一套首选音质

验收：
1. 选中带 kw/kg/tx/wy/mg 的插件后，底栏切源应列出这些平台里找到的同一首歌
2. 音质菜单应显示该平台插件声明的全部档位，当前档打勾
3. 设置无损/320K 后，播放先要这个档；没有才降

## 2026-09-19 播放时 80% CPU：进度 IPC 风暴

用户反馈：暂停时占用很低，一点播放澜音就到 80%，WebContent 也有 70% 多。MPV 自己也到 28%。

根因：
- Rust 每 100ms 新开 Unix socket 问 mpv `time-pos`，再 `emit("mpv://progress")` 灌进网页
- 网页收到后再改 Pinia `currentTime`，进度条、歌词、Dock 全跟着刷新
- 澜音主进程 80% 是在消化这条 IPC，不是解码本身

本轮：
- `mpv_player.rs` 删掉 100ms 进度轮询；只在播放/暂停/跳转/加载/结束时问一次时间
- `nativePlayback.ts` 改成网页自己走表：播放时本地计时，2 秒才向 mpv 对一次表
- 桌面歌词读 `nativeCurrentTime()`，不靠高频 IPC
- 音量等无关状态事件不再把进度条打回去

验收：
1. 关掉澜音，重新打开 `/Applications/澜音.app`
2. 播一首歌，活动监视器里「澜音」不应再稳定 80%
3. 进度条、歌词、上一首下一首仍要正常走

## 2026-09-19 窗口按钮/设置点不了

用户反馈：
1. 全屏播放页最大化、最小化、关闭、设置点不了
2. 普通界面播歌时放大、缩小、关闭也点不了
3. 怀疑省电优化把功能阉割挡住了

根因：
1. `App.vue` 顶部 `tauri-window-drag-strip` 用 `right: 9rem` + `z-index: 99999`，右上角设置/迷你/三键实际宽度超过 9rem，拖拽层直接盖住按钮
2. `FullPlay.vue` 的 `fullplay-drag-strip` 同样只让出 9rem，且 `z-index: 99990` 压在标题栏上
3. 全屏 `.playbox` 与 `.top` 同为 `z-index: 1`，播放层后挂载，命中测试先吃到 playbox
4. `TitleBarControls` 根节点挂了 `data-tauri-drag-region`，整块区域更容易被拖拽命中抢走

本轮：
- `App.vue`：拖拽带改为 `right: 13.5rem`、`height: 24px`，避开右上角按钮簇
- `FullPlay.vue`：拖拽带同步让开右上角；`.top` 提到 `z-index: 3`，`.playbox` 降到 `0`
- `TitleBarControls.vue`：根节点改为 `data-tauri-drag-region="false"`，窗口按钮补 `data-no-window-drag`，控件层抬高可点

验收：
1. 普通主页右上角设置、最小化、最大化、关闭都能点
2. 打开全屏播放后，右上角窗口按钮和设置仍可点；左上收起/全屏按钮仍可点
3. 顶部空白区仍可拖动窗口；关掉全屏后普通界面按钮继续可点

## 2026-09-19 启动麦克风权限 + MPV 音效对齐

用户反馈：
1. 麦克风权限应在软件启动完成后主动弹，而不是播歌时才弹
2. 高级音效/均衡器效果不如 Electron，怀疑切到 MPV 后方案不对

根因：
1. 麦克风只在识曲、AudioMatch、扫输出设备时才 `requestMicrophone`，启动就绪后没有主动申请
2. 播放已切到内置 mpv，音效不再走 Web Audio；旧 lavfi 映射偏离 Electron：
   - 低音用窄 peaking@90Hz，不是 lowshelf@200Hz
   - 环绕用 extrastereo+aecho，听感更像金属回声而不是 Convolver 混响
   - 响度 acompressor 的 makeup 写成了 dB，实际应按线性增益

本轮：
- `App.vue`：`isAppReady` 后主动申请麦克风（已 granted/denied 则跳过）
- `mpv_player.rs`：
  - 低音改为 `bass=g=:f=200:w=0.7`
  - 环绕改为更贴近 Electron wet mix 的短多抽头 `aecho`
  - 响度 makeup/knee 对齐 Electron DynamicsCompressor 预设

验收：
1. 过完欢迎页进入主界面后应主动弹出麦克风权限；播歌不再是第一次弹窗时机
2. 打开均衡器/低音/环绕/响度，听感应更接近 Electron；网页不应再建 AudioContext
3. 关掉音效后声音恢复干净，无明显残留回声


## 2026-09-19 Mac 媒体键/自定义快捷键

用户反馈：
1. Mac 键盘上一首/下一首不能用，暂停可以用
2. 设置里自定义全局快捷键保存了也不生效

根因：
1. 内置 mpv 默认 `--input-media-keys=yes`。暂停被 mpv 自己接住，上一首/下一首被当成 mpv 播放列表命令，当前只有一首所以没反应
2. Electron 会额外注册 `MediaPlayPause` / `MediaNextTrack` / `MediaPreviousTrack` / `MediaStop`。Tauri 以前只注册用户热键表，系统媒体键从未挂上
3. 热键表为空时只在内存里用默认值，不落库；保存后 `unregister_all` 也不会再注册媒体键
4. 设置页把 `CommandOrControl` 显示成 Ctrl，Mac 上看起来像没设对

本轮：
- `mpv_player.rs`：启动和 probe 都加 `--input-media-keys=no`，IPC 再钉一次
- `hotkeys.rs`：用户热键 + 系统媒体键统一注册；媒体键始终启用，不进用户表
- `db.rs`：空表写入默认热键；缺的动作按默认补；已清空的不复活
- `songlist.rs`：`hotkeys_set` 保存后立刻重新注册
- 设置页 Mac 上显示 Cmd

验收：
1. 播放时按键盘上一首/下一首应切歌，播放/暂停仍可用
2. 设置里改全局上一首/下一首并保存后，立刻生效，重启仍在
3. 关掉“启用全局快捷键”后，自定义组合键失效，系统媒体键仍可切歌
