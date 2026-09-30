import { ref, toRaw, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { playSetting as usePlaySetting } from '@renderer/store/playSetting'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { PlayMode, type SongList } from '@renderer/types/audio'
import { MessagePlugin } from 'tdesign-vue-next'
import defaultCoverImg from '/default-cover.png'
import mediaSessionController from '@renderer/utils/audio/useSmtc'
import {
  getSongRealUrl,
  initPlaylistEventListeners,
  destroyPlaylistEventListeners
} from '@renderer/utils/playlist/playlistManager'
import { waitForAudioReady, getCandidateSongs, verifyPlayableUrl } from './audioHelpers'
import { isSameSongCandidate } from './candidateIdentity'
import { getPreferredPlaybackQuality } from './qualityAvailability'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'
import { isPodcastProgram } from '@renderer/api/podcast'
import { isPlayableUrl } from './playableUrl'
import { crossfadeManager } from './crossfade'
import AudioManager from './audioManager'
import {
  ensureNativePlayback,
  isNativePlaybackActive,
  nativeLoad,
  nativePause,
  nativeSeek
} from './nativePlayback'

const controlAudio = ControlAudioStore()
const localUserStore = LocalUserDetailStore()
const globalPlayStatus = useGlobalPlayStatusStore()
const { Audio } = storeToRefs(controlAudio)
const { list, userInfo } = storeToRefs(localUserStore)

const songInfo = ref<Omit<SongList, 'songmid'> & { songmid: null | number | string }>({
  songmid: null,
  hash: '',
  name: '欢迎使用树夏Music 🎉',
  singer: '可以配置音源插件来播放你的歌曲',
  albumName: '',
  albumId: '0',
  source: '',
  interval: '00:00',
  img: '',
  lrc: null,
  types: [],
  _types: {},
  typeUrl: {}
})

let pendingRestorePosition = 0
let pendingRestoreSongId: number | string | null = null
let currentPlaybackErrorHandler: ((e: Event) => void) | null = null
let currentPlaybackPlayingHandler: ((e: Event) => void) | null = null
let currentPlayRequestId: number = 0

const AUTO_NEXT_DELAY_MS = 0
// 对齐安卓/落雪：播放失败后的自动跳歌延迟 5s，避免整列表烂源时瞬间刷一整轮请求
const AUTO_NEXT_ON_FAILURE_DELAY_MS = 5000
let pendingAutoNextTimer: ReturnType<typeof setTimeout> | null = null
let pendingAutoNextToken = 0

// ==================== 插件限流状态 ====================
// 当插件调用 stopRequests 时，主进程会通过 IPC 通知渲染进程。
// 限流期间：换源循环提前退出，tryAutoNext 静默放弃，不再堆 notice。
// 以 pluginId 为键，切换插件后旧插件的限流不影响新插件。
const _throttledPlugins = new Set<string>()
const _throttleTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _disabledPlugins = new Set<string>()
let _unsubscribeThrottle: (() => void) | null = null
let _unsubscribeDisabled: (() => void) | null = null

// 预加载 URL 缓存：key = `${source}:${songmid}`，playSong 消费后立即删除
const _prefetchedUrlCache = new Map<string, string>()
// 预取 URL 缓存正常靠"消费即删"回收，但极端情况下（大量跳歌、预取从未被消费）
// 可能只增不减；加一个上限做 FIFO 淘汰，防止长会话里 blob/URL 键值常驻。
const _PREFETCH_URL_CACHE_MAX = 30

type PlaybackTimingSample = {
  songId: string
  source: string
  path: string
  outcome: string
  marks: Record<string, number>
}

const PLAYBACK_TIMING_STORAGE_KEY = 'ceru_playback_timings_v1'
const PLAYBACK_TIMING_LIMIT = 40

const recordPlaybackTiming = (sample: PlaybackTimingSample) => {
  if (!import.meta.env.DEV || typeof localStorage === 'undefined') return
  try {
    const previous = JSON.parse(localStorage.getItem(PLAYBACK_TIMING_STORAGE_KEY) || '[]')
    const samples = Array.isArray(previous) ? previous : []
    samples.push({ ...sample, at: new Date().toISOString() })
    localStorage.setItem(
      PLAYBACK_TIMING_STORAGE_KEY,
      JSON.stringify(samples.slice(-PLAYBACK_TIMING_LIMIT))
    )
  } catch {}
}

function _isThrottled(): boolean {
  const pluginId = localUserStore.userSource.pluginId
  return pluginId != null && (_throttledPlugins.has(pluginId) || _disabledPlugins.has(pluginId))
}

// ==================== 音源硬失败拉黑（对齐安卓 PlaybackFallbackResolver.blockProvider） ====================
// 鉴权失败 / 额度耗尽 / 被封禁这类"确定性失败"再重试也没用，还会放大插件请求。
// 命中后拉黑该源 120s，期间换源循环直接跳过。
const HARD_SOURCE_BLOCK_MS = 120_000
const _hardBlockedSources = new Map<string, number>()

const HARD_FAILURE_PATTERN =
  /鉴权|授权|未登录|登录失效|token|cookie|额度|次数限制|上限|封禁|403|401|vip|付费|无版权|版权/i

function _isHardFailure(err: unknown): boolean {
  if (!err) return false
  const text = String((err as any)?.message || err)
  return HARD_FAILURE_PATTERN.test(text)
}

function _blockSource(source: string) {
  if (!source) return
  _hardBlockedSources.set(source, Date.now() + HARD_SOURCE_BLOCK_MS)
}

function _isSourceHardBlocked(source: string): boolean {
  const until = _hardBlockedSources.get(source)
  if (until == null) return false
  if (Date.now() >= until) {
    _hardBlockedSources.delete(source)
    return false
  }
  return true
}

// [已注释] 并行竞速 — 暂时改用顺序回退，见 tryUrlSequential
// const raceFirstValidUrl = ( ... ) => { ... }

// [已注释] 并行竞速获取可播放 URL — 暂时改用顺序回退，见 tryUrlSequential
// const findFastestUrl = async (song: SongList): Promise<{ url: string; source: string } | null> => { ... }

// ==================== 候选搜索去重缓存 ====================
// key: `${source}_${keyword}`，避免同一首歌反复请求 SDK search
const _otherSourceCache = new Map<string, SongList[]>()
const _OTHER_CACHE_MAX = 20
function _getOtherSourceCacheKey(song: SongList): string {
  return `strict-v2_${song.source}_${song.name}_${song.singer}`
}

// ==================== 持久化缓存辅助 ====================
/** 生成 SQLite URL 缓存的 Key（与主进程 service.ts 保持一致） */
function _getSongIdentity(song: Partial<SongList> | any): string {
  return String(song?.songmid || song?.hash || `${song?.name || ''}_${song?.singer || ''}`)
}

const getPlaybackQueueKey = (song: Partial<SongList> | any): string =>
  `${_getSongIdentity(song)}::${song?.source || ''}`

const getCurrentPlaybackQueueKey = (): string =>
  `${String(userInfo.value.lastPlaySongId || '')}::${userInfo.value.lastPlaySongSource || ''}`

const PLAYBACK_HISTORY_MAX = 200
const playbackHistory = ref<string[]>([])
let navigatingPlaybackHistory = false

const rememberPlayedSong = (fromKey: string, toKey: string) => {
  if (navigatingPlaybackHistory) return
  if (!fromKey || fromKey === '::' || !toKey || fromKey === toKey) return
  const last = playbackHistory.value[playbackHistory.value.length - 1]
  if (last === fromKey) return
  playbackHistory.value.push(fromKey)
  if (playbackHistory.value.length > PLAYBACK_HISTORY_MAX) {
    playbackHistory.value.splice(0, playbackHistory.value.length - PLAYBACK_HISTORY_MAX)
  }
}

const popPlaybackHistorySong = (): SongList | null => {
  while (playbackHistory.value.length > 0) {
    const prevKey = playbackHistory.value.pop()
    if (!prevKey) continue
    const song = list.value.find((item) => getPlaybackQueueKey(item) === prevKey)
    if (song && getPlaybackQueueKey(song) !== getCurrentPlaybackQueueKey()) {
      return song
    }
  }
  return null
}

function _getCacheKey(song: SongList, quality: string): string {
  const songMid = _getSongIdentity(song)
  return `${song.source}_${songMid}_${quality}`
}

const isLocalStreamProxyUrl = (url: string): boolean =>
  /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/stream\//i.test(url)

const isRemoteCleartextHttpUrl = (url: string): boolean =>
  /^http:\/\//i.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(url)

const applyPlayableUrl = async (url: string): Promise<string> => {
  // mpv loadfile 对任何字符串都返回 success，坏地址（例如只带 host 的 CDN
  // 根地址）会变成"加载成功但没声音"。在这里判死，让上层继续降级/换源。
  if (!isPlayableUrl(url)) {
    throw new Error(`不可播放的地址: ${url}`)
  }
  await ensureNativePlayback()
  const loaded = await nativeLoad(url, {
    autoplay: false,
    startTime: pendingRestorePosition > 0 ? pendingRestorePosition : 0,
    volume: Audio.value.volume,
    headers: (songInfo.value as any)?.__nativeMedia?.headers,
    referrer: (songInfo.value as any)?.__nativeMedia?.referrer || (songInfo.value as any)?.__nativeMedia?.referer,
    userAgent: (songInfo.value as any)?.__nativeMedia?.userAgent || (songInfo.value as any)?.__nativeMedia?.user_agent
  })
  if (loaded) {
    // URL 真正加载成功后不再自动消费恢复进度：保留 pendingRestorePosition，
    // 让 handlePlay 的首次播放 seek 兜底生效（对齐安卓 pendingRestorePositionMs）。
    // 仅当 pending 属于别的歌时才清掉。
    if (
      pendingRestoreSongId != null &&
      String(pendingRestoreSongId) !== String(userInfo.value.lastPlaySongId)
    ) {
      pendingRestorePosition = 0
      pendingRestoreSongId = null
    }
  } else {
    pendingRestorePosition = 0
    pendingRestoreSongId = null
    throw new Error('mpv 加载失败')
  }
  if (Audio.value.audio) {
    const a = Audio.value.audio
    try { a.pause() } catch {}
    try {
      a.removeAttribute('src')
      a.load()
    } catch {}
  }
  userInfo.value.cachedAudioUrl = url
  return url
}

const ensureWebViewPlayableUrl = async (url: string): Promise<string> => {
  return url
}

/** 从持久化缓存查询 URL */
async function _getCachedUrl(song: SongList, quality: string): Promise<string | null> {
  try {
    const key = _getCacheKey(song, quality)
    const cached = await window.api.musicUrlCache.get(key)
    if (typeof cached === 'string' && isLocalStreamProxyUrl(cached)) return null
    // 坏地址自愈：历史版本把 CDN 根地址（无路径）写进了缓存，mpv 会
    // "加载成功"但不出声。读到这种条目直接作废并让调用方重新取链。
    if (typeof cached === 'string' && cached && !isPlayableUrl(cached)) {
      await _invalidateCachedUrl(song, quality)
      return null
    }
    return cached
  } catch {
    return null
  }
}

/** 将 URL 写入持久化缓存 */
async function _setCachedUrl(song: SongList, quality: string, url: string): Promise<void> {
  try {
    // Official podcast URLs are short-lived signed links; caching them causes
    // repeated 403 -> skip loops. Keep them out of the durable URL cache.
    if (
      isLocalStreamProxyUrl(url) ||
      !isPlayableUrl(url) ||
      (song as any)?._servicePluginId ||
      isPodcastProgram(song)
    ) {
      return
    }
    const key = _getCacheKey(song, quality)
    await window.api.musicUrlCache.set(key, url)
  } catch {}
}

async function _invalidateCachedUrl(song: SongList, quality?: string): Promise<void> {
  try {
    const key = _getCacheKey(song, quality || _getQuality(song))
    await window.api.musicUrlCache.invalidate(key)
  } catch {}
}

/** 从 userInfo 中获取当前音质（与 playlistManager.getSongRealUrl 逻辑一致） */
function _getQuality(song: SongList): string {
  return getPreferredPlaybackQuality(song.source, userInfo.value)
}

// ==================== 顺序回退策略 ====================
/**
 * 顺序回退获取可播放 URL：
 * 1. 当前源 getSongRealUrl
 * 2. 失败 → 搜索候选源
 * 3. 按顺序逐个尝试候选源 getSongRealUrl
 * 4. 全部失败返回 null
 */
const tryUrlSequential = async (
  song: SongList,
  options: { failedUrls?: Set<string>; skipCurrent?: boolean } = {}
): Promise<{ url: string; song: SongList } | null> => {
  const isAllowedUrl = (url: unknown): url is string =>
    typeof url === 'string' && !!url && !url.includes('error') && !options.failedUrls?.has(url)

  // 限流期间只试主源
  if (_isThrottled()) {
    if (options.skipCurrent) return null
    try {
      const url = await getSongRealUrl(toRaw(song))
      if (isAllowedUrl(url)) {
        void _setCachedUrl(song, _getQuality(song), url)
        return { url, song }
      }
      if (url && typeof url === 'string') {
        options.failedUrls?.add(url)
        await _invalidateCachedUrl(song)
      }
    } catch {}
    return null
  }

  // 1. 当前源（被硬失败拉黑的源直接跳过，对齐安卓 blockProvider 120s）
  if (!options.skipCurrent && !_isSourceHardBlocked(String(song.source || ''))) {
    try {
      const url = await getSongRealUrl(toRaw(song))
      if (isAllowedUrl(url)) {
        void _setCachedUrl(song, _getQuality(song), url)
        return { url, song }
      }
      if (url && typeof url === 'string') {
        options.failedUrls?.add(url)
        await _invalidateCachedUrl(song)
        if (_isHardFailure(url)) _blockSource(String(song.source || ''))
      }
    } catch (err) {
      if (_isHardFailure(err)) _blockSource(String(song.source || ''))
    }
  }

  // 官方播客只走官方取链，失败后不要搜音乐候选源，否则会把节目当歌乱跳。
  if (isPodcastProgram(song)) return null

  if (_isThrottled()) return null

  // 2. 搜索候选
  const cacheKey = _getOtherSourceCacheKey(song)
  let candidates = _otherSourceCache.get(cacheKey)
  if (!candidates) {
    try {
      candidates = await getCandidateSongs(song, userInfo.value, {
        silent: true,
        lightweight: true,
        sourceTimeoutMs: 2500
      })
      if (candidates && candidates.length > 0) {
        _otherSourceCache.set(cacheKey, candidates)
        if (_otherSourceCache.size > _OTHER_CACHE_MAX) {
          const firstKey = _otherSourceCache.keys().next().value
          if (firstKey !== undefined) _otherSourceCache.delete(firstKey)
        }
      }
    } catch {
      return null
    }
  }
  if (!candidates || candidates.length === 0) return null

  // 3. 逐个尝试候选源（顺序回退），被硬失败拉黑的源直接跳过
  const quality = _getQuality(song)
  for (const item of candidates) {
    if (_isThrottled()) return null
    if (_isSourceHardBlocked(String(item.source || ''))) continue
    if (!isSameSongCandidate(item, song)) continue
    try {
      const url = await getSongRealUrl(toRaw(item))
      if (isAllowedUrl(url) && (await verifyPlayableUrl(url))) {
        // 成功后将 URL 同时缓存在主进程
        _setCachedUrl(item, quality, url)
        return { url, song: item }
      }
      if (url && typeof url === 'string') {
        options.failedUrls?.add(url)
        await _invalidateCachedUrl(item, quality)
        if (_isHardFailure(url)) _blockSource(String(item.source || ''))
      }
    } catch (err) {
      if (_isHardFailure(err)) _blockSource(String(item.source || ''))
    }
  }

  return null
}

const setUrl = controlAudio.setUrl
const start = controlAudio.start
const stop = controlAudio.stop
const setCurrentTime = controlAudio.setCurrentTime

const cancelPendingAutoNext = () => {
  pendingAutoNextToken++
  if (pendingAutoNextTimer !== null) {
    clearTimeout(pendingAutoNextTimer)
    pendingAutoNextTimer = null
  }
}

const applyCurrentSongInfo = (song: SongList) => {
  const currentSong = {
    ...song,
    lrc: song.lrc ?? null,
    types: song.types || [],
    _types: song._types || {},
    typeUrl: song.typeUrl || {}
  } as SongList

  songInfo.value = currentSong
  // Keep the renderer's canonical playback state in lockstep with the source
  // that actually produced the audio URL. This avoids stale list entries making
  // download/quality UI read the previous provider after automatic fallback.
  globalPlayStatus.updatePlayerInfo(currentSong)
  userInfo.value.lastPlaySongId =
    currentSong.songmid || currentSong.hash || `${currentSong.name}_${currentSong.singer}`
  userInfo.value.lastPlaySongSource = currentSong.source
}

const replaceCurrentSongInList = (previousSong: SongList, nextSong: SongList) => {
  const previousIdentity = _getSongIdentity(previousSong)
  const index = list.value.findIndex(
    (item) => _getSongIdentity(item) === previousIdentity && item.source === previousSong.source
  )
  if (index !== -1) {
    const next = [...list.value]
    next.splice(index, 1, nextSong)
    list.value = next
    return
  }
  const nextIdentity = _getSongIdentity(nextSong)
  const existingIndex = list.value.findIndex(
    (item) => _getSongIdentity(item) === nextIdentity && item.source === nextSong.source
  )
  if (existingIndex === -1) {
    list.value = [nextSong, ...list.value]
  }
}

const PluginErrorMsgs = [
  '插件都不配就想播放，想的倒挺美呢',
  '插件插件老弟我需要插件',
  '我肚子饿啦，请给我安装一个插件吧',
  '插件呢？插件呢？插件呢？',
  '哥哥~ 你需要安装一个插件来播放歌曲哦~'
]

/**
 * 异步取一起听 store —— 用动态 import 避免循环依赖
 *
 * ListenTogether store 内部也动态 import 本文件;静态 import 会导致循环。
 * 顶层声明后,handlePlay/handlePause/playSong 等都能在房间内分流到 lt.* 命令。
 *
 * 同时缓存一份同步引用 `cachedLtStore`,供 seekTo 等同步路径使用 ——
 * 第一次成功取到后即缓存,后续调用立即可用。
 */
let cachedLtStore: any = null
const getListenTogetherStore = async () => {
  if (cachedLtStore) return cachedLtStore
  const { useListenTogetherStore } = await import('@renderer/store')
  cachedLtStore = useListenTogetherStore()
  return cachedLtStore
}

const handlePlay = async () => {
  cancelPendingAutoNext()
  /* 一起听:在房间且有控制权 → 发命令给服务端,不本地播放;
   * 服务端 SYNC 回来后 ensureRoomSongLoadedAndSynced/applySnapshot 驱动本地 audio。
   * 无控制权 → 提示并 return,避免与远端状态打架。 */
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    if (lt.canControl) {
      lt.play()
    } else {
      MessagePlugin.warning('当前在一起听房间中,无播放控制权')
    }
    return
  }
  if (!Audio.value.url) {
    if (list.value.length > 0) {
      const lastId = userInfo.value.lastPlaySongId
      const lastSource = userInfo.value.lastPlaySongSource
      const target =
        (lastId != null &&
          list.value.find(
            (s) => String(_getSongIdentity(s)) === String(lastId) && (!lastSource || s.source === lastSource)
          )) ||
        list.value[0]
      await playSong(target)
    } else {
      MessagePlugin.warning('播放列表为空，请先添加歌曲')
    }
    return
  }
  try {
    if (
      pendingRestorePosition > 0 &&
      String(pendingRestoreSongId) === String(userInfo.value.lastPlaySongId)
    ) {
      if (Audio.value.audio && !isNativePlaybackActive()) {
        await waitForAudioReady(Audio.value.audio)
      }
      setCurrentTime(pendingRestorePosition)
      if (isNativePlaybackActive()) {
        await nativeSeek(pendingRestorePosition)
      } else if (Audio.value.audio) {
        Audio.value.audio.currentTime = pendingRestorePosition
      }
      pendingRestorePosition = 0
      pendingRestoreSongId = null
    }
    const startResult = start()
    if (startResult && typeof (startResult as any).then === 'function') {
      await startResult
    }
    userInfo.value.wasPlaying = true
    mediaSessionController.updatePlaybackState('playing')
  } catch (error) {
    MessagePlugin.error('播放失败，请重试')
  }
}

