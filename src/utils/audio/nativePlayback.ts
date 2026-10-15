import { useEqualizerStore } from '@renderer/store/Equalizer'
import { useAudioEffectsStore } from '@renderer/store/AudioEffects'
import { playSetting as usePlaySettingStore } from '@renderer/store/playSetting'
import { isLtInRoom } from '@renderer/utils/listenTogether/state'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'

type NativeBackend = 'unknown' | 'mpv'

type NativeLoadOptions = {
  autoplay?: boolean
  startTime?: number
  volume?: number
  playbackRate?: number
  headers?: Record<string, string>
  referrer?: string
  userAgent?: string
}

type NativeSnapshot = {
  phase?: string
  url?: string | null
  currentTime?: number
  current_time?: number
  duration?: number | null
  volume?: number
  paused?: boolean
  playbackRate?: number
  playback_rate?: number
  generation?: number
  backendReady?: boolean
  backend_ready?: boolean
}

type NativeEventPayload = {
  reason?: string
  code?: string
  message?: string
  current_time?: number
  currentTime?: number
  duration?: number | null
  phase?: string
  state?: NativeSnapshot
}

const mpvApi = () => (window as any).api?.mpv

let backend: NativeBackend = 'unknown'
let probePromise: Promise<boolean> | null = null
let listenersInstalled = false
let stateTransitioning = false
let listenerCleanups: Array<() => void> = []
let currentUrl = ''
let currentGeneration = 0
let lastProgressAt = 0
let lastPublishedTime = -1
let lastSeekAt = 0
let lastErrorAt = 0
let lastErrorCode = ''
let endedGuardUntil = 0
let volumeFadeTimer: ReturnType<typeof setInterval> | null = null
let volumeFadeToken = 0
let currentMpvVolume = 80
let desiredVolume = 80
let lastPlaybackRate = 1
let lastAppliedFilterKey = ''
let filterSyncQueue: Promise<void> = Promise.resolve()
let lastPlayPublished = false
let lastPausePublished = false
let lastCanPlayPublished = false
let lastAppliedPlaybackRate: number | null = null

let clockAnchorMs = 0
let clockAnchorTime = 0
let clockRate = 1
let clockPlaying = false
let localClockTimer: ReturnType<typeof setTimeout> | null = null
let driftTimer: ReturnType<typeof setTimeout> | null = null
let lastDriftAt = 0
const DRIFT_INTERVAL_MS = 5000

// macOS CoreAudio AO 静默死亡恢复:系统默认输出设备切换 / 蓝牙连接断开 /
// coreaudiod 重启 / 睡眠唤醒后,mpv 的音频输出会哑掉但解码照常推进。监听
// devicechange,防抖后让 mpv 重建 AO(aid 循环),音频随即回到当前默认设备。
let reloadingAudioOutput = false
let lastAudioReloadAt = 0
let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
const AUDIO_RELOAD_COOLDOWN_MS = 1500
const DEVICE_CHANGE_DEBOUNCE_MS = 800

// 最近一次音频设备拓扑变化(耳机插拔/蓝牙连断)的时间戳。macOS 会在这类变化前后
// 替 App 发一条系统媒体指令(拔耳机发 pause、插回发 play)，前端据此抑制"戴上又自动播"。
let lastAudioDeviceChangeAt = 0
export const lastAudioDeviceChangeAtMs = (): number => lastAudioDeviceChangeAt

let audioStoreRef: any = null
export const attachNativePlaybackStore = (store: any) => {
  audioStoreRef = store
}
const getAudioStore = () => audioStoreRef

const firstNumber = (...values: Array<number | null | undefined>): number => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

const snapshotFromPayload = (payload?: NativeEventPayload | null): NativeSnapshot => {
  return (payload?.state || payload || {}) as NativeSnapshot
}

const snapshotTime = (snapshot: NativeSnapshot, payload?: NativeEventPayload | null): number => {
  return firstNumber(
    payload?.currentTime,
    payload?.current_time,
    snapshot.currentTime,
    snapshot.current_time
  )
}

