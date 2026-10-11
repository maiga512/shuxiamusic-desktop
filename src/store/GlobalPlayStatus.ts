import { defineStore } from 'pinia'
import type { LyricLine } from '@applemusic-like-lyrics/core'
import {
  analyzeImageColors,
  cacheCoverAnalysisAlias,
  peekCoverColors,
  type Color,
  type ImageAnalysisResult
} from '@renderer/utils/color/colorExtractor'
import { parseYrc, parseLrc, parseTTML, parseQrc } from '@applemusic-like-lyrics/lyric'
import type { SongList } from '@renderer/types/audio'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { reactive, computed, watch, toRaw, type ComputedRef } from 'vue'
import _ from 'lodash'
import defaultCover from '@renderer/assets/images/song.jpg'
import { playSetting } from './playSetting'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'
import { resolveSongCover } from '@renderer/utils/audio/coverResolver'
import { isPodcastProgram } from '@renderer/api/podcast'
import podcastApi from '@renderer/api/podcast'
import mediaSessionController from '@renderer/utils/audio/useSmtc'

interface Player {
  songId?: string
  songInfo?: Omit<SongList, 'songmid'> & { songmid: null | number | string }
  // 收藏锚点：当前播放“用户选中的那首歌”（切源前）。星号/喜欢状态按此身份判定，
  // 播放中自动换源只换播放实例，不改变锚点，收藏展示不随音源漂移。
  favoriteAnchor?: Omit<SongList, 'songmid'> & { songmid: null | number | string } | null
  // base64编码 封面
  cover?: string
  // 封面详情
  coverDetail: {
    ColorObject?: Color
    mainColor?: string
    lightMainColor?: string
    // 对比色
    contrastColor?: string
    // 文本对比颜色
    textColor?: string
    hoverColor?: string
    playBg?: string
    playBgHover?: string
    useBlackText?: boolean
  }
  // 歌曲名
  songName: ComputedRef<string>
  // 歌手
  singer: ComputedRef<string>
  // 歌词
  lyrics: {
    lines: LyricLine[]
    trans?: string
    source?: string
    // 原始歌词字符串，用于分享上传到后端（不要使用解析后的 LyricLine）
    raw?: {
      lrc?: string
      yrc?: string
      ttml?: string
      qrc?: string
      trans?: string
      format?: 'lrc' | 'yrc' | 'qrc' | 'ttml'
    }
  }
  isLoading: boolean
  comments: {
    hotList: Comment[]
    latestList: Comment[]
    hotTotal: number
    hotPage: number
    hotMaxPage: number
    latestTotal: number
    latestPage: number
    latestMaxPage: number
    limit: number
    type: 'hot' | 'latest'
    hotIsLoading: boolean
    latestIsLoading: boolean
  }
}

export const COMMENT_PAGE_CAP = 3

export interface Comment {
  id: number | string
  text: string
  time: number
  timeStr: string
  location: string
  userName: string
  avatar: string
  userId: number | string
  likedCount: number
  images: string[]
  reply: Comment[]
}

export interface CommentResponse {
  source: string
  comments: Comment[]
  total: number
  page: number
  limit: number
  maxPage: number
}

function isRemoteCoverUrl(url?: string): boolean {
  return (
    typeof url === 'string' &&
    /^https?:\/\//i.test(url) &&
    !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(url)
  )
}

function resolveCoverDisplayUrl(url: string): string {
  if (!url) return ''
  if (/^(data:|blob:|file:)/i.test(url)) return url
  const imagesApi = (window as any)?.api?.images
  // Dock/fullscreen color extract and PIXI need a same-origin URL.
  // Electron can fetch CDN covers via session; Tauri WKWebView often cannot
  // read pixels from raw https covers, so always prefer the local cover proxy.
  if (isRemoteCoverUrl(url)) {
    if (typeof imagesApi?.wrapThumbUrlSync === 'function') {
      const thumb = imagesApi.wrapThumbUrlSync(url)
      if (typeof thumb === 'string' && thumb) return thumb
    }
    if (typeof imagesApi?.proxyUrlSync === 'function') {
      const sync = imagesApi.proxyUrlSync(url)
      if (typeof sync === 'string' && sync && sync !== url) return sync
    }
    return ''
  }
  return url
}