const handlePause = async () => {
  cancelPendingAutoNext()
  /* 一起听:在房间且有控制权 → 发命令,不直接 stop 本地 */
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    if (lt.canControl) {
      lt.pause()
    }
    return
  }
  const a = Audio.value.audio
  if (Audio.value.url && a && Audio.value.isPlay) {
    const stopResult = stop()
    if (stopResult && typeof (stopResult as any).then === 'function') {
      await stopResult
    }
    userInfo.value.wasPlaying = false
    mediaSessionController.updatePlaybackState('paused')
  } else if (Audio.value.url) {
    userInfo.value.wasPlaying = false
    mediaSessionController.updatePlaybackState('paused')
  }
  // 对齐安卓 persistPlaybackState(force=true)：手动暂停时立即把当前进度写盘，
  // 否则暂停听歌后重启会恢复到上一次 tick 的旧进度甚至 0。
  persistPlaybackPosition(true)
}

const togglePlayPause = async () => {
  /* 一起听:在房间且有控制权时,以"本地 audio 实际状态"判断按钮意图。
   *
   * 不能用 lt.current.isPlaying —— 那是服务端权威状态,在以下情形会与本地音频
   * 不一致,导致按一次暂停按钮变成发 play 命令,自己不暂停:
   *  - SYNC 应用失败(浏览器拒绝 play()/pause())
   *  - 网络抖动期间状态短暂落后
   *  - 漂移校准窗口
   * 用户的意图永远是"我看到的状态的反面",所以以本地 audio.paused 为准最靠谱。 */
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    if (!lt.canControl) {
      MessagePlugin.warning('当前在一起听房间中,无播放控制权')
      return
    }
    const a = Audio.value.audio
    const localPlaying = a ? !a.paused : Audio.value.isPlay
    if (localPlaying) {
      lt.pause()
    } else {
      lt.play()
    }
    return
  }
  const isActuallyPlaying = Audio.value.isPlay
  if (isActuallyPlaying) {
    await handlePause()
  } else {
    await handlePlay()
  }
}