const snapshotDuration = (snapshot: NativeSnapshot, payload?: NativeEventPayload | null): number => {
  return firstNumber(payload?.duration as number | undefined, snapshot.duration as number | undefined)
}

const snapshotPaused = (snapshot: NativeSnapshot): boolean => {
  if (typeof snapshot.paused === 'boolean') return snapshot.paused
  return snapshot.phase === 'paused' || snapshot.phase === 'stopped' || snapshot.phase === 'ended'
}

const interpolatedTime = (): number => {
  if (!clockPlaying) return clockAnchorTime
  const elapsed = (performance.now() - clockAnchorMs) / 1000
  const next = clockAnchorTime + elapsed * (clockRate > 0 ? clockRate : 1)
  const duration = getAudioStore()?.Audio.duration || 0
  if (duration > 0) return Math.min(next, duration)
  return Math.max(0, next)
}

const armClock = (time: number, playing: boolean, rate?: number) => {
  clockAnchorTime = Math.max(0, Number(time) || 0)
  clockAnchorMs = performance.now()
  clockPlaying = playing
  if (typeof rate === 'number' && rate > 0) clockRate = rate
  if (playing) {
    startLocalClock()
    startDriftSync()
  } else {
    stopLocalClock()
    stopDriftSync()
  }
}

const progressPublishInterval = () => {
  // Keep UI progress local. High-frequency Pinia publishes are fine;
  // crossing into Tauri custom-protocol IPC is what burns both processes.
  // Full-screen lyrics/progress only need ~4fps locally. Dock/taskbar sync is
  // throttled separately; do not let the local clock drive custom-protocol IPC.
  if (typeof document !== 'undefined' && document.body.classList.contains('full-play-open')) return 250
  if (isAppWindowVisible()) return 1000
  return 2000
}

const stopLocalClock = () => {
  if (localClockTimer) {
    clearTimeout(localClockTimer)
    localClockTimer = null
  }
}

const startLocalClock = () => {
  if (localClockTimer) return
  const tick = () => {
    localClockTimer = null
    if (!clockPlaying || !isNativePlaybackActive()) return
    publishLocalProgress()
    localClockTimer = setTimeout(tick, progressPublishInterval())
  }
  tick()
}

const stopDriftSync = () => {
  if (driftTimer) {
    clearTimeout(driftTimer)
    driftTimer = null
  }
}

const startDriftSync = () => {
  if (driftTimer) return
  const tick = () => {
    driftTimer = null
    if (!clockPlaying || !isNativePlaybackActive()) return
    void syncClockFromMpv()
    driftTimer = setTimeout(tick, DRIFT_INTERVAL_MS)
  }
  driftTimer = setTimeout(tick, DRIFT_INTERVAL_MS)
}

const publishLocalProgress = (force = false) => {
  const store = getAudioStore()
  if (!store) return
  const nextTime = interpolatedTime()
  const now = Date.now()
  const quantized = Math.round(nextTime * 10) / 10
  if (!force && now - lastProgressAt < progressPublishInterval() && quantized === lastPublishedTime) return
  lastProgressAt = now
  lastPublishedTime = quantized
  store.setCurrentTime(nextTime)
  if (isAppWindowVisible() || force) store.publish('timeupdate')
}

const syncClockFromMpv = async () => {
  const api = mpvApi()
  if (!api?.getState || !isNativePlaybackActive()) return
  const now = Date.now()
  if (now - lastSeekAt < 400) return
  if (now - lastDriftAt < DRIFT_INTERVAL_MS - 250) return
  lastDriftAt = now
  try {
    const snapshot = (await api.getState()) as NativeSnapshot
    const nextTime = snapshotTime(snapshot)
    const paused = snapshotPaused(snapshot)
    const rate = firstNumber(snapshot.playbackRate, snapshot.playback_rate, clockRate) || 1
    if (rate > 0) clockRate = rate
    const duration = snapshotDuration(snapshot)
    const store = getAudioStore()
    if (store && duration > 0) store.setDuration(duration)
    const local = interpolatedTime()
    if (paused || Math.abs(local - nextTime) > 0.35) {
      armClock(nextTime, !paused, rate)
      publishLocalProgress(true)
    }
  } catch {}
}