async function resolveCoverFetchUrl(url: string): Promise<string> {
  if (!url) return ''
  if (/^(data:|blob:|file:)/i.test(url)) return url
  const imagesApi = (window as any)?.api?.images
  if (isRemoteCoverUrl(url)) {
    if (typeof imagesApi?.wrapThumbUrl === 'function') {
      try {
        const proxied = await imagesApi.wrapThumbUrl(url)
        if (typeof proxied === 'string' && proxied) return proxied
      } catch {}
    }
    if (typeof imagesApi?.proxyUrl === 'function') {
      try {
        const proxied = await imagesApi.proxyUrl(url)
        if (typeof proxied === 'string' && proxied) return proxied
      } catch {}
    }
  }
  return resolveCoverDisplayUrl(url) || url
}

async function getBlobUrlFromUrl(url: string): Promise<string> {
  if (!url) return ''
  if (/^(data:|blob:|file:)/i.test(url)) return url
  let fetchUrl = ''
  try {
    fetchUrl = await resolveCoverFetchUrl(url)
    if (!fetchUrl) return ''
    const response = await fetch(fetchUrl)
    const blob = await response.blob()
    if (!response.ok) return ''
    // Reject non-image bodies (HTML/JSON auth errors) so we do not analyze junk.
    if (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream') {
      return ''
    }
    return URL.createObjectURL(blob)
  } catch (e) {
    console.error('封面转Blob失败:', e)
    return ''
  }
}