const playSong = async (
  song: SongList,
  options: { immediate?: boolean; shouldAutoStart?: () => boolean } = {}
) => {
  const playbackTimingStartedAt = performance.now()
  const playbackTimingMarks: Record<string, number> = { entry: 0 }
  let playbackTimingPath = 'network'
  let playbackTimingFlushed = false
  const markPlaybackTiming = (name: string) => {
    playbackTimingMarks[name] = Math.round(performance.now() - playbackTimingStartedAt)
  }
  const flushPlaybackTiming = (outcome: string) => {
    if (playbackTimingFlushed || currentPlayRequestId !== requestId) return
    playbackTimingFlushed = true
    recordPlaybackTiming({
      songId: String(song.songmid || song.hash || ''),
      source: String(song.source || ''),
      path: playbackTimingPath,
      outcome,
      marks: { ...playbackTimingMarks }
    })
  }
  cancelPendingAutoNext()
  // 用户主动切歌，取消可能正在进行的无感过渡
  crossfadeManager.cancel()

  /* 一起听守卫与路由
   *
   * 三种情形:
   *  1. 房间内、有控制权(host/admin)、song != current.song
   *     → host 立即本地播放(不等 SYNC),同时 markLocalLoadingSong 防止 SYNC 回声
   *     触发再次加载。URL 取到后通过 lt.changeSong 携带广播给 member,member 直接
   *     setUrl 跳过自己的 getSongRealUrl(节省 ~1-2 秒)。
   *  2. 房间内、song == current.song
   *     → 这次调用源自 ensureRoomSongLoadedAndSynced 的远端同步,放行进入实际加载逻辑。
   *  3. 房间内、无控制权、song != current.song
   *     → 提示并 return,member 不能自己切歌。
   */
  let isHostInitiatedChange = false
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    const remoteSongmid = lt.current.song?.songmid
    const remoteSource = lt.current.song?.source
    const isApplyingRemoteSync =
      remoteSongmid !== undefined &&
      String(remoteSongmid) === String(song.songmid) &&
      remoteSource === song.source

    if (!isApplyingRemoteSync) {
      if (!lt.canControl) {
        /* member 点歌:提交审批 + 提示,不动本地 list/audio。
         * 服务端把请求加入 pending,广播 PENDING_UPDATE,管理员可在 PendingPanel 审批。 */
        lt.requestSong({
          songmid: String(song.songmid),
          source: song.source,
          name: song.name,
          singer: song.singer,
          cover: song.img,
          albumName: song.albumName,
          albumId: song.albumId !== undefined ? String(song.albumId) : undefined,
          hash: song.hash,
          types: song.types,
          lrc: song.lrc ?? null
        })
        MessagePlugin.success(`已提交点歌《${song.name || '?'}》,等待管理员审核`)
        return
      }
      /* 标记本地加载,防止后续 server SYNC 在 audio.src 暂时清空时被
       * ensureRoom 误判需要"重新加载"导致死循环 */
      lt.markLocalLoadingSong(song.source, String(song.songmid))
      isHostInitiatedChange = true
      /* 用户主动切歌:跳过 300ms 防抖等待,直接进入加载 ——
       * currentPlayRequestId 已经能处理连点(后续 playSong 会覆盖 requestId 让前面 return),
       * 这里的 sleep(300) 是早期为防误触加的,在房间内是 8s+ 体感延迟的主要来源之一。 */
      options.immediate = true
      /* 不 return —— host 直接走下面的本地加载播放流程 */
    }
  }

  /* 拿到有效 URL 后调用,把切歌意图 + URL 一起广播给 member ——
   * 让 member 跳过自己的 getSongRealUrl(节省 ~1-2 秒)。
   * 单次触发(broadcastedChange flag),candidates 换源场景下用最终成功的 URL。 */
  let broadcastedChange = false
  const broadcastChangeSongIfNeeded = (urlToBroadcast: string): void => {
    if (!isHostInitiatedChange || broadcastedChange) return
    if (!urlToBroadcast || urlToBroadcast.includes('error')) return
    broadcastedChange = true
    lt.changeSong({
      songmid: String(song.songmid),
      source: song.source,
      name: song.name,
      singer: song.singer,
      cover: song.img,
      albumName: song.albumName,
      albumId: song.albumId !== undefined ? String(song.albumId) : undefined,
      hash: song.hash,
      types: song.types,
      lrc: song.lrc ?? null,
      url: urlToBroadcast
    })
  }

  // 使用当前时间戳作为请求ID，解决快速切歌的竞态问题
  const requestId = Date.now()
  // songInfo 上不存在 requestId 属性，移除该行；requestId 仅通过闭包变量跟踪即可

  // 更好的方式：使用闭包变量跟踪是否是最新请求
  // 但是 playSong 是 async 的，我们需要在关键的 await 之后检查

  // 更新全局的 currentPlayRequestId
  currentPlayRequestId = requestId

  if (!options.immediate) {
    // 防抖：给一个短暂的缓冲期，避免连续快速点击导致并发请求错误
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (currentPlayRequestId !== requestId) return
  }
  markPlaybackTiming('after-debounce')

  try {
    isLoadingSong.value = true
    // 清理之前的监听器
    if (Audio.value.audio) {
      if (currentPlaybackErrorHandler) {
        Audio.value.audio.removeEventListener('error', currentPlaybackErrorHandler)
        currentPlaybackErrorHandler = null
      }
      if (currentPlaybackPlayingHandler) {
        Audio.value.audio.removeEventListener('playing', currentPlaybackPlayingHandler)
        currentPlaybackPlayingHandler = null
      }
    }

    const isHistoryPlay =
      song.songmid === userInfo.value.lastPlaySongId &&
      song.source === userInfo.value.lastPlaySongSource &&
      userInfo.value.currentTime !== undefined &&
      userInfo.value.currentTime > 0
    if (isHistoryPlay && userInfo.value.currentTime !== undefined) {
      pendingRestorePosition = userInfo.value.currentTime
      pendingRestoreSongId = song.songmid
      userInfo.value.currentTime = 0
    } else {
      pendingRestorePosition = 0
      pendingRestoreSongId = null
    }
    const previousQueueKey = getCurrentPlaybackQueueKey()
    rememberPlayedSong(previousQueueKey, getPlaybackQueueKey(song))
    if (Audio.value.isPlay) {
      Audio.value.isPlay = false
      if (isNativePlaybackActive()) {
        try { await nativePause({ fade: false }) } catch {}
      } else if (Audio.value.audio) {
        Audio.value.audio.pause()
        Audio.value.audio.volume = Audio.value.volume / 100
      }
    }

    // 如果切歌了，这里先不更新 UI，等真正开始获取 URL 了再说？
    // 不，UI 应该立即响应。
    applyCurrentSongInfo(song)
    // 进度条立即归零，不等 URL 获取完成
    setCurrentTime(0)
    // 注意：SMTC 的 updateMetadata 会在音频准备好后再调用，避免切换时空隙

    let urlToPlay = ''
    const failedUrls = new Set<string>()
    // 检查预加载缓存（内存，来自 prefetchNextTrack）
    const _cacheKey = `${song.source}:${song.songmid}`
    const _cachedUrl = _prefetchedUrlCache.get(_cacheKey)
    if (_cachedUrl) {
      _prefetchedUrlCache.delete(_cacheKey)
      // Align Electron: only trust a cached URL after a quick playability probe.
      // Podcast official URLs expire quickly; a shape-only check would keep replaying 403 links.
      if (isPlayableUrl(_cachedUrl)) {
        urlToPlay = _cachedUrl
        playbackTimingPath = 'prefetch'
        markPlaybackTiming('url-resolved')
      } else {
        failedUrls.add(_cachedUrl)
      }
    }

    // 检查持久化缓存（SQLite），命中即零网络
    // Podcasts always refresh from the official API; never reuse durable URL cache.
    if (!urlToPlay && !isPodcastProgram(song)) {
      const quality = _getQuality(song)
      const sqliteCachedUrl = await _getCachedUrl(song, quality)
      if (
        sqliteCachedUrl &&
        typeof sqliteCachedUrl === 'string' &&
        !sqliteCachedUrl.includes('error') &&
        !failedUrls.has(sqliteCachedUrl) &&
        isPlayableUrl(sqliteCachedUrl)
      ) {
        urlToPlay = sqliteCachedUrl
        playbackTimingPath = 'url-cache'
        markPlaybackTiming('url-resolved')
      } else if (sqliteCachedUrl && typeof sqliteCachedUrl === 'string') {
        failedUrls.add(sqliteCachedUrl)
        await _invalidateCachedUrl(song, quality)
      }
    }

    if (!urlToPlay) {
      // 顺序回退：当前源 → 搜候选 → 逐个试 URL
      markPlaybackTiming('url-request-start')
      const result = await tryUrlSequential(song, { failedUrls })
      if (currentPlayRequestId !== requestId) return
      if (result) {
        urlToPlay = result.url
        playbackTimingPath = result.song.source !== song.source ? 'cross-source' : 'network'
        markPlaybackTiming('url-resolved')
        if (result.song.source !== song.source) {
          replaceCurrentSongInList(song, result.song)
          applyCurrentSongInfo(result.song)
          song = result.song
          MessagePlugin.success(`已自动切换到 ${result.song.source} 源播放`)
        }
      }
    }
    if (currentPlayRequestId !== requestId) return

    // URL 可用 → 统一播放逻辑
    if (urlToPlay && !urlToPlay.includes('error')) {
      void _setCachedUrl(song, _getQuality(song), urlToPlay)
      urlToPlay = await applyPlayableUrl(urlToPlay)
      if (currentPlayRequestId !== requestId) return
      markPlaybackTiming('src-set')
      try {
        if (Audio.value.audio && !isNativePlaybackActive()) {
          await waitForAudioReady(Audio.value.audio)
          markPlaybackTiming('audio-ready')
        } else if (isNativePlaybackActive()) {
          markPlaybackTiming('audio-ready')
        }
        if (currentPlayRequestId !== requestId) return
        /* 一起听:audio ready 之后再广播 */
        broadcastChangeSongIfNeeded(urlToPlay)
      } catch (e) {
        if (currentPlayRequestId !== requestId) return
        // 原源 URL 获取成功但播放/加载失败
        console.warn('Audio ready failed, trying auto switch...', e)
        failedUrls.add(urlToPlay)
        // 分步自愈：刷新当前源 URL 一次，不行再试候选
        let refreshed = false
        try {
          const newUrl = await getSongRealUrl(toRaw(song))
          if (newUrl && typeof newUrl === 'string' && !newUrl.includes('error') && newUrl !== urlToPlay && !failedUrls.has(newUrl) && (await verifyPlayableUrl(newUrl))) {
            refreshed = true
            const playableNewUrl = await applyPlayableUrl(newUrl)
            if (Audio.value.audio && !isNativePlaybackActive()) {
              await waitForAudioReady(Audio.value.audio)
              if (currentPlayRequestId !== requestId) return
              broadcastChangeSongIfNeeded(playableNewUrl)
            } else if (isNativePlaybackActive()) {
              if (currentPlayRequestId !== requestId) return
              broadcastChangeSongIfNeeded(playableNewUrl)
            }
          }
        } catch {}
        if (!refreshed) {
          // 官方播客不走音乐候选换源
          if (isPodcastProgram(song)) throw e
          // 候选顺序回退
          try {
            const candidates = await getCandidateSongs(song, userInfo.value, { lightweight: true, silent: true })
            if (currentPlayRequestId !== requestId) return
            let switched = false
            for (const item of candidates) {
              if (currentPlayRequestId !== requestId) return
              if (!isSameSongCandidate(item, song)) continue
              try {
                const url = await getSongRealUrl(toRaw(item))
                if (url && typeof url === 'string' && !url.includes('error') && url !== urlToPlay && !failedUrls.has(url) && (await verifyPlayableUrl(url))) {
                  switched = true
                  const playableCandidateUrl = await applyPlayableUrl(url)
                  if (Audio.value.audio && !isNativePlaybackActive()) {
                    await waitForAudioReady(Audio.value.audio)
                  }
                  if (currentPlayRequestId !== requestId) return
                  replaceCurrentSongInList(song, item)
                  applyCurrentSongInfo(item)
                  broadcastChangeSongIfNeeded(playableCandidateUrl)
                  MessagePlugin.success(`已自动切换到 ${item.source} 源播放`)
                  mediaSessionController.updateMetadata({
                    title: item.name,
                    artist: item.singer,
                    album: item.albumName || '未知专辑',
                    artworkUrl: item.img || defaultCoverImg
                  }, item)
                  break
                }
              } catch {}
            }
            if (!switched) throw e
          } catch (switchError) {
            if (currentPlayRequestId !== requestId) return
            throw switchError
          }
        }
      }
    } else {
      isLoadingSong.value = false
      tryAutoNext('自动换源失败：所有源均无法播放')
      flushPlaybackTiming('url-failed')
      return
    }

    if (currentPlayRequestId !== requestId) return

    // 音频已就绪后再更新 SMTC，避免切换时空隙
    mediaSessionController.updateMetadata({
      title: song.name,
      artist: song.singer,
      album: song.albumName || '未知专辑',
      artworkUrl: song.img || defaultCoverImg
    }, song)
    isLoadingSong.value = false
    if (options.shouldAutoStart && !options.shouldAutoStart()) {
      mediaSessionController.updatePlaybackState('paused')
      return
    }
    // 音频即将播放前尝试恢复 AudioContext，避免后台挂起导致无声
    if (Audio.value.audio && !isNativePlaybackActive()) {
      AudioManager.resumeContext(Audio.value.audio)
    }
    markPlaybackTiming('play-called')
    const playbackStart = start()
    if (playbackStart && typeof (playbackStart as any).then === 'function') {
      ;(playbackStart as Promise<any>)
        .then(() => markPlaybackTiming('play-resolved'))
        .catch(() => {})
    }
    playbackStart
      .catch(async () => {
        if (currentPlayRequestId !== requestId) return
        failedUrls.add(urlToPlay)
        const fallback = await tryUrlSequential(song, { failedUrls, skipCurrent: true })
        if (currentPlayRequestId !== requestId) return
          if (fallback && fallback.url !== urlToPlay) {
            if (fallback.song.source !== song.source) {
              replaceCurrentSongInList(song, fallback.song)
              applyCurrentSongInfo(fallback.song)
              MessagePlugin.success(`已自动切换到 ${fallback.song.source} 源播放`)
            }
            await applyPlayableUrl(fallback.url)
            start().catch(async () => {
              if (currentPlayRequestId !== requestId) return
              failedUrls.add(fallback.url)
              const nextFallback = await tryUrlSequential(song, { failedUrls, skipCurrent: true })
            if (currentPlayRequestId !== requestId) return
            if (nextFallback && nextFallback.url !== fallback.url) {
              if (nextFallback.song.source !== song.source) {
                replaceCurrentSongInList(song, nextFallback.song)
                applyCurrentSongInfo(nextFallback.song)
                MessagePlugin.success(`已自动切换到 ${nextFallback.song.source} 源播放`)
              }
              await applyPlayableUrl(nextFallback.url)
              start().catch(() => {
                if (currentPlayRequestId !== requestId) return
                tryAutoNext('所有源均无法播放')
              })
              return
            }
            tryAutoNext('所有源均无法播放')
          })
          return
        }
        tryAutoNext('所有源均无法播放')
      })
    // 启动后预加载下一首到副槽（无感过渡准备），失败静默忽略
    if (!isNativePlaybackActive()) {
      void prefetchNextTrack()
    }

    // 只有在确定是当前请求时，才挂载错误监听
    currentPlaybackPlayingHandler = () => {
      markPlaybackTiming('playing')
      flushPlaybackTiming('playing')
      isLoadingSong.value = false
      currentPlaybackPlayingHandler = null
      autoNextCount.value = 0
    }
    if (Audio.value.audio && !isNativePlaybackActive()) {
      Audio.value.audio.addEventListener('playing', currentPlaybackPlayingHandler, { once: true })
    }
    currentPlaybackErrorHandler = async () => {
        if (currentPlayRequestId === requestId) {
          markPlaybackTiming('play-error')
          flushPlaybackTiming('play-error')
        }
        // 如果触发了 error，也要检查是不是当前这首歌的 error
        // 其实 error listener 是一次性的，并且每次 playSong 开头都会清理
        // 所以理论上只要 playSong 没被新的打断，这个 listener 就是有效的。
        // 但如果快速切歌，旧的 playSong 可能还在运行，挂载了 listener，
        // 然后新的 playSong 运行，清理了 listener。
        //
        // 现在的逻辑是：只有 playSong 走到最后才会挂载 listener。
        // 由于我们加了 currentPlayRequestId check，旧的 playSong 即使没执行完，
        // 只要遇到 await 就会停止，不会走到最后挂载 listener。
        //
        // 唯一的问题是：如果旧的 playSong 已经挂载了 listener，然后新的 playSong 开始了，
        // 新的 playSong 会清理旧的 listener。
        // 所以这里不需要额外的 check，只要保证 playSong 中途退出即可。

        console.warn('Playback error, trying staged recovery...')
        currentPlaybackErrorHandler = null
        if (Audio.value.audio?.src) failedUrls.add(Audio.value.audio.src)
        if (urlToPlay) failedUrls.add(urlToPlay)

        if (_isThrottled()) return

        // Stage 1: 刷新当前 URL（可能只是临时 CDN 抖动）
        try {
          const refreshedUrl = await getSongRealUrl(toRaw(song))
          if (currentPlayRequestId !== requestId) return
          if (refreshedUrl && typeof refreshedUrl === 'string' && !refreshedUrl.includes('error') && !failedUrls.has(refreshedUrl) && (await verifyPlayableUrl(refreshedUrl))) {
            const playableRefreshedUrl = await applyPlayableUrl(refreshedUrl)
            if (isNativePlaybackActive() || (Audio.value.audio && Audio.value.audio.src !== playableRefreshedUrl)) {
              if (Audio.value.audio && !isNativePlaybackActive()) {
                await waitForAudioReady(Audio.value.audio)
              }
              if (currentPlayRequestId !== requestId) return
              if (options.shouldAutoStart && !options.shouldAutoStart()) {
                mediaSessionController.updatePlaybackState('paused')
                return
              }
              start().catch(async () => {
                if (currentPlayRequestId !== requestId) return
                failedUrls.add(refreshedUrl)
                const fallback = await tryUrlSequential(song, { failedUrls, skipCurrent: true })
                if (currentPlayRequestId !== requestId) return
                if (fallback && fallback.url !== refreshedUrl) {
                  if (fallback.song.source !== song.source) {
                    replaceCurrentSongInList(song, fallback.song)
                    applyCurrentSongInfo(fallback.song)
                    MessagePlugin.success(`已自动切换到 ${fallback.song.source} 源播放`)
                  }
                  await applyPlayableUrl(fallback.url)
                  start().catch(() => {
                    if (currentPlayRequestId !== requestId) return
                    tryAutoNext('所有自动换源尝试均失败')
                  })
                  return
                }
                tryAutoNext('所有自动换源尝试均失败')
              })
              return
            }
          }
        } catch {}
        if (currentPlayRequestId !== requestId) return

        // Stage 2: 候选顺序回退
        if (_isThrottled()) return
        try {
          const candidates = await getCandidateSongs(song, userInfo.value)
          if (currentPlayRequestId !== requestId) return
          if (_isThrottled()) return

          for (const item of candidates) {
            if (currentPlayRequestId !== requestId) return
            if (!isSameSongCandidate(item, song)) continue
            try {
              const url = await getSongRealUrl(toRaw(item))
              if (url && typeof url === 'string' && !url.includes('error') && !failedUrls.has(url) && (await verifyPlayableUrl(url))) {
                if (!isNativePlaybackActive() && Audio.value.audio && Audio.value.audio.src === url) {
                  isLoadingSong.value = false
                  tryAutoNext('所有自动换源尝试均失败')
                  return
                }
                const playableCandidateUrl = await applyPlayableUrl(url)
                if (Audio.value.audio && !isNativePlaybackActive()) {
                  await waitForAudioReady(Audio.value.audio)
                }
                if (currentPlayRequestId !== requestId) return
                replaceCurrentSongInList(song, item)
                applyCurrentSongInfo(item)
                MessagePlugin.success(`已自动切换到 ${item.source} 源播放`)
                if (options.shouldAutoStart && !options.shouldAutoStart()) {
                  mediaSessionController.updatePlaybackState('paused')
                  return
                }
                start().catch(async () => {
                    if (currentPlayRequestId !== requestId) return
                    failedUrls.add(playableCandidateUrl)
                    const fallback = await tryUrlSequential(song, { failedUrls, skipCurrent: true })
                    if (currentPlayRequestId !== requestId) return
                    if (fallback && fallback.url !== url) {
                      if (fallback.song.source !== song.source) {
                        replaceCurrentSongInList(song, fallback.song)
                        applyCurrentSongInfo(fallback.song)
                        MessagePlugin.success(`已自动切换到 ${fallback.song.source} 源播放`)
                      }
                      await applyPlayableUrl(fallback.url)
                      start().catch(() => {
                        if (currentPlayRequestId !== requestId) return
                        tryAutoNext('所有自动换源尝试均失败')
                      })
                      return
                    }
                    tryAutoNext('所有自动换源尝试均失败')
                  })
                return // 成功
              }
            } catch {}
          }
          // 所有候选都失败
          isLoadingSong.value = false
          tryAutoNext('所有自动换源尝试均失败')
        } catch (e) {
          if (currentPlayRequestId !== requestId) return
          isLoadingSong.value = false
          tryAutoNext('候选搜索失败')
        }
    }
    if (Audio.value.audio && !isNativePlaybackActive()) {
      Audio.value.audio.addEventListener('error', currentPlaybackErrorHandler, { once: true })
    }
  } catch (error: any) {
    if (currentPlayRequestId !== requestId) return
    flushPlaybackTiming('failed')
    tryAutoNext('播放歌曲失败')
    isLoadingSong.value = false
  } finally {
    // 只有当前请求才能关闭 loading
    if (currentPlayRequestId === requestId) {
      isLoadingSong.value = false
    }
    /* 一起听:无论成功/失败/cancel,清掉本地加载标记。
     * 用 IfMatch 版避免误清:用户连续切歌时前一次 finally 不应清掉后一次刚标记的 key。
     * 若 broadcastedChange=false 说明 URL 全部解析失败,playSong 会走 tryAutoNext,
     * 此时不广播 changeSong —— 让 host 自己跳过的歌不污染房间状态。 */
    if (isHostInitiatedChange) {
      lt.clearLocalLoadingSongIfMatch(song.source, String(song.songmid))
    }
  }
}