export const isNativePlaybackAvailable = (): boolean => backend === 'mpv'

export const isNativePlaybackActive = (): boolean =>
  backend === 'mpv' && Boolean(currentUrl)

// 让 mpv 重建音频输出(AO),从 macOS CoreAudio 静默死亡中恢复。
// 冷却 + 单飞:短时间内的多次 devicechange(蓝牙切换常连发)只重建一次,
// 避免反复拆装音频链造成可听的断断续续。失败软处理,绝不冒充播放错误。
const reloadNativeAudioOutput = async (): Promise<void> => {
  const api = mpvApi()
  if (!api?.reloadAudioOutput || !isNativePlaybackActive()) return
  if (reloadingAudioOutput) return
  const now = Date.now()
  if (now - lastAudioReloadAt < AUDIO_RELOAD_COOLDOWN_MS) return
  reloadingAudioOutput = true
  lastAudioReloadAt = now
  try {
    await api.reloadAudioOutput()
    // 重建期间 mpv 时钟未停,这里对齐一次本地时钟,避免进度跳动。
    await syncClockFromMpv()
  } catch (error) {
    console.warn('[nativePlayback] 重建音频输出失败:', error)
  } finally {
    reloadingAudioOutput = false
  }
}

// devicechange 防抖:系统切换默认设备 / 蓝牙连断会瞬间连发多次事件,
// 等设备拓扑稳定后再重建一次 AO。
const scheduleAudioReload = () => {
  if (!isNativePlaybackActive()) return
  if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
  deviceChangeTimer = setTimeout(() => {
    deviceChangeTimer = null
    void reloadNativeAudioOutput()
  }, DEVICE_CHANGE_DEBOUNCE_MS)
}

const shouldUseNativePlayback = (): boolean => backend === 'mpv'

export const shouldRoutePlaybackToNative = (): boolean =>
  shouldUseNativePlayback() && Boolean(mpvApi()?.load)

const stopVolumeFade = () => {
  volumeFadeToken += 1
  if (volumeFadeTimer) {
    clearInterval(volumeFadeTimer)
    volumeFadeTimer = null
  }
}

// 滑条百分比 -> mpv 音量值(0-100，100=设备满刻度，即系统音量档位的完整音量)。
//
// 关键：mpv 的 volume 属性不是线性增益。实测(打包内 mpv v0.41，ao=pcm + volumedetect)：
//   gain = (volume/100)^3   —— volume=50 实测 -18.0dB、volume=80 实测 -5.8dB。
// 所以把滑条百分比直接当 volume 下发(或再叠一层 p²)，实际增益会被三次曲线再压一次：
//   p²/100 曲线下 50% ≈ -36dB、80% ≈ -11.6dB —— 滑条下半段几乎全废，
//   这就是"调到 80% 就很小了、没有循序渐进"的根因。
// 这里反解这条三次曲线，让最终增益 = 滑条百分比/100（等比例）：
//   100%→100(满)、80%→92.83(-1.9dB)、50%→79.37(-6dB)、0%→0。
// 与 Electron 版 audio.volume = v/100 的线性行为一致，也满足"把系统音量档位
// 分成 100 份、按比例对应"的预期；不读取、不修改系统音量。
const sliderToMpvVolume = (percent: number): number => {
  const p = Math.max(0, Math.min(100, percent))
  return 100 * Math.cbrt(p / 100)
}

let lastSentMpvVolume = Number.NaN
let volumeIpcBusy = false
let pendingMpvVolume: number | null = null

const flushMpvVolumeIpc = async () => {
  const api = mpvApi()
  if (!api?.setVolume || volumeIpcBusy) return
  volumeIpcBusy = true
  try {
    while (pendingMpvVolume !== null) {
      const send = pendingMpvVolume
      pendingMpvVolume = null
      // 去抖按 mpv 音量域(0-100)比较：曲线后低音量段每 1% 滑条只动 ~0.2，阈值取 0.25
      if (Number.isFinite(lastSentMpvVolume) && Math.abs(lastSentMpvVolume - send) < 0.25) {
        continue
      }
      lastSentMpvVolume = send
      await api.setVolume(send)
    }
  } finally {
    volumeIpcBusy = false
    if (pendingMpvVolume !== null) {
      void flushMpvVolumeIpc().catch(() => {})
    }
  }
}