// 辅助函数：清洗歌词
const sanitizeLyricLines = (lines: LyricLine[]): LyricLine[] => {
  const defaultLineDuration = 3000
  const toFiniteNumber = (v: any, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  const cleaned: LyricLine[] = []
  for (const rawLine of lines || []) {
    const rawWords = Array.isArray((rawLine as any).words) ? (rawLine as any).words : []
    const fixedWords: any[] = []
    let prevEnd = -1
    for (const rawWord of rawWords) {
      const rawStart = toFiniteNumber(rawWord?.startTime, Number.NaN)
      const rawEnd = toFiniteNumber(rawWord?.endTime, Number.NaN)
      if (!Number.isFinite(rawStart)) continue
      let startTime = Math.max(0, rawStart)
      if (startTime < prevEnd) startTime = prevEnd
      let endTime = Number.isFinite(rawEnd) ? rawEnd : startTime + 1
      if (endTime <= startTime) endTime = startTime + 1
      prevEnd = endTime
      fixedWords.push({ ...rawWord, startTime, endTime })
    }
    if (fixedWords.length === 0) continue

    const firstWordStart = fixedWords[0].startTime
    const lastWordEnd = fixedWords[fixedWords.length - 1].endTime
    let startTime = toFiniteNumber((rawLine as any).startTime, firstWordStart)
    startTime = Math.max(0, startTime)
    let endTime = toFiniteNumber((rawLine as any).endTime, lastWordEnd)
    if (!Number.isFinite(endTime) || endTime <= startTime) endTime = startTime + defaultLineDuration
    if (endTime < lastWordEnd) endTime = lastWordEnd

    cleaned.push({ ...(rawLine as any), startTime, endTime, words: fixedWords })
  }
  cleaned.sort((a: any, b: any) => (a?.startTime ?? 0) - (b?.startTime ?? 0))
  return cleaned
}

const DEFAULT_SONG_INFO = {
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
}

export const useGlobalPlayStatusStore = defineStore(
  'globalPlayStatus',
  () => {
    const localUserStore = LocalUserDetailStore()
    const playSettingStore = playSetting()
    const player = reactive<Player>({
      songId: void 0,
      songInfo: DEFAULT_SONG_INFO,
      favoriteAnchor: null,
      cover: void 0,
      coverDetail: {
        ColorObject: void 0,
        mainColor: 'var(--td-brand-color-5)',
        lightMainColor: 'rgba(255, 255, 255, 0.9)',
        contrastColor: 'var(--player-text-idle)',
        textColor: 'var(--player-text-idle)',
        hoverColor: 'var(--player-text-hover-idle)',
        playBg: 'var(--player-btn-bg-idle)',
        playBgHover: 'var(--player-btn-bg-hover-idle)',
        useBlackText: false
      },
      songName: computed(() => player.songInfo?.name || ''),
      singer: computed(() => player.songInfo?.singer || ''),
      lyrics: {
        lines: [],
        raw: {}
      },
      isLoading: false,
      comments: {
        hotList: [],
        latestList: [],
        hotTotal: 0,
        hotPage: 0,
        hotMaxPage: 0,
        latestTotal: 0,
        latestPage: 0,
        latestMaxPage: 0,
        limit: 20,
        type: 'hot',
        hotIsLoading: false,
        latestIsLoading: false
      }
    })

    // 同步 userInfo.lastPlaySongId / lastPlaySongSource
    watch(
      () => [localUserStore.userInfo.lastPlaySongId, localUserStore.userInfo.lastPlaySongSource],
      ([newId, newSource]) => {
        if (newId && (newId !== player.songId || newSource !== (player.songInfo as any)?.source)) {
          player.songId = newId
          const song = localUserStore.list.find(
            (s: any) =>
              (s.songmid === newId || s.hash === newId || `${s.name}_${s.singer}` === newId) &&
              (newSource ? s.source === newSource : true)
          )
          if (song) {
            updatePlayerInfo(song)
          }
        }
      },
      { immediate: true }
    )

    // 记录当前的 Blob URL 以便清理
    let currentBlobUrl: string | null = null

    const applyCoverColors = (result: ImageAnalysisResult) => {
      const { dominantColor, useBlackText } = result
      player.coverDetail.ColorObject = dominantColor
      player.coverDetail.mainColor = `rgba(${dominantColor.r},${dominantColor.g},${dominantColor.b},1)`
      const baseTextColor = useBlackText ? '0, 0, 0' : '255, 255, 255'
      player.coverDetail.textColor = `rgba(${baseTextColor}, 0.6)`
      player.coverDetail.hoverColor = `rgba(${baseTextColor}, 1)`
      player.coverDetail.contrastColor = player.coverDetail.textColor
      player.coverDetail.playBg = 'rgba(255,255,255,0.2)'
      player.coverDetail.playBgHover = 'rgba(255,255,255,0.33)'
      let r = dominantColor.r
      let g = dominantColor.g
      let b = dominantColor.b
      r = Math.min(255, r + (255 - r) * 0.8)
      g = Math.min(255, g + (255 - g) * 0.8)
      b = Math.min(255, b + (255 - b) * 0.8)
      player.coverDetail.lightMainColor = `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 0.9)`
      player.coverDetail.useBlackText = useBlackText
    }

    let lastCoverSourceUrl = ''

    // 监听 songInfo 变化，处理封面
    watch(
      () => [
        player.songInfo?.img,
        player.songInfo?.songmid,
        (player.songInfo as any)?.hash,
        player.songInfo?.source,
        player.songInfo?.name,
        player.songInfo?.singer
      ],
      async ([newImg], previous) => {
        // 本地歌曲无 img 但有 hasCover 时,走 IPC 按需拉取,避免列表外播放时封面缺失
        const info: any = player.songInfo
        const targetCoverKey = `${info?.source || ''}:${info?.songmid || info?.hash || `${info?.name || ''}_${info?.singer || ''}`}`
        const previousCoverKey = `${previous?.[3] || ''}:${previous?.[1] || previous?.[2] || `${previous?.[4] || ''}_${previous?.[5] || ''}`}`
        const identityChanged = Boolean(previous) && previousCoverKey !== targetCoverKey
        if (identityChanged) {
          player.cover = (typeof newImg === 'string' && newImg) || defaultCover
        }
        if (!newImg && info?.songmid && info?.source !== 'local') {
          const targetId = String(info.songmid)
          const targetSource = info.source
          if (identityChanged || !player.cover) player.cover = defaultCover
          resolveSongCover(toRaw(info) as any)
            .then((img) => {
              if (
                img &&
                player.songInfo &&
                String(player.songInfo.songmid) === targetId &&
                player.songInfo.source === targetSource &&
                !player.songInfo.img
              ) {
                player.songInfo.img = img
                mediaSessionController.updateMetadata(
                  {
                    title: player.songInfo.name || '未知歌曲',
                    artist: player.songInfo.singer || '未知艺术家',
                    album: player.songInfo.albumName || '未知专辑',
                    artworkUrl: img
                  },
                  player.songInfo
                )
              }
            })
            .catch(() => {})
          return
        }
        if (
          !newImg &&
          info?.source === 'local' &&
          info?.hasCover &&
          info?.songmid &&
          (window as any)?.api?.localMusic?.getCoverBase64
        ) {
          const targetId = String(info.songmid)
          ;(window as any).api.localMusic
            .getCoverBase64(targetId)
            .then((data: string) => {
              if (
                data &&
                player.songInfo &&
                String(player.songInfo.songmid) === targetId &&
                !player.songInfo.img
              ) {
                player.songInfo.img = data
                mediaSessionController.updateMetadata(
                  {
                    title: player.songInfo.name || '未知歌曲',
                    artist: player.songInfo.singer || '未知艺术家',
                    album: player.songInfo.albumName || '未知专辑',
                    artworkUrl: data
                  },
                  player.songInfo
                )
              }
            })
            .catch(() => {})
          return
        }

        // 处理封面 Blob URL
        const coverUrl = newImg ? newImg : defaultCover
        console.log('coverUrl', coverUrl)

        const stillCurrentCover = () => {
          const current: any = player.songInfo
          return `${current?.source || ''}:${current?.songmid || current?.hash || `${current?.name || ''}_${current?.singer || ''}`}` === targetCoverKey
        }

        const previousBlobUrl = currentBlobUrl
        currentBlobUrl = null

        if (coverUrl.startsWith('http')) {
          // Electron: commit cover once (blob preferred), then analyze that same image.
          // Never analyze raw CDN https in WKWebView — CORS taints canvas and we used to
          // cache the blue fallback forever under this cover URL.
          const cachedColors = peekCoverColors(coverUrl)
          if (cachedColors) applyCoverColors(cachedColors)
          lastCoverSourceUrl = coverUrl
          const blobUrl = await getBlobUrlFromUrl(coverUrl)
          if (!stillCurrentCover()) {
            if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl)
            return
          }
          if (blobUrl) {
            if (blobUrl.startsWith('blob:')) currentBlobUrl = blobUrl
            player.cover = blobUrl
            if (blobUrl.startsWith('blob:')) cacheCoverAnalysisAlias(coverUrl, blobUrl)
          } else {
            const proxied = await resolveCoverFetchUrl(coverUrl)
            player.cover = proxied || resolveCoverDisplayUrl(coverUrl) || coverUrl
          }
        } else {
          if (!stillCurrentCover()) {
            if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl)
            return
          }
          player.cover = coverUrl
        }
        if (previousBlobUrl && previousBlobUrl !== currentBlobUrl) {
          URL.revokeObjectURL(previousBlobUrl)
        }
      },
      { immediate: true }
    )
    // 监听 cover 变化，提取颜色（带世代号，避免旧封面异步结果覆盖新歌）
    let colorExtractGeneration = 0
    let pendingCoverAnalysis: string | null = null
    const runCoverColorAnalysis = async (newCover: string) => {
      const generation = ++colorExtractGeneration
      const coverForSong = newCover
      try {
        const result = await analyzeImageColors(coverForSong)
        if (generation !== colorExtractGeneration || player.cover !== coverForSong) return
        applyCoverColors(result)
        cacheCoverAnalysisAlias(coverForSong, lastCoverSourceUrl)
      } catch (e) {
        if (generation !== colorExtractGeneration) return
        console.error('颜色提取失败', e)
        if (!player.coverDetail.ColorObject) resetColors()
      }
    }
    watch(
      () => player.cover,
      async (newCover) => {
        if (!newCover) return
        if (!isAppWindowVisible()) {
          pendingCoverAnalysis = newCover
          return
        }
        pendingCoverAnalysis = null
        await runCoverColorAnalysis(newCover)
      }
    )
    const flushPendingCoverAnalysis = () => {
      if (!pendingCoverAnalysis || !isAppWindowVisible()) return
      const cover = pendingCoverAnalysis
      pendingCoverAnalysis = null
      void runCoverColorAnalysis(cover)
    }
    window.addEventListener('ceru-wake', flushPendingCoverAnalysis)
    window.addEventListener('ceru-window-state-change', flushPendingCoverAnalysis)

    function resetColors() {
      player.coverDetail.ColorObject = void 0
      player.coverDetail.mainColor = 'var(--td-brand-color-5)'
      player.coverDetail.lightMainColor = 'rgba(255, 255, 255, 0.9)'
      player.coverDetail.contrastColor = 'var(--player-text-idle)'
      player.coverDetail.textColor = 'var(--player-text-idle)'
      player.coverDetail.hoverColor = 'var(--player-text-hover-idle)'
      player.coverDetail.playBg = 'var(--player-btn-bg-idle)'
      player.coverDetail.playBgHover = 'var(--player-btn-bg-hover-idle)'
    }

    // 监听歌曲ID变化，获取歌词, 评论
    type RawLyricFormat = 'lrc' | 'yrc' | 'qrc' | 'ttml'
    const setRawLyric = (format: RawLyricFormat, text: string, trans?: string) => {
      player.lyrics.raw = {
        ...(player.lyrics.raw || {}),
        [format]: text,
        format,
        ...(trans !== undefined ? { trans } : {})
      }
    }
    watch(
      [
        () => player.songId,
        () => player.songInfo?.songmid,
        () => (player.songInfo as any)?.hash,
        () => player.songInfo?.source,
        () => player.songInfo?.name,
        () => player.songInfo?.singer,
        () => (player.songInfo as any)?.lrc
      ],
      async ([newId], _oldArgs, onCleanup) => {
        if (!newId || !player.songInfo) {
          player.lyrics.lines = []
          player.lyrics.raw = {}
          return
        }
        player.isLoading = true
        // 切换歌曲时重置原始歌词缓存
        player.lyrics.raw = {}

        // 竞态与取消控制
        let active = true
        const abort = new AbortController()
        onCleanup(() => {
          active = false
          abort.abort()
        })

        const getCleanSongInfo = () => JSON.parse(JSON.stringify(toRaw(player.songInfo)))
        updateCommon(getCleanSongInfo())

        const parseCrLyricBySource = (source: string, text: string): LyricLine[] => {
          return source === 'tx' ? (parseQrc(text) as any) : (parseYrc(text) as any)
        }

        const mergeTranslation = (base: LyricLine[], tlyric?: string): LyricLine[] => {
          if (!tlyric || base.length === 0) return base

          const translated = parseLrc(tlyric)
          if (!translated || translated.length === 0) return base

          const joinWords = (line: LyricLine) => (line.words || []).map((w) => w.word).join('')

          const translatedSorted = translated.slice().sort((a, b) => a.startTime - b.startTime)

          const baseTolerance = 300
          const ratioTolerance = 0.4

          if (base.length > 0) {
            const firstBase = base[0]
            const firstDuration = Math.max(1, firstBase.endTime - firstBase.startTime)
            const firstTol = Math.min(baseTolerance, firstDuration * ratioTolerance)

            let anchorIndex: number | null = null
            let bestDiff = Number.POSITIVE_INFINITY
            for (let i = 0; i < translatedSorted.length; i++) {
              const diff = Math.abs(translatedSorted[i].startTime - firstBase.startTime)
              if (diff <= firstTol && diff < bestDiff) {
                bestDiff = diff
                anchorIndex = i
              }
            }

            if (anchorIndex !== null) {
              let j = anchorIndex
              for (let i = 0; i < base.length && j < translatedSorted.length; i++, j++) {
                const bl = base[i]
                const tl = translatedSorted[j] as LyricLine
                if (tl.words[0].word === '//' || !bl.words[0].word) continue
                const text = joinWords(tl)
                if (text) bl.translatedLyric = text
              }
              return base
            }
          }
          return base
        }

        try {
          const source = (player.songInfo as any).source || 'kg'
          let parsedLyrics: LyricLine[] = []

          if (source === 'wy' && isPodcastProgram(player.songInfo)) {
            try {
              const lyricResult = await podcastApi.getProgramLyric(getCleanSongInfo())
              const lyricText =
                typeof lyricResult === 'string' ? lyricResult : lyricResult?.lyric || ''
              if (!active) return
              parsedLyrics = lyricText ? (parseLrc(lyricText) as any) : []
              if (lyricText) setRawLyric('lrc', lyricText)
            } catch {
              parsedLyrics = []
            }
          } else if (source === 'wy' || source === 'tx') {
            const sdkPromise = (async () => {
              try {
                const lyricData = await window.api.music.requestSdk('getLyric', {
                  source,
                  songInfo: getCleanSongInfo(),
                  grepLyricInfo: playSettingStore.getIsGrepLyricInfo,
                  useStrictMode: playSettingStore.getStrictGrep
                })
                console.log('平台 Lyrics 获取成功')

                if (!active) return null

                let lyrics: null | LyricLine[] = null
                if (lyricData?.crlyric) {
                  lyrics = parseCrLyricBySource(source, lyricData.crlyric)
                  // 缓存原始歌词字符串
                  setRawLyric(source === 'tx' ? 'qrc' : 'yrc', lyricData.crlyric, lyricData?.tlyric)
                } else if (lyricData?.lyric) {
                  lyrics = parseLrc(lyricData.lyric) as any
                  setRawLyric('lrc', lyricData.lyric, lyricData?.tlyric)
                }
                lyrics = mergeTranslation(lyrics as any, lyricData?.tlyric)

                if (!lyrics || lyrics.length === 0) {
                  return null
                }
                return lyrics
              } catch (err: any) {
                throw new Error(`SDK request failed: ${err.message}`)
              }
            })()

            try {
              const response = await fetch(
                `https://amll-ttml-db.stevexmh.net/${source === 'wy' ? 'ncm' : 'qq'}/${newId}`,
                {
                  signal: abort.signal
                }
              )

              if (!active) return

              if (!response.ok) {
                throw new Error(`TTML request failed with status ${response.status}`)
              }

              const res = await response.text()

              if (!res || res.length < 100) {
                throw new Error('ttml 无歌词')
              }

              const ttmlLyrics = parseTTML(res).lines

              if (!ttmlLyrics || ttmlLyrics.length === 0) {
                throw new Error('TTML 解析为空')
              }

              parsedLyrics = ttmlLyrics as LyricLine[]
              // 缓存原始 TTML 字符串
              setRawLyric('ttml', res)

              sdkPromise.catch(() => {})
            } catch (ttmlError: any) {
              if (!active || (ttmlError && ttmlError.name === 'AbortError')) {
                return
              }

              try {
                const sdkLyrics = await sdkPromise
                if (sdkLyrics) {
                  parsedLyrics = sdkLyrics
                } else {
                  parsedLyrics = []
                }
              } catch (sdkError) {
                parsedLyrics = []
              }
            }
          } else if (source !== 'local') {
            // 服务插件歌曲（如 navidrome）：优先使用歌曲自带的 lrc 字段
            const servicePluginId = (player.songInfo as any)._servicePluginId as string | undefined
            console.log('[歌词] 非本地歌曲, source:', source, 'servicePluginId:', servicePluginId)
            if (servicePluginId) {
              // 通过服务插件异步获取歌词（类似 wy/kg）
              try {
                const lyricResult = await window.api.plugins.getServiceLyric(
                  servicePluginId,
                  getCleanSongInfo()
                )
                console.log('[歌词] 服务插件歌词返回:', lyricResult)
                if (!active) return

                const lyricText = lyricResult?.data?.lyric
                if (lyricText) {
                  if (/^\[(\d+),\d+\]/.test(lyricText) || /\(\d+,\d+,\d+\)/.test(lyricText)) {
                    parsedLyrics = parseYrc(lyricText) as any
                    setRawLyric('yrc', lyricText)
                  } else {
                    parsedLyrics = parseLrc(lyricText) as any
                    setRawLyric('lrc', lyricText)
                  }
                } else {
                  parsedLyrics = []
                }
              } catch {
                parsedLyrics = []
              }
            } else {
              // 没有自带歌词也没有服务插件ID，尝试通过音源SDK获取
              try {
                const lyricData = await window.api.music.requestSdk('getLyric', {
                  source,
                  songInfo: getCleanSongInfo(),
                  grepLyricInfo: playSettingStore.getIsGrepLyricInfo,
                  useStrictMode: playSettingStore.getStrictGrep
                })
                console.log('平台 Lyrics 获取成功', lyricData)
                if (!active) return

                if (lyricData?.crlyric) {
                  parsedLyrics = parseCrLyricBySource(source, lyricData.crlyric)
                  setRawLyric(source === 'tx' ? 'qrc' : 'yrc', lyricData.crlyric, lyricData?.tlyric)
                } else if (lyricData?.lyric) {
                  parsedLyrics = parseLrc(lyricData.lyric) as LyricLine[]
                  setRawLyric('lrc', lyricData.lyric, lyricData?.tlyric)
                }

                parsedLyrics = mergeTranslation(parsedLyrics, lyricData?.tlyric)
              } catch {
                parsedLyrics = []
              }
            }
          } else {
            let text = (player.songInfo as any).lrc as string | null
            if (!text) {
              text = await window.api.music.invoke(
                'local-music:get-lyric',
                (player.songInfo as any).songmid
              )
            }

            if (text && (/^\[(\d+),\d+\]/.test(text) || /\(\d+,\d+,\d+\)/.test(text))) {
              parsedLyrics = text ? (parseYrc(text) as any) : []
              if (text) setRawLyric('yrc', text)
            } else {
              parsedLyrics = text ? (parseLrc(text) as any) : []
              if (text) setRawLyric('lrc', text)
            }
          }
          if (!active) return
          player.lyrics.lines = parsedLyrics.length > 0 ? sanitizeLyricLines(parsedLyrics) : []
        } catch (error) {
          console.error('获取歌词失败:', error)
          if (!active) return
          player.lyrics.lines = []
        } finally {
          if (active) player.isLoading = false
        }
      },
      { immediate: true }
    )

    function getSongIdentity(songInfo?: Partial<SongList> | null) {
      return (
        songInfo?.songmid ||
        (songInfo as any)?.hash ||
        `${songInfo?.name || ''}_${songInfo?.singer || ''}`
      )
    }

    function updatePlayerInfo(songInfo: SongList) {
      const currentSong = player.songInfo as any
      const songId = getSongIdentity(songInfo)
      const sameSong =
        getSongIdentity(currentSong) === songId &&
        currentSong?.source === songInfo.source &&
        currentSong?.name === songInfo.name &&
        currentSong?.singer === songInfo.singer &&
        currentSong?.img === songInfo.img &&
        currentSong?.albumName === songInfo.albumName
      // Always copy. Reusing the playlist object left the dock title/cover
      // frozen while audio already moved on to the next track.
      const nextInfo = {
        ...songInfo,
        lrc: songInfo.lrc ?? null,
        types: songInfo.types || [],
        _types: songInfo._types || {},
        typeUrl: songInfo.typeUrl || {}
      }
      if (sameSong && currentSong === player.songInfo) {
        Object.assign(currentSong, nextInfo)
      } else {
        player.songInfo = nextInfo
      }
      player.songId = songId as any
      localUserStore.userInfo.lastPlaySongId = songId as any
      localUserStore.userInfo.lastPlaySongSource = songInfo.source || null
    }

    // 设置收藏锚点：playSong 选中新歌时调用；自动换源不得调用（锚点保持不变）。
    function setFavoriteAnchor(song: SongList | null) {
      player.favoriteAnchor = song ? { ...song } : null
    }

    async function fetchComments(page = 1, type: 'hot' | 'latest' = 'hot') {
      const currentSongInfo = toRaw(player.songInfo)
      if (!currentSongInfo || !currentSongInfo.songmid) return
      if (page > COMMENT_PAGE_CAP) return

      if (type === 'hot') {
        player.comments.hotIsLoading = true
      } else {
        player.comments.latestIsLoading = true
      }
      try {
        const method = type === 'hot' ? 'getHotComment' : 'getComment'
        const res = await window.api.music.requestSdk(method, {
          source: currentSongInfo.source || 'wy',
          songInfo: currentSongInfo,
          page,
          limit: player.comments.limit
        })

        console.log('评论获取成功', res)

        if (type === 'hot') {
          if (page === 1) {
            player.comments.hotList = res.comments || []
          } else {
            player.comments.hotList.push(...(res.comments || []))
          }
          player.comments.hotTotal = res.total
          // Use requested page instead of response page to avoid infinite loop with 0-based APIs
          player.comments.hotPage = page
          player.comments.hotMaxPage = Math.min(res.maxPage || 0, COMMENT_PAGE_CAP)
        } else {
          if (page === 1) {
            player.comments.latestList = res.comments || []
          } else {
            player.comments.latestList.push(...(res.comments || []))
          }
          player.comments.latestTotal = res.total
          // Use requested page instead of response page
          player.comments.latestPage = page
          player.comments.latestMaxPage = Math.min(res.maxPage || 0, COMMENT_PAGE_CAP)
        }

        player.comments.type = type
      } catch (err) {
        console.error('评论获取失败', err)
      } finally {
        if (type === 'hot') {
          player.comments.hotIsLoading = false
        } else {
          player.comments.latestIsLoading = false
        }
      }
    }

    function updateCommon(songInfo: SongList) {
      const knownSources = ['wy', 'tx', 'mg', 'kg', 'kw', 'bd']
      if (songInfo.source === 'local' || !knownSources.includes(songInfo.source)) return
      // Reset comments
      player.comments.hotList = []
      player.comments.latestList = []
      player.comments.hotPage = 0
      player.comments.hotTotal = 0
      player.comments.hotMaxPage = 0
      player.comments.latestPage = 0
      player.comments.latestTotal = 0
      player.comments.latestMaxPage = 0

      // 同时获取热门和最新评论
      fetchComments(1, 'hot')
      fetchComments(1, 'latest')
    }

    return {
      player,
      updatePlayerInfo,
      setFavoriteAnchor,
      fetchComments
    }
  },
  {
    // Last song already lives in LocalUserDetail. Persisting this store kept
    // full lyrics + comments in localStorage and hydrated them back on boot.
    persist: false
  }
)