let lastPlaybackErrorNotice = { text: '', at: 0 }

const isLongProgramSong = (song: Partial<SongList> | any): boolean => {
  if (isPodcastProgram(song)) return true
  const seconds = parseIntervalSeconds(String(song?.interval || ''))
  if (seconds < 20 * 60) return false
  if (song?.source === 'kw') return true
  const text = `${song?.name || ''} ${song?.albumName || ''}`
  return /播客|博客|节目|电台|有声|期|月刊|周刊|访谈|脱口秀/.test(text)
}

const buildPlaybackFailureMessage = (reason: string): string => {
  if (isLongProgramSong(songInfo.value)) {
    return `当前节目无法播放：播放地址可能已过期，或当前插件暂不支持解析该节目。原因：${reason}`
  }
  return `当前歌曲无法播放：${reason}`
}

const showPlaybackError = (text: string): void => {
  const now = Date.now()
  if (lastPlaybackErrorNotice.text === text && now - lastPlaybackErrorNotice.at < 1800) return
  lastPlaybackErrorNotice = { text, at: now }
  MessagePlugin.error(text)
}

const tryAutoNext = (reason: string) => {
  const failureMessage = buildPlaybackFailureMessage(reason)
  if (
    localUserStore.userSource.pluginId === undefined ||
    _isThrottled() ||
    reason.includes('频率') ||
    reason.includes('限制')
  ) {
    showPlaybackError(failureMessage)
    return
  }
  if (list.value.length <= 1 || playMode.value === PlayMode.SINGLE || isLongProgramSong(songInfo.value)) {
    showPlaybackError(failureMessage)
    return
  }
  const limit = getAutoNextLimit()
  showPlaybackError(`自动跳过当前歌曲：原因：${reason}`)
  // 对齐 Electron：允许有限次自动跳过，但不是无限连跳。
  // 前 2 次失败可继续尝试；达到 limit 或 10 次后停下。
  if ((autoNextCount.value >= limit || autoNextCount.value >= 10) && autoNextCount.value > 2) {
    showPlaybackError(
      `自动下一首失败：${autoNextCount.value}/${limit > 10 ? 10 : limit}次。原因：${reason}`
    )
    return
  }
  autoNextCount.value++
  // 对齐安卓 AUTO_NEXT_DELAY_MS = 5000：失败跳歌前留 5s，让用户看到提示，
  // 也避免整列表烂源时瞬间刷一整轮插件请求。
  const token = ++pendingAutoNextToken
  pendingAutoNextTimer = setTimeout(() => {
    if (token !== pendingAutoNextToken) return
    pendingAutoNextTimer = null
    void playNext()
  }, AUTO_NEXT_ON_FAILURE_DELAY_MS)
}