const applyMpvVolumeNow = async (volume: number, immediate = false) => {
  const next = Math.max(0, Math.min(100, volume))
  currentMpvVolume = next
  // 展示/状态保持滑条百分比域，真正下发给 mpv 的是感知曲线值
  const mpvVolume = sliderToMpvVolume(next)
  pendingMpvVolume = mpvVolume
  if (immediate) {
    pendingMpvVolume = null
    lastSentMpvVolume = mpvVolume
    const api = mpvApi()
    if (api?.setVolume) await api.setVolume(mpvVolume)
    return
  }
  await flushMpvVolumeIpc()
}

const fadeMpvVolume = async (target: number, lengthen = false): Promise<void> => {
  const api = mpvApi()
  if (!api?.setVolume) return
  const next = Math.max(0, Math.min(100, target))
  if (!isAppWindowVisible()) {
    stopVolumeFade()
    await applyMpvVolumeNow(next, true)
    return
  }
  stopVolumeFade()
  const token = volumeFadeToken
  const steps = lengthen ? 10 : 8
  const from = currentMpvVolume
  const delta = next - from
  if (Math.abs(delta) < 0.5) {
    await applyMpvVolumeNow(next, true)
    return
  }
  let step = 0
  await new Promise<void>((resolve) => {
    volumeFadeTimer = setInterval(() => {
      if (token !== volumeFadeToken) {
        resolve()
        return
      }
      step += 1
      const value = from + (delta * step) / steps
      void applyMpvVolumeNow(value).catch(() => {})
      if (step >= steps) {
        stopVolumeFade()
        void applyMpvVolumeNow(next, true).catch(() => {})
        resolve()
      }
    }, 32)
  })
}

const publishOnce = (event: 'play' | 'pause' | 'ended' | 'error' | 'canplay' | 'seeked' | 'timeupdate') => {
  const store = getAudioStore()
  if (!store) return
  if (event === 'play') {
    if (lastPlayPublished) return
    lastPlayPublished = true
    lastPausePublished = false
  } else if (event === 'pause') {
    if (lastPausePublished) return
    lastPausePublished = true
    lastPlayPublished = false
  } else if (event === 'ended' || event === 'error') {
    lastPlayPublished = false
    lastPausePublished = false
    lastCanPlayPublished = false
  } else if (event === 'canplay') {
    if (lastCanPlayPublished) return
    lastCanPlayPublished = true
  }
  store.publish(event)
}

const applyProgressToStore = (
  snapshot: NativeSnapshot,
  payload?: NativeEventPayload | null,
  force = false
) => {
  const store = getAudioStore()
  if (!store) return
  const nextTime = snapshotTime(snapshot, payload)
  const nextDuration = snapshotDuration(snapshot, payload)
  if (nextDuration > 0) store.setDuration(nextDuration)
  const paused = snapshotPaused(snapshot)
  const rate = firstNumber(snapshot.playbackRate, snapshot.playback_rate, clockRate) || 1
  const anchored = nextTime > 0 || force ? nextTime : interpolatedTime()
  armClock(anchored, !paused && Boolean(currentUrl), rate)
  publishLocalProgress(force)
}

const applyStateToStore = (snapshot: NativeSnapshot, payload?: NativeEventPayload | null) => {
  const store = getAudioStore()
  if (!store) return
  const generation = Number(snapshot.generation || 0)
  if (generation && currentGeneration && generation < currentGeneration) return
  if (generation) currentGeneration = generation
  const nextUrl = typeof snapshot.url === 'string' ? snapshot.url : currentUrl
  if (nextUrl) {
    currentUrl = nextUrl
    store.Audio.url = nextUrl
  }
  const nextDuration = snapshotDuration(snapshot, payload)
  if (nextDuration > 0) store.setDuration(nextDuration)
  const paused = snapshotPaused(snapshot)
  // During play/pause transitions, the explicit command sets isPlay and the
  // mpv event can race with it. Skip the auto-sync until the command settles.
  if (!stateTransitioning) {
    store.Audio.isPlay = !paused
  }
  if (paused) {
    if (snapshot.phase === 'ended') return
    publishOnce('pause')
  } else {
    publishOnce('play')
  }
}

const handleProgress = (payload?: NativeEventPayload | null) => {
  if (!isNativePlaybackActive()) return
  const snapshot = snapshotFromPayload(payload)
  applyProgressToStore(snapshot, payload)
}

const handleState = (payload?: NativeEventPayload | null) => {
  if (!isNativePlaybackActive()) return
  const snapshot = snapshotFromPayload(payload)
  applyStateToStore(snapshot, payload)
  const reason = String(payload?.reason || '')
  if (['play', 'pause', 'seek', 'load', 'file-loaded', 'end-file', 'stop'].includes(reason)) {
    applyProgressToStore(snapshot, payload, true)
    if (reason === 'load' || reason === 'file-loaded') {
      lastCanPlayPublished = false
      publishOnce('canplay')
    }
    return
  }
  const paused = snapshotPaused(snapshot)
  if (paused === clockPlaying) {
    armClock(interpolatedTime(), !paused, clockRate)
  }
}

const handleEnded = (payload?: NativeEventPayload | null) => {
  if (!isNativePlaybackActive()) return
  const now = Date.now()
  if (now < endedGuardUntil) return
  endedGuardUntil = now + 800
  const store = getAudioStore()
  if (store) store.Audio.isPlay = false
  armClock(store?.Audio.duration || interpolatedTime(), false)
  publishOnce('ended')
  window.dispatchEvent(new CustomEvent('global-music-control', { detail: { name: 'autoNext' } }))
  void payload
}

const handleError = (payload?: NativeEventPayload | null) => {
  const code = String(payload?.code || '')
  if (code === 'mpv_init_failed' || code === 'mpv_listen_failed' || code === 'mpv_ipc_disconnected') {
    disableNativePlayback(payload?.message || code)
    return
  }
  if (!isNativePlaybackActive()) return
  const now = Date.now()
  if (code && code === lastErrorCode && now - lastErrorAt < 1200) return
  lastErrorAt = now
  lastErrorCode = code
  const store = getAudioStore()
  if (store) store.Audio.isPlay = false
  publishOnce('error')
}