const playMode = ref(userInfo.value.playMode || PlayMode.SEQUENCE)
const isLoadingSong = ref(false)
const autoNextCount = ref(0)
const getAutoNextLimit = () => Math.max(1, Math.floor(list.value.length * 0.3))

const parseIntervalSeconds = (interval: string): number => {
  if (!interval) return 0
  const parts = interval.split(':')
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1])
  }
  return parseInt(interval) || 0
}

const shuffleOrder = ref<Array<number | string>>([])
const getCurrentSongIndex = (): number => {
  const currentKey = getCurrentPlaybackQueueKey()
  if (currentKey !== '::') {
    const index = list.value.findIndex((song) => getPlaybackQueueKey(song) === currentKey)
    if (index !== -1) return index
  }
  const currentId = String(userInfo.value.lastPlaySongId || '')
  if (!currentId) return -1
  return list.value.findIndex((song) => _getSongIdentity(song) === currentId)
}

const buildShuffleOrder = () => {
  const ids = list.value.map((s) => getPlaybackQueueKey(s))
  // Fisher-Yates
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
  }
  shuffleOrder.value = ids
}

const isShuffleOrderValid = () => {
  if (shuffleOrder.value.length !== list.value.length) return false
  const listIds = list.value.map((song) => getPlaybackQueueKey(song))
  const shuffleIds = new Set(shuffleOrder.value)
  return listIds.every((id) => shuffleIds.has(id))
}

const ensureShuffleOrder = (rebuild = false) => {
  if (list.value.length === 0) {
    shuffleOrder.value = []
    return
  }
  if (rebuild || !isShuffleOrderValid()) {
    buildShuffleOrder()
  }
}

watch(
  () => playMode.value,
  (mode) => {
    if (mode === PlayMode.RANDOM) {
      ensureShuffleOrder()
      return
    }
    shuffleOrder.value = []
  }
)

watch(
  () => list.value,
  () => {
    if (playMode.value === PlayMode.RANDOM) {
      ensureShuffleOrder(true)
    }
  },
  { deep: true }
)

const updatePlayMode = () => {
  const modes = [PlayMode.SEQUENCE, PlayMode.RANDOM, PlayMode.SINGLE]
  const currentIndex = modes.indexOf(playMode.value)
  const nextIndex = (Math.max(currentIndex, -1) + 1) % modes.length
  playMode.value = modes[nextIndex]
  userInfo.value.playMode = playMode.value
}

const resolveNextSong = async ({
  respectSingleMode,
  rebuildShuffleOnWrap
}: {
  respectSingleMode: boolean
  rebuildShuffleOnWrap: boolean
}): Promise<SongList | null> => {
  if (list.value.length === 0) return null
  if (respectSingleMode && playMode.value === PlayMode.SINGLE) return null

  if (playMode.value === PlayMode.RANDOM) {
    ensureShuffleOrder()
    const curKey = getCurrentPlaybackQueueKey()
    let idx = shuffleOrder.value.findIndex((id) => id === curKey)
    if (idx < 0) idx = -1
    let nextIdx = idx + 1
    if (nextIdx >= shuffleOrder.value.length) {
      if (rebuildShuffleOnWrap) {
        ensureShuffleOrder(true)
      }
      nextIdx = 0
    }
    const nextKey = shuffleOrder.value[nextIdx]
    return list.value.find((s) => getPlaybackQueueKey(s) === nextKey) || null
  }

  const currentIndex = getCurrentSongIndex()
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % list.value.length
  return list.value[nextIndex] || null
}

/**
 * 计算下一首歌曲（不推进播放，仅返回引用，供无感过渡预取 URL 使用）。
 * - SINGLE 模式下返回 null（单曲循环不过渡）
 * - RANDOM 模式使用 shuffleOrder，必要时重建
 * - SEQUENCE 模式按列表顺序循环
 * - 列表为空返回 null
 */
const getNextSong = async (): Promise<SongList | null> => {
  return resolveNextSong({
    respectSingleMode: true,
    rebuildShuffleOnWrap: false
  })
}

/**
 * 当前歌曲启动后，预加载下一首到副槽（双槽音频架构的无缝切换）。
 * - 单曲模式（SINGLE）不预加载
 * - 随机模式（RANDOM）取随机下一首
 * - URL 获取失败或异常时静默忽略，切歌时按正常流程重新加载
 */
/**
 * 预加载下一首到副槽：
 * - 先查持久化缓存，命中直接设副槽
 * - 未命中则原源取 URL
 * - 原源失败则候选源顺序回退
 * - 取到 URL 后用隐藏 Audio 校验可用性
 * - 写入内存缓存供 playSong 复用
 */
const prefetchNextTrack = async (): Promise<void> => {
  if (playMode.value === PlayMode.SINGLE) return
  if (list.value.length === 0) return
  try {
    const nextSong = await resolveNextSong({
      respectSingleMode: true,
      rebuildShuffleOnWrap: false
    })
    if (!nextSong) return

    // 1. 检查持久化缓存
    const quality = _getQuality(nextSong)
    // Official podcast links expire; prefetch them fresh instead of durable cache.
    if (!isPodcastProgram(nextSong)) {
      const cachedUrl = await _getCachedUrl(nextSong, quality)
      if (cachedUrl && typeof cachedUrl === 'string' && !cachedUrl.includes('error')) {
        const playableCachedUrl = await ensureWebViewPlayableUrl(cachedUrl)
        if (await verifyPlayableUrl(playableCachedUrl)) {
          _setPrefetchSlot(nextSong, playableCachedUrl)
          return
        }
      }
    }

    const result = await tryUrlSequential(nextSong)
    if (result) {
      void _setCachedUrl(result.song, _getQuality(result.song), result.url)
      const playableUrl = await ensureWebViewPlayableUrl(result.url)
      _setPrefetchSlot(result.song, playableUrl)
    }
  } catch {
    // 预加载失败静默忽略，切歌时重新正常加载
  }
}

/** 设置副槽并写入内存缓存 */
function _setPrefetchSlot(song: SongList, url: string): void {
  controlAudio.setSecondaryUrl(url)
  const key = `${song.source}:${song.songmid}`
  _prefetchedUrlCache.set(key, url)
  if (_prefetchedUrlCache.size > _PREFETCH_URL_CACHE_MAX) {
    const firstKey = _prefetchedUrlCache.keys().next().value
    if (firstKey !== undefined) _prefetchedUrlCache.delete(firstKey)
  }
  // Durable URL cache skips podcasts inside _setCachedUrl; music still benefits.
  const quality = _getQuality(song)
  void _setCachedUrl(song, quality, url)
}

const playPrevious = async () => {
  cancelPendingAutoNext()
  crossfadeManager.cancel()
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    /* 一起听:有控制权 → 发 ctl:prev 让 server 单点裁决推进队列;
     * member 无控制权 → 提示。和 playNext 对称。 */
    if (lt.canControl) {
      lt.previous()
    } else {
      MessagePlugin.warning('当前在一起听房间中,无播放控制权')
    }
    return
  }
  if (list.value.length === 0) return
  try {
    let prevSong: SongList | null = null
    if (playMode.value === PlayMode.RANDOM) {
      prevSong = popPlaybackHistorySong()
    }
    if (!prevSong) {
      const currentIndex = getCurrentSongIndex()
      const prevIndex = currentIndex <= 0 ? list.value.length - 1 : currentIndex - 1
      prevSong = list.value[prevIndex] || null
    }
    if (!prevSong) return
    navigatingPlaybackHistory = true
    try {
      await playSong(prevSong, { immediate: true })
    } finally {
      navigatingPlaybackHistory = false
    }
  } catch {
    MessagePlugin.error('播放上一首失败')
  }
}

const playNext = async () => {
  cancelPendingAutoNext()
  crossfadeManager.cancel()
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    if (lt.canControl) {
      lt.skip()
    } else {
      MessagePlugin.warning('当前在一起听房间中，无播放控制权')
    }
    return
  }
  if (list.value.length === 0) return
  try {
    const nextSong = await resolveNextSong({
      respectSingleMode: false,
      rebuildShuffleOnWrap: true
    })
    if (nextSong) {
      await playSong(nextSong, { immediate: true })
    }
  } catch {
    MessagePlugin.error('播放下一首失败')
  }
}

const playNextAutoNow = async () => {
  // 若无感过渡正在完成最后的推进，避免重复推进
  if (crossfadeManager.isFinalizingCurrentAdvance()) return
  const lt = await getListenTogetherStore()
  if (lt.isInRoom) {
    /* 一起听:歌曲自然结束(autoNext)走 onSongEnded —— 服务端按 (songmid, source, seq)
     * 幂等去重,避免多客户端同时报 ended 重复推进。用户主动 next 仍走 lt.skip()。 */
    if (lt.canControl) {
      lt.onSongEnded()
    }
    return
  }
  if (list.value.length === 0) return
  try {
    if (playMode.value === PlayMode.SINGLE && userInfo.value.lastPlaySongId) {
      const currentSong = list.value.find((song) => song.songmid === userInfo.value.lastPlaySongId)
      if (currentSong) {
        setCurrentTime(0)
        if (isNativePlaybackActive()) {
          await nativeSeek(0)
        } else if (Audio.value.audio) {
          Audio.value.audio.currentTime = 0
        }
        const startResult = start()
        if (startResult && typeof (startResult as any).then === 'function') {
          await startResult
        }
        return
      }
    }
    const nextSong = await resolveNextSong({
      respectSingleMode: true,
      rebuildShuffleOnWrap: true
    })
    if (nextSong) {
      await playSong(nextSong, { immediate: true })
    }
  } catch {
    MessagePlugin.error('播放下一首失败')
  }
}