const installListeners = () => {
  if (listenersInstalled) return
  const api = mpvApi()
  if (!api?.onState) return
  listenersInstalled = true
  listenerCleanups = [
    api.onState?.(handleState),
    api.onProgress?.(handleProgress),
    api.onEnded?.(handleEnded),
    api.onError?.(handleError)
  ].filter((item): item is () => void => typeof item === 'function')
  // 窗口可见性唤醒（最小化/恢复、隐藏/显示主窗口）与 15s 闲置唤醒：只对齐进度时钟。
  // 绝不重建 MPV 音频链——窗口级唤醒与 CoreAudio 存活状态无关，若在每次恢复窗口时
  // 拆装 AO，会产生可听见的停顿（最小化后恢复窗口声音"卡一下"的根因）。
  const onWindowWake = () => {
    if (!isNativePlaybackActive()) return
    void syncClockFromMpv()
    if (clockPlaying) startLocalClock()
  }
  window.addEventListener('shuxia-wake', onWindowWake)
  listenerCleanups.push(() => window.removeEventListener('shuxia-wake', onWindowWake))

  // 真实系统睡眠/唤醒（Rust 侧 NSWorkspace didWake 派发的 app-system-wake）：
  // 唤醒后 CoreAudio AO 常已静默失效，主动重建一次音频输出。
  const onSystemWake = () => {
    if (!isNativePlaybackActive()) return
    void syncClockFromMpv()
    if (clockPlaying) startLocalClock()
    void reloadNativeAudioOutput()
  }
  const offSystemWake = (window as any).api?.app?.onSystemWake?.(onSystemWake)
  if (typeof offSystemWake === 'function') listenerCleanups.push(offSystemWake)

  // 默认输出设备变化（Rust 侧 CoreAudio 派发 app-audio-device-changed）：耳机插拔、
  // 蓝牙连断、手动切换输出设备。比 WebView 的 devicechange 可靠（WebKit 在 macOS
  // 不暴露 audiooutput 设备）。既用于重建 AO，也用于标记"刚发生过设备变化"，
  // 供 globaPlayList 抑制 macOS 替 App 发的系统媒体指令（避免"戴上耳机自动播"）。
  const onNativeDeviceChange = () => {
    lastAudioDeviceChangeAt = Date.now()
    scheduleAudioReload()
  }
  const offDeviceChanged = (window as any).api?.app?.onAudioDeviceChanged?.(onNativeDeviceChange)
  if (typeof offDeviceChanged === 'function') {
    listenerCleanups.push(offDeviceChanged)
    listenerCleanups.push(() => {
      if (deviceChangeTimer) {
        clearTimeout(deviceChangeTimer)
        deviceChangeTimer = null
      }
    })
  }

  // 兜底：WebView 的 devicechange（蓝牙连断、coreaudiod 重启等也会连发）。
  const mediaDevices = navigator?.mediaDevices
  if (mediaDevices?.addEventListener) {
    const onDeviceChange = () => {
      lastAudioDeviceChangeAt = Date.now()
      scheduleAudioReload()
    }
    mediaDevices.addEventListener('devicechange', onDeviceChange)
    listenerCleanups.push(() => {
      mediaDevices.removeEventListener('devicechange', onDeviceChange)
      if (deviceChangeTimer) {
        clearTimeout(deviceChangeTimer)
        deviceChangeTimer = null
      }
    })
  }
}

const disableNativePlayback = (reason?: string) => {
  currentUrl = ''
  currentGeneration = 0
  lastAppliedFilterKey = ''
  filterSyncQueue = Promise.resolve()
  stopVolumeFade()
  armClock(0, false)
  if (reason) console.warn('[nativePlayback] mpv 中断:', reason)
}

export const ensureNativePlayback = async (): Promise<boolean> => {
  if (backend === 'mpv') return true
  if (probePromise) return probePromise
  probePromise = (async () => {
    const api = mpvApi()
    if (!api?.init || !api?.load) {
      throw new Error('mpv 接口不可用')
    }
    await api.init()
    backend = 'mpv'
    installListeners()
    return true
  })().catch((error) => {
    probePromise = null
    backend = 'unknown'
    throw error
  })
  return probePromise
}

const currentNativeMedia = (url: string): NativeLoadOptions => {
  const media =
    ((window as any).__shuxiaCurrentNativeMedia && typeof (window as any).__shuxiaCurrentNativeMedia === 'object'
      ? (window as any).__shuxiaCurrentNativeMedia
      : {}) || {}
  return {
    headers: media.headers && typeof media.headers === 'object' ? media.headers : undefined,
    referrer: typeof media.referrer === 'string' ? media.referrer : media.referer,
    userAgent: typeof media.userAgent === 'string' ? media.userAgent : media.user_agent,
    url
  } as NativeLoadOptions
}

export const syncNativeAudioFilters = async (): Promise<void> => {
  const run = async () => {
    if (!isNativePlaybackAvailable()) return
    const api = mpvApi()
    if (!api?.setAudioFilters) return
    const eq = useEqualizerStore()
    const fx = useAudioEffectsStore()
    const request = {
      equalizer: {
        enabled: Boolean(eq.enabled),
        gains: Array.isArray(eq.gains) ? [...eq.gains] : []
      },
      bassBoost: {
        enabled: Boolean(fx.bassBoost.enabled),
        gain: Number(fx.bassBoost.gain) || 0
      },
      surround: {
        enabled: Boolean(fx.surround.enabled),
        mode: fx.surround.mode || 'off'
      },
      balance: {
        enabled: Boolean(fx.balance.enabled),
        value: Number(fx.balance.value) || 0
      },
      loudness: {
        enabled: Boolean(fx.loudness.enabled),
        target: fx.loudness.target || 'standard'
      }
    }
    const key = JSON.stringify(request)
    if (key === lastAppliedFilterKey) return
    lastAppliedFilterKey = key
    await api.setAudioFilters(request)
  }
  const queued = filterSyncQueue.then(run, run)
  filterSyncQueue = queued.then(
    () => undefined,
    () => undefined
  )
  await queued
}

export const nativeLoad = async (url: string, options: NativeLoadOptions = {}): Promise<boolean> => {
  if (!(await ensureNativePlayback()) || !shouldUseNativePlayback()) return false
  const api = mpvApi()
  if (!api?.load) return false
  const trimmed = url.trim()
  if (!trimmed) return false
  const store = getAudioStore()
  if (!store) return false
  stopVolumeFade()
  lastPlayPublished = false
  lastPausePublished = false
  lastCanPlayPublished = false
  lastAppliedPlaybackRate = null
  lastPublishedTime = -1
  lastErrorCode = ''
  endedGuardUntil = 0
  currentUrl = trimmed
  store.Audio.url = trimmed
  store.Audio.srcA = ''
  store.Audio.srcB = ''
  store.Audio.secondaryUrl = ''
  store.Audio.currentTime = options.startTime && options.startTime > 0 ? options.startTime : 0
  store.Audio.duration = 0
  store.Audio.isPlay = Boolean(options.autoplay)
  // 0 是合法的滑条值（用户可精确拖到 0% = 静音），只有非有限数才回退到 80。
  // 旧代码把 0 强行改成 80，导致"拖到底部又弹回去"，见 nativeSetVolume 同款注释。
  desiredVolume =
    typeof options.volume === 'number' && Number.isFinite(options.volume)
      ? options.volume
      : store.Audio.volume
  if (!Number.isFinite(desiredVolume)) desiredVolume = 80
  desiredVolume = Math.max(0, Math.min(100, desiredVolume))
  currentMpvVolume = options.autoplay ? 0 : desiredVolume
  const media = currentNativeMedia(trimmed)
  try {
    const snapshot = (await api.load({
      url: trimmed,
      headers: options.headers || media.headers,
      referrer: options.referrer || media.referrer,
      userAgent: options.userAgent || media.userAgent,
      autoplay: Boolean(options.autoplay),
      startTimeSeconds: options.startTime || 0,
      volume: options.autoplay ? 0 : sliderToMpvVolume(desiredVolume),
      playbackRate: options.playbackRate || lastPlaybackRate || 1
    })) as NativeSnapshot
    currentGeneration = Number(snapshot?.generation || currentGeneration || 0)
    applyStateToStore(snapshot)
    applyProgressToStore(snapshot, null, true)
    armClock(snapshotTime(snapshot) || store.Audio.currentTime || 0, Boolean(options.autoplay), options.playbackRate || lastPlaybackRate || 1)
    void syncNativeAudioFilters().catch((error) => {
      console.warn('[nativePlayback] 音效滤镜应用失败，继续直出', error)
    })
    publishOnce('canplay')
    return true
  } catch (error) {
    currentUrl = ''
    lastPlayPublished = false
    lastPausePublished = false
    lastCanPlayPublished = false
    lastAppliedPlaybackRate = null
    console.error('[nativePlayback] mpv 加载失败', error)
    throw error
  }
}

export const nativePlay = async (): Promise<boolean> => {
  if (!isNativePlaybackActive()) return false
  const api = mpvApi()
  if (!api?.play) return false
  const store = getAudioStore()
  if (!store) return false
  stateTransitioning = true
  try {
    stopVolumeFade()
    await applyMpvVolumeNow(desiredVolume, true)
    await api.play()
    store.Audio.isPlay = true
    publishOnce('play')
    armClock(interpolatedTime(), true, lastPlaybackRate || 1)
    return true
  } catch (error) {
    store.Audio.isPlay = false
    throw error
  } finally {
    stateTransitioning = false
  }
}