const playNextAuto = () => {
  cancelPendingAutoNext()
  if (list.value.length === 0) return

  /* 一起听场景:不需要 1500ms 的 crossfade 缓冲(房间内不预加载下一首),
   * 缩短到 100ms 提高切歌响应速度 —— 否则歌曲结束后会有 1.5s 的"假装在播"沉默。 */
  const lt = cachedLtStore
  const delay = lt?.isInRoom ? 100 : AUTO_NEXT_DELAY_MS

  const token = pendingAutoNextToken
  pendingAutoNextTimer = setTimeout(() => {
    if (token !== pendingAutoNextToken) return
    pendingAutoNextTimer = null
    void playNextAutoNow()
  }, delay)
}

const setVolume = (v: number) => controlAudio.setVolume(v)
const seekTo = (time: number) => {
  cancelPendingAutoNext()
  /* 一起听:用同步缓存的 store 引用判断;若有控制权则发命令,等 SYNC 回来再 seek 本地。
   * 第一次进房的极短窗口内 cachedLtStore 可能尚未填充 —— 此时按非房间逻辑直接 seek
   * 是安全的(此刻一定不在房间)。 */
  if (cachedLtStore?.isInRoom) {
    if (cachedLtStore.canControl) {
      cachedLtStore.seek(time)
    }
    return
  }
  setCurrentTime(time)
  if (isNativePlaybackActive()) {
    void nativeSeek(time)
  } else if (Audio.value.audio) {
    Audio.value.audio.currentTime = time
  }
  // 对齐安卓：seek 后立即把新进度写盘，避免 seek 后立刻退出时恢复到旧位置
  persistPlaybackPosition(true)
}

let playbackInstalled = false
let savePositionTimer: number | null = null
let preheatedSongId: string | number | null | undefined
let unsubPlaybackPositionPlay: (() => void) | null = null
let unsubPlaybackPositionPause: (() => void) | null = null
const onGlobalCtrl = (e: any) => {
  const name = e?.detail?.name
  const val = e?.detail?.val
  switch (name) {
    case 'play':
      void handlePlay()
      break
    case 'pause':
      void handlePause()
      break
    case 'toggle':
      void togglePlayPause()
      break
    case 'playPrev':
      void playPrevious()
      break
    case 'playNext':
      void playNext()
      console.log('next')
      break
    case 'autoNext':
      void playNextAuto()
      break
    case 'volumeDelta':
      {
        const next = Math.max(0, Math.min(100, (Audio.value.volume || 0) + (Number(val) || 0)))
        setVolume(next)
      }
      break
    case 'seekDelta':
      {
        const a = Audio.value.audio
        const cur = Audio.value.currentTime || a?.currentTime || 0
        const dur = Audio.value.duration || a?.duration || 0
        const target = Math.max(0, Math.min(dur, cur + (Number(val) || 0)))
        seekTo(target)
      }
      break
    case 'seekAbsolute':
      {
        const dur = Audio.value.duration || Audio.value.audio?.duration || 0
        const target = Math.max(0, Math.min(dur || Number(val) || 0, Number(val) || 0))
        seekTo(target)
      }
      break
    case 'setPlayMode':
      {
        const v = String(val || '')
        if (v === 'sequence') {
          playMode.value = PlayMode.SEQUENCE
          userInfo.value.playMode = playMode.value
        } else if (v === 'random') {
          playMode.value = PlayMode.RANDOM
          userInfo.value.playMode = playMode.value
        } else if (v === 'toggleSingle') {
          playMode.value = playMode.value === PlayMode.SINGLE ? PlayMode.SEQUENCE : PlayMode.SINGLE
          userInfo.value.playMode = playMode.value
        }
      }
      break
  }
}

// 模块顶层注册，确保在 Provider.vue 挂载前就能响应状态栏/托盘控制事件
window.addEventListener('global-music-control', onGlobalCtrl)

const initPlayback = async () => {
  if (playbackInstalled) return
  // 关键顺序修复：必须先从小 localStorage 读回歌单和上次播放状态。
  // Provider 是父组件（App.vue: `<Provider><router-view/></Provider>`），
  // Vue 中子组件 mounted 早于父组件，所以 welcome 路由的 initPlayback 会先跑，
  // 那时 userInfo.value 还是 {}、list.value 还是 []，恢复分支条件不成立，
  // 整段"按上次状态恢复"会被静默跳过 —— 这是重启后不恢复歌曲/进度的真正原因。
  if (!localUserStore.initialization) {
    try {
      localUserStore.init()
    } catch (error) {
      console.warn('[playback] 恢复本地播放状态失败:', error)
    }
  }
  playbackInstalled = true
  void ensureNativePlayback()

  if (playMode.value === PlayMode.RANDOM) {
    ensureShuffleOrder(true)
  }

  initPlaylistEventListeners(localUserStore, playSong)

  // 注册插件限流监听（绑定到生命周期，避免重复注册）
  _unsubscribeThrottle = window.api.pluginNotice.onPluginThrottle(
    ({ pluginId, reason, duration }) => {
      _throttledPlugins.add(pluginId)
      MessagePlugin.warning(
        `插件请求受限：${reason}${duration ? `，${Math.ceil(duration / 1000)}秒后自动恢复` : '，已暂停换源'}`
      )
      const old = _throttleTimers.get(pluginId)
      if (old !== undefined) clearTimeout(old)
      if (duration && duration > 0) {
        _throttleTimers.set(
          pluginId,
          setTimeout(() => {
            _throttledPlugins.delete(pluginId)
            _throttleTimers.delete(pluginId)
          }, duration)
        )
      } else {
        _throttleTimers.delete(pluginId)
      }
    }
  )

  // 注册插件禁用监听：插件因崩溃次数过多被禁用，本轮播放不再继续尝试该插件
  _unsubscribeDisabled = window.api.pluginNotice.onPluginDisabled(({ pluginId }) => {
    _disabledPlugins.add(pluginId)
    // 清理限流定时器（已禁用的插件不需要再恢复）
    const t = _throttleTimers.get(pluginId)
    if (t !== undefined) {
      clearTimeout(t)
      _throttleTimers.delete(pluginId)
    }
  })

  // 初始化无感过渡管理器：注入 getNextSong 回调，订阅 slotSwap 重置自动下一首计数
  crossfadeManager.init(getNextSong)
  controlAudio.subscribe('error', () => {
    if (!isNativePlaybackActive()) return
    if (typeof currentPlaybackErrorHandler === 'function') {
      void currentPlaybackErrorHandler(new Event('error'))
    }
  })
  controlAudio.subscribe('play', () => {
    if (!isNativePlaybackActive()) return
    isLoadingSong.value = false
    autoNextCount.value = 0
  })
  controlAudio.subscribe('slotSwap', () => {
    autoNextCount.value = 0
    // 关键：翻转槽位后，playSong 挂在旧 primary 上的 DOM error/playing 监听器仍然存在。
    // 翻转后 completeCrossfade 会对旧 primary 执行 removeAttribute('src') + load()，
    // 这会异步触发 'error' 事件，带着旧歌闭包跑 auto-switch，结果把上一首 URL 又写回了新 primary。
    // 所以这里同步清理这些过期的监听器。翻转后旧 primary === 新 secondary。
    const oldPrimary = controlAudio.getSecondaryEl()
    if (oldPrimary) {
      if (currentPlaybackErrorHandler) {
        try {
          oldPrimary.removeEventListener('error', currentPlaybackErrorHandler)
        } catch {}
        currentPlaybackErrorHandler = null
      }
      if (currentPlaybackPlayingHandler) {
        try {
          oldPrimary.removeEventListener('playing', currentPlaybackPlayingHandler)
        } catch {}
        currentPlaybackPlayingHandler = null
      }
    }
  })

  if (userInfo.value.lastPlaySongId && list.value.length > 0) {
    const lastPlaySongId = String(userInfo.value.lastPlaySongId)
    const lastPlayedSong = list.value.find(
      (song) =>
        _getSongIdentity(song) === lastPlaySongId &&
        (userInfo.value.lastPlaySongSource ? song.source === userInfo.value.lastPlaySongSource : true)
    )
    if (lastPlayedSong) {
      // 记录退出时是否在播放：决定重启后是续播还是只恢复进度
      const wasPlayingAtExit = Boolean(userInfo.value.wasPlaying)
      // UI 立即更新
      songInfo.value = { ...lastPlayedSong }
      Audio.value.isPlay = false
      // 对齐安卓：保留退出时的播放状态，让"启动自动播放"设置消费；
      // 恢复期间不写 wasPlaying = false，避免把"上次正在播"这个信息抹掉。
      mediaSessionController.updatePlaybackState('paused')

      const restoreTime = Number(userInfo.value.currentTime || 0)
      if (restoreTime > 0) {
        pendingRestorePosition = restoreTime
        pendingRestoreSongId = userInfo.value.lastPlaySongId
        Audio.value.currentTime = restoreTime
      }

      // === 零等待启动：只依赖 SQLite 持久化 URL 缓存 ===
      // 计算缓存 key 并查询，命中即零网络播放
      const quality = _getQuality(lastPlayedSong)
      const cachedUrlForStartup =
        (typeof userInfo.value.cachedAudioUrl === 'string' &&
        isPlayableUrl(userInfo.value.cachedAudioUrl) &&
        !userInfo.value.cachedAudioUrl.includes('error')
          ? userInfo.value.cachedAudioUrl
          : null) || (await _getCachedUrl(lastPlayedSong, quality))

      const maybeAutoPlayOnLaunch = async () => {
        // 对齐用户预期的"按上次关闭时的状态继续播放"：
        // 上次退出时在播放 → 重启自动续播；上次是暂停 → 恢复进度但不开播。
        // 设置项 autoPlayOnLaunch 作为"强制自动播放"（上次暂停也开播）。
        if (!usePlaySetting().autoPlayOnLaunch && !wasPlayingAtExit) return
        try {
          const startResult = start()
          if (startResult && typeof (startResult as any).then === 'function') {
            await startResult
          }
          userInfo.value.wasPlaying = true
          mediaSessionController.updatePlaybackState('playing')
        } catch {}
      }
      const restoreStartupTime = () => {
        if (restoreTime <= 0) return
        setCurrentTime(restoreTime)
        if (isNativePlaybackActive()) {
          void nativeSeek(restoreTime).catch(() => {})
        } else if (Audio.value.audio) {
          try {
            Audio.value.audio.currentTime = restoreTime
          } catch {}
        }
      }
      const refreshStartupUrl = async () => {
        try {
          const url = await getSongRealUrl(toRaw(lastPlayedSong))
          if (url && typeof url === 'string' && !url.includes('error')) {
            _setCachedUrl(lastPlayedSong, quality, url)
            await applyPlayableUrl(url)
            restoreStartupTime()
            Audio.value.isPlay = false
            mediaSessionController.updatePlaybackState('paused')
            void maybeAutoPlayOnLaunch()
          }
        } catch {}
      }
      if (
        cachedUrlForStartup &&
        typeof cachedUrlForStartup === 'string' &&
        !cachedUrlForStartup.includes('error')
      ) {
        // 启动恢复不要先 mpv_probe。探活会再拉起一份 mpv，第一首就会卡住；
        // 直接 load，失败再换新链。点下一首快，就是因为走了这条。
        try {
          await applyPlayableUrl(cachedUrlForStartup)
          restoreStartupTime()
          void maybeAutoPlayOnLaunch()
        } catch {
          void refreshStartupUrl()
        }
      } else {
        void refreshStartupUrl()
      }

      // SMTC 元数据更新
      mediaSessionController.updateMetadata({
        title: lastPlayedSong.name,
        artist: lastPlayedSong.singer,
        album: lastPlayedSong.albumName || '未知专辑',
        artworkUrl: lastPlayedSong.img || defaultCoverImg
      }, lastPlayedSong)

    }
  }
  startPlaybackPositionTracking()
}