export const nativePause = async (options: { fade?: boolean } = {}): Promise<boolean> => {
  if (!isNativePlaybackActive()) return false
  const api = mpvApi()
  if (!api?.pause) return false
  const store = getAudioStore()
  if (!store) return false
  const playSetting = usePlaySettingStore()
  const skipTransition =
    options.fade === false ||
    !playSetting.getIsPauseTransition ||
    isLtInRoom() ||
    !isAppWindowVisible()
  store.Audio.isPlay = false
  stateTransitioning = true
  try {
    if (!skipTransition) {
      await fadeMpvVolume(0, true)
      await applyMpvVolumeNow(desiredVolume, true)
    } else {
      stopVolumeFade()
    }
    await api.pause()
    armClock(interpolatedTime(), false)
    publishOnce('pause')
    return true
  } catch (error) {
    publishOnce('error')
    throw error
  } finally {
    stateTransitioning = false
  }
}

export const nativeSeek = async (seconds: number): Promise<boolean> => {
  if (!isNativePlaybackActive()) return false
  const api = mpvApi()
  if (!api?.seek) return false
  const next = Math.max(0, Number(seconds) || 0)
  lastSeekAt = Date.now()
  const store = getAudioStore()
  if (store) store.setCurrentTime(next)
  armClock(next, Boolean(store?.Audio.isPlay), lastPlaybackRate || 1)
  await api.seek(next)
  store?.publish('seeked')
  return true
}

export const nativeSetVolume = async (volume: number, transition = false): Promise<boolean> => {
  if (!isNativePlaybackAvailable()) return false
  // 0 是合法值：滑条拖到底就是静音（mpv volume 0），必须原样下发。
  // 旧代码在这里把 0 改写成 80，于是"点到底部又弹回 80%"——用户要的是
  // 精确控制（0%、1% 都能点），所以只对非有限数兜底。
  const parsed = Number(volume)
  desiredVolume = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
  if (!isNativePlaybackActive()) return true
  if (transition && getAudioStore()?.Audio.isPlay) {
    void fadeMpvVolume(desiredVolume).catch(() => {})
    return true
  }
  stopVolumeFade()
  await applyMpvVolumeNow(desiredVolume, true)
  return true
}

export const nativeSetPlaybackRate = async (rate: number): Promise<boolean> => {
  lastPlaybackRate = rate > 0 ? rate : 1
  if (!isNativePlaybackActive()) return false
  const api = mpvApi()
  if (!api?.setPlaybackRate) return false
  // Same-rate no-ops must not cross custom-protocol IPC. A previous loop was:
  // set_playback_rate -> mpv://state -> canplay -> set_playback_rate.
  if (
    lastAppliedPlaybackRate !== null &&
    Math.abs(lastAppliedPlaybackRate - lastPlaybackRate) < 0.001
  ) {
    armClock(interpolatedTime(), clockPlaying, lastPlaybackRate)
    return true
  }
  await api.setPlaybackRate(lastPlaybackRate)
  lastAppliedPlaybackRate = lastPlaybackRate
  armClock(interpolatedTime(), clockPlaying, lastPlaybackRate)
  return true
}

export const nativeSetMuted = async (muted: boolean): Promise<boolean> => {
  if (!isNativePlaybackActive()) return false
  if (muted) {
    stopVolumeFade()
    await applyMpvVolumeNow(0)
    return true
  }
  await applyMpvVolumeNow(desiredVolume)
  return true
}

export const nativeStop = async (): Promise<void> => {
  if (!isNativePlaybackAvailable()) return
  const api = mpvApi()
  stopVolumeFade()
  currentUrl = ''
  lastAppliedFilterKey = ''
  lastPlayPublished = false
  lastPausePublished = false
  filterSyncQueue = Promise.resolve()
  armClock(0, false)
  try {
    await api?.stop?.()
  } catch {}
}

export const nativeCurrentTime = (): number =>
  isNativePlaybackActive() ? interpolatedTime() : getAudioStore()?.Audio.currentTime || 0
export const nativeDuration = (): number => getAudioStore()?.Audio.duration || 0
export const nativeIsPaused = (): boolean => !getAudioStore()?.Audio.isPlay
export const lastNativeSeekAt = (): number => lastSeekAt