const clearPlaybackPositionTimer = () => {
  if (savePositionTimer !== null) {
    window.clearTimeout(savePositionTimer)
    savePositionTimer = null
  }
}

const getPlaybackPositionDelay = () => {
  if (!Audio.value.isPlay) return 8000
  const audio = Audio.value.audio
  // native 模式下 DOM 元素没有 duration，要用 store 里 mpv 上报的时长，
  // 否则快进到结尾时不会缩短落盘间隔，进度会丢最后一段。
  const duration = Audio.value.duration > 0
    ? Audio.value.duration
    : audio && audio.duration > 0
      ? audio.duration
      : 0
  const played = isNativePlaybackActive() ? Audio.value.currentTime : audio?.currentTime || Audio.value.currentTime
  const remain = duration > 0 ? duration - played : Number.POSITIVE_INFINITY
  if (remain > 0 && remain < 20) return 1000
  if (!isAppWindowVisible()) return 30000
  return 8000
}

const persistPlaybackPosition = (force = false) => {
  // 对齐安卓：只有存在已恢复的播放目标时才写进度，避免启动前把进度刷成 0
  if (!userInfo.value.lastPlaySongId) return
  if (!force && !Audio.value.isPlay) return
  // native(mpv) 模式下双槽 <audio> 只是空壳，currentTime 恒为 0。以前优先取它，
  // 于是每个 tick 都把 userInfo.currentTime 刷成 0，重启必然从那首歌开头播。
  // native 时只认 store 里由 mpv 时钟维护的 Audio.currentTime。
  const audio = Audio.value.audio
  const storeTime = Audio.value.currentTime
  const domTime = audio && typeof audio.currentTime === 'number' ? audio.currentTime : Number.NaN
  const current = isNativePlaybackActive()
    ? storeTime
    : Number.isFinite(domTime)
      ? domTime
      : storeTime
  if (typeof current !== 'number' || !Number.isFinite(current)) return
  userInfo.value.currentTime = current
}

const tickPlaybackPosition = () => {
  savePositionTimer = null
  if (!playbackInstalled) return
  if (Audio.value.isPlay) {
    persistPlaybackPosition()
    const audio = Audio.value.audio
    if (audio && audio.duration > 0) {
      const remain = audio.duration - audio.currentTime
      if (remain > 0 && remain < 12 && userInfo.value.lastPlaySongId !== preheatedSongId) {
        preheatedSongId = userInfo.value.lastPlaySongId
        if (!isNativePlaybackActive()) {
          void prefetchNextTrack()
        }
      }
    }
  }
  schedulePlaybackPositionTick()
}

const schedulePlaybackPositionTick = () => {
  if (!playbackInstalled || savePositionTimer !== null) return
  savePositionTimer = window.setTimeout(tickPlaybackPosition, getPlaybackPositionDelay())
}

const restartPlaybackPositionTracking = () => {
  clearPlaybackPositionTimer()
  schedulePlaybackPositionTick()
}

const startPlaybackPositionTracking = () => {
  if (unsubPlaybackPositionPlay || unsubPlaybackPositionPause) return
  unsubPlaybackPositionPlay = controlAudio.subscribe('play', restartPlaybackPositionTracking)
  unsubPlaybackPositionPause = controlAudio.subscribe('pause', restartPlaybackPositionTracking)
  window.addEventListener('ceru-window-state-change', restartPlaybackPositionTracking)
  window.addEventListener('ceru-wake', restartPlaybackPositionTracking)
  // 关到托盘 / 隐藏窗口不触发 pagehide，进度只能靠 tick。这里监听 App.vue 的
  // 关窗请求，先强制落盘（对齐安卓退出时 persistPlaybackState(force=true)）。
  window.addEventListener('ceru-persist-playback-state', persistPlaybackStateForClose)
  // 麦克风权限流程会重开音频会话，结束后按需恢复播放
  window.addEventListener('ceru-audio-session-ready', resumePlaybackAfterAudioSessionChange)
  restartPlaybackPositionTracking()
}

const persistPlaybackStateForClose = () => {
  persistPlaybackPosition(true)
  try {
    localStorage.setItem('userInfo', JSON.stringify(userInfo.value))
    localStorage.setItem('songList', JSON.stringify(list.value))
  } catch {}
}

/**
 * macOS 申请/授予麦克风权限会重开音频会话，可能打断正在播放的 mpv。
 * 权限流程结束后如果"本来应该在播放"却没在播，就按最后一次 URL + 进度恢复，
 * 解决"启动响一下 → 被掐掉 → 要手动点播放才能继续"。
 */
const resumePlaybackAfterAudioSessionChange = async () => {
  if (!playbackInstalled) return
  if (Audio.value.isPlay) return
  if (!userInfo.value.wasPlaying && !usePlaySetting().autoPlayOnLaunch) return
  const url = typeof userInfo.value.cachedAudioUrl === 'string' ? userInfo.value.cachedAudioUrl : ''
  const position = Number(userInfo.value.currentTime || 0)
  try {
    if (url && !url.includes('error')) {
      const loaded = await nativeLoad(url, {
        autoplay: true,
        startTime: position > 0 ? position : 0,
        volume: Audio.value.volume,
        headers: (songInfo.value as any)?.__nativeMedia?.headers,
        referrer: (songInfo.value as any)?.__nativeMedia?.referrer || (songInfo.value as any)?.__nativeMedia?.referer,
        userAgent: (songInfo.value as any)?.__nativeMedia?.userAgent || (songInfo.value as any)?.__nativeMedia?.user_agent
      })
      if (loaded) {
        Audio.value.isPlay = true
        mediaSessionController.updatePlaybackState('playing')
        return
      }
    }
    const startResult = start()
    if (startResult && typeof (startResult as any).then === 'function') await startResult
    Audio.value.isPlay = true
    mediaSessionController.updatePlaybackState('playing')
  } catch {}
}

const stopPlaybackPositionTracking = () => {
  clearPlaybackPositionTimer()
  unsubPlaybackPositionPlay?.()
  unsubPlaybackPositionPlay = null
  unsubPlaybackPositionPause?.()
  unsubPlaybackPositionPause = null
  window.removeEventListener('ceru-window-state-change', restartPlaybackPositionTracking)
  window.removeEventListener('ceru-wake', restartPlaybackPositionTracking)
  window.removeEventListener('ceru-persist-playback-state', persistPlaybackStateForClose)
  window.removeEventListener('ceru-audio-session-ready', resumePlaybackAfterAudioSessionChange)
}

const uninstallPlayback = () => {
  if (!playbackInstalled) return
  playbackInstalled = false

  userInfo.value.wasPlaying = false
  cancelPendingAutoNext()
  destroyPlaylistEventListeners()
  crossfadeManager.destroy()
  window.removeEventListener('global-music-control', onGlobalCtrl)
  stopPlaybackPositionTracking()
  _unsubscribeThrottle?.()
  _unsubscribeThrottle = null
  _unsubscribeDisabled?.()
  _unsubscribeDisabled = null
  _throttleTimers.forEach(clearTimeout)
  _throttleTimers.clear()
  _throttledPlugins.clear()
  _disabledPlugins.clear()
}

export {
  songInfo,
  playMode,
  isLoadingSong,
  initPlayback,
  uninstallPlayback,
  playSong,
  playNext,
  playNextAuto,
  playPrevious,
  updatePlayMode,
  togglePlayPause,
  handlePlay,
  handlePause,
  setVolume,
  seekTo,
  onGlobalCtrl,
  getNextSong
}
