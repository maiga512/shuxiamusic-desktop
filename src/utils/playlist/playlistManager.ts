import mitt from 'mitt'
import { MessagePlugin } from 'tdesign-vue-next'
import type { SongList } from '@renderer/types/audio'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { useSettingsStore } from '@renderer/store/Settings'
import { isPodcastProgram } from '@renderer/api/podcast'
import { extractPlayableUrl, isPlayableUrl } from '@renderer/utils/audio/playableUrl'
import { getPlaybackQualityCandidates, getPreferredPlaybackQuality } from '@renderer/utils/audio/qualityAvailability'

/**
 * 一起听场景下的"member 点歌"分流 —— addToPlaylistAndPlay/End/replacePlaylist
 * 这些操作对 member 来说都不应直接修改本地播放列表(否则与房间同步状态脱节),
 * 而是提交 lt.requestSong 进入 pending 等管理员审批。
 *
 * 返回 true 表示已提交点歌请求并提示用户,调用方应早 return 不继续后续逻辑。
 *
 * 用动态 import 避免与 ListenTogether store 形成循环依赖。
 */
async function tryRequestSongAsMember(song: SongList): Promise<boolean> {
  try {
    const { useListenTogetherStore } = await import('@renderer/store')
    const lt = useListenTogetherStore()
    if (!lt.isInRoom || lt.canControl) return false

    /* 本地预检 —— 服务端虽然也会拦截,但乐观 success 会先弹一条紧接着错误警告
     * 两条消息互相打架,UX 很怪。在 emit 之前先按本地 state 拦一下,常见场景
     * (双击点歌按钮 / 同曲重复点)能立刻提示而不用等服务端往返。 */
    const songmid = String(song.songmid)
    const source = song.source
    const queueDup = lt.queue.some((q) => q.song?.songmid === songmid && q.song?.source === source)
    if (queueDup) {
      await MessagePlugin.warning(`《${song.name || '?'}》已在播放队列里了`)
      return true /* 已"处理" → 阻止调用方继续走默认播放路径 */
    }
    const myUserId = lt.myUserId
    const pendingDup = lt.pending.some((p) => {
      if (p.song?.songmid !== songmid || p.song?.source !== source) return false
      const reqs = Array.isArray(p.requesters) ? p.requesters : [{ userId: p.requesterId }]
      return reqs.some((r) => r.userId === myUserId)
    })
    if (pendingDup) {
      await MessagePlugin.warning(`你已经申请过《${song.name || '?'}》,等待管理员审批`)
      return true
    }

    lt.requestSong({
      songmid,
      source,
      name: song.name,
      singer: song.singer,
      cover: (song as any).img,
      albumName: song.albumName,
      albumId: song.albumId !== undefined ? String(song.albumId) : undefined,
      hash: song.hash,
      types: song.types,
      lrc: (song as any).lrc ?? null,
      url: (song as any).url || undefined
    })
    await MessagePlugin.success(`已提交点歌《${song.name || '?'}》,等待管理员审核`)
    return true
  } catch {
    return false
  }
}

/**
 * host/admin 在房间内添加歌曲到共享列表 —— 调 ctl:queue-add 让 server 增量入队
 *
 * 走这条路径而不是 syncRoomContextFromLocal 整体上传是关键:
 * 整体上传会用 host 本地 list 覆盖 server queue,把 member 加的歌全冲掉。
 * ctl:queue-add 只新增一首,server 广播 QUEUE_UPDATE 让所有人(包括 host 自己)
 * 通过 replaceLocalPlaylistFromQueue 同步本地 list。
 */
async function tryAddToQueueAsHost(song: SongList): Promise<boolean> {
  try {
    const { useListenTogetherStore } = await import('@renderer/store')
    const lt = useListenTogetherStore()
    if (!lt.isInRoom || !lt.canControl) return false
    /* 本地预检 —— 同曲已在 queue 立刻提示,避免发到服务端再吃 SONG_ALREADY_QUEUED */
    const songmid = String(song.songmid)
    const source = song.source
    const queueDup = lt.queue.some((q) => q.song?.songmid === songmid && q.song?.source === source)
    if (queueDup) {
      await MessagePlugin.warning(`《${song.name || '?'}》已在播放队列里了`)
      return true
    }
    lt.addToQueue({
      songmid,
      source,
      name: song.name,
      singer: song.singer,
      cover: (song as any).img,
      albumName: song.albumName,
      albumId: song.albumId !== undefined ? String(song.albumId) : undefined,
      hash: song.hash,
      types: song.types,
      lrc: (song as any).lrc ?? null,
      url: (song as any).url || undefined
    })
    return true
  } catch {
    return false
  }
}

// 事件类型定义
type PlaylistEvents = {
  addToPlaylistAndPlay: SongList
  addToPlaylistEnd: SongList
  replacePlaylist: SongList[]
}

// 创建全局事件总线
const emitter = mitt<PlaylistEvents>()
let playlistEventListenersInstalled = false

// 将事件总线挂载到全局
;(window as any).musicEmitter = emitter

// 带超时的 Promise 包装：超时即 reject，用于"命中检查"绝不拖慢首播。
function withPlaybackCacheTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('playback cache timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * 在线播放自动落盘缓存（对齐 Electron MusicCacheService 的产品行为）：
 * - 命中：直接返回 file:// 本地音频文件（第二次听更快、可离线）。
 * - 未命中：后台把音频文件落盘到缓存目录（fire-and-forget，不阻塞当前播放），
 *   由 sidecar 登记进 LRU 索引、按容量上限淘汰。
 * 只对"可重新拉取的普通在线歌曲 CDN 直链"生效；播客 / 服务插件 / 本地流代理（ephemeral）一律跳过。
 * 全程 try/catch + 超时兜底，任何失败都回落到原 URL，绝不影响正常播放。
 */
async function maybeApplyPlaybackFileCache(
  song: SongList,
  quality: string,
  playableUrl: string,
  urlData: any,
  isCache: boolean,
  isPodcast: boolean,
  isServicePlugin: boolean,
): Promise<string> {
  if (!isCache || isPodcast || isServicePlugin) return playableUrl
  if (typeof playableUrl !== 'string' || !/^https?:\/\//i.test(playableUrl)) return playableUrl
  if (/127\.0\.0\.1|localhost/i.test(playableUrl)) return playableUrl

  const songAny = song as any
  const identity =
    songAny.songmid || songAny.hash || `${songAny.name || ''}_${songAny.singer || ''}`
  if (!identity) return playableUrl
  const key = `${songAny.source || ''}:${identity}:${quality}`

  const api = (window as any).api?.musicCache
  if (!api || typeof api.playbackGet !== 'function') return playableUrl

  const headers =
    (typeof urlData === 'object' && urlData ? (urlData as any).headers : null) ||
    songAny.__nativeMedia?.headers ||
    {}

  // 命中检查（限时，失败即回落）
  try {
    const hit: any = await withPlaybackCacheTimeout<any>(
      api.playbackGet(key) as Promise<any>,
      800
    )
    if (hit?.hit && typeof hit.url === 'string' && hit.url) return hit.url
  } catch {
    /* 命中检查失败 → 用原 URL 播放 */
  }

  // 未命中：后台落盘（不 await，绝不阻塞当前播放）
  void api
    .playbackCache({
      key,
      url: playableUrl,
      headers,
      name: songAny.name,
      artist: songAny.singer,
      quality,
    })
    .catch(() => undefined)

  return playableUrl
}

/**
 * 获取歌曲真实播放URL
 * @param song 歌曲对象
 * @returns 真实播放URL
 */
export async function getSongRealUrl(song: SongList): Promise<string> {
  try {
    if ((song as any).source === 'local') {
      const id = (song as any).songmid
      const url = await (window as any).api.localMusic.getUrlById(id)
      if (typeof url === 'object' && url?.error) throw new Error(url.error)
      if (typeof url === 'string') return url
      throw new Error('本地歌曲URL获取失败')
    }
    // 服务插件歌曲要重新走主进程取流，确保每次请求都带认证信息；普通直链继续兼容。
    const servicePluginId = (song as any)._servicePluginId
    if ((song as any).url && typeof (song as any).url === 'string' && !servicePluginId) {
      return (song as any).url
    }
    const LocalUserDetail = LocalUserDetailStore()
    const quality = getPreferredPlaybackQuality((song as any).source, LocalUserDetail.userInfo)
    // 读取设置：是否启用缓存
    const settingsStore = useSettingsStore()
    const isCache = settingsStore.settings.autoCacheMusic ?? true

    const qualitiesToTry = getPlaybackQualityCandidates(song, quality, LocalUserDetail.userInfo)

    const activePluginId = servicePluginId || LocalUserDetail.userSource.pluginId
    const podcastProgram = isPodcastProgram(song)
    if (activePluginId && !podcastProgram) {
      void (window as any).api?.plugins?.pinPlugin?.(String(activePluginId))
    }
    const isBuiltinPlayableSource = ['wy', 'kg', 'kw', 'tx', 'mg'].includes(
      String(song.source || '')
    )
    if (!activePluginId && !podcastProgram && !isBuiltinPlayableSource) {
      throw new Error('当前歌曲没有可用的插件或内置音源')
    }

    let lastError: any = null
    // 播客只打官方链路，不要拿当前音乐插件/一堆音质去碰它。
    const qualitiesForRequest = podcastProgram
      ? ['exhigh']
      : qualitiesToTry
    for (const qualityToTry of qualitiesForRequest) {
      const urlData = await window.api.music.requestSdk('getMusicUrl', {
        pluginId: podcastProgram ? undefined : activePluginId,
        source: song.source || (podcastProgram ? 'wy' : song.source),
        songInfo: song as any,
        quality: qualityToTry,
        // Electron also skips durable URL cache for official podcast play URLs.
        isCache: podcastProgram ? false : isCache
      })

      let playableUrl = extractPlayableUrl(urlData)
      // 服务插件返回的鉴权流必须先走本地代理；否则 WKWebView 会丢掉 Cookie。
      if (isPlayableUrl(playableUrl) && (servicePluginId || (song as any)?.source === 'feiniu')) {
        try {
          const headers =
            (typeof urlData === 'object' && urlData ? (urlData as any).headers : null) ||
            (song as any)?.__nativeMedia?.headers ||
            {}
          const wrap = (window as any).api?.images?.wrapPlaybackUrl
          const proxied =
            typeof wrap === 'function'
              ? await wrap(playableUrl, { ...(song as any), __nativeMedia: { headers } })
              : await (window as any).api?.nativeAudio?.getAnalyserUrl?.({
                  url: playableUrl,
                  headers,
                })
          if (typeof proxied === 'string' && proxied.trim()) playableUrl = proxied.trim()
        } catch {}
      }
      if (isPlayableUrl(playableUrl)) {
        // 在线播放自动落盘缓存（对齐 Electron）：命中直接播本地 file://，未命中后台下载落盘到缓存目录。
        return await maybeApplyPlaybackFileCache(
          song,
          qualityToTry,
          playableUrl,
          urlData,
          isCache,
          podcastProgram,
          Boolean(servicePluginId)
        )
      }
      // Electron accepts any non-empty string that does not look like an error,
      // 但聚合音源会返回只带 host 的 CDN 根地址。那种串交给 mpv 只会"加载
      // 成功却不出声"，所以这里也要过一遍可播放性判断，逼上层继续降档换源。
      if (typeof urlData === 'string' && isPlayableUrl(urlData) && !urlData.includes('error')) {
        return urlData
      }
      if (typeof urlData === 'object' && urlData?.error) {
        lastError = urlData.error
        continue
      }
      lastError = '获取歌曲播放链接失败'
    }

    throw new Error(lastError || '获取歌曲播放链接失败')
  } catch (error: any) {
    console.error('获取歌曲URL失败,换个插件看看吧:', error)
    throw new Error('获取歌曲播放链接失败' + error.message)
  }
}

/**
 * 添加歌曲到播放列表第一项并播放
 * @param song 要添加的歌曲
 * @param localUserStore LocalUserDetail store实例
 * @param playSongCallback 播放歌曲的回调函数
 */
export async function addToPlaylistAndPlay(
  song: SongList,
  localUserStore: any,
  playSongCallback: (
    song: SongList,
    options?: { immediate?: boolean; shouldAutoStart?: () => boolean }
  ) => Promise<void>
) {
  /* 一起听 member:不修改本地 list,不调 playSong,直接提交点歌请求 */
  if (await tryRequestSongAsMember(song)) return
  /* 一起听 host/admin:先 ctl:queue-add 让 server 增量入队,广播 QUEUE_UPDATE 同步给
   * 所有成员;不阻塞后续 playSong 切歌流程(切歌走 ctl:change-song 单独的命令)。 */
  void tryAddToQueueAsHost(song)
  try {
    const getSongIdentity = (item: SongList) =>
      item.songmid || item.hash || `${item.name}_${item.singer}`
    const currentId = localUserStore.userInfo?.lastPlaySongId
    const currentSource = localUserStore.userInfo?.lastPlaySongSource
    const currentIndex =
      currentId !== undefined && currentId !== null
        ? localUserStore.list.findIndex(
            (item: SongList) => getSongIdentity(item) === currentId && item.source === currentSource
          )
        : -1

    // 如果目标歌曲已在列表中，先移除以避免重复
    const targetId = getSongIdentity(song)
    const existingIndex = localUserStore.list.findIndex(
      (item: SongList) => getSongIdentity(item) === targetId && item.source === song.source
    )
    if (existingIndex !== -1) {
      localUserStore.list.splice(existingIndex, 1)
    }

    if (currentIndex !== -1) {
      // 正在播放：插入到当前歌曲的下一首
      localUserStore.list.splice(currentIndex + 1, 0, song)
    } else {
      // 未在播放：添加到第一位
      localUserStore.addSongToFirst(song)
    }

    // 播放插入的歌曲
    console.log('播放插入的歌曲:', song)
    const playResult = playSongCallback(song, { immediate: true })
    if (playResult && typeof playResult.then === 'function') {
      await playResult
    }
  } catch (error: any) {
    console.error('播放失败:', error)
    if (error.message) {
      await MessagePlugin.error('播放失败了: ' + error.message)
      return
    }
    await MessagePlugin.error('播放失败了，可能还没有版权')
  }
}

/**
 * 添加歌曲到播放列表末尾
 * @param song 要添加的歌曲
 * @param localUserStore LocalUserDetail store实例
 */
export async function addToPlaylistEnd(song: SongList, localUserStore: any) {
  /* 一起听 member:走点歌审核,不修改本地 list */
  if (await tryRequestSongAsMember(song)) return
  /* 一起听 host/admin:增量入队 server queue,member 通过 QUEUE_UPDATE 看到 */
  void tryAddToQueueAsHost(song)
  try {
    // 检查歌曲是否已在播放列表中
    const existingIndex = localUserStore.list.findIndex(
      (item: SongList) => item.songmid === song.songmid
    )

    if (existingIndex !== -1) {
      await MessagePlugin.warning('歌曲已在播放列表中')
      return
    }

    // 使用store的方法添加歌曲
    localUserStore.addSong(song)

    await MessagePlugin.success('已添加到播放列表')
  } catch (error) {
    console.error('添加到播放列表失败:', error)
    await MessagePlugin.error('添加失败，请重试')
  }
}

/**
 * 替换整个播放列表
 * @param songs 要替换的歌曲列表
 * @param localUserStore LocalUserDetail store实例
 * @param playSongCallback 播放歌曲的回调函数
 */
export async function replacePlaylist(
  songs: SongList[],
  localUserStore: any,
  playSongCallback: (song: SongList) => Promise<void>
) {
  try {
    if (songs.length === 0) {
      await MessagePlugin.warning('歌曲列表为空')
      return
    }

    /* 一起听 member:批量替换列表语义不适合"点歌"流程,只取第一首作为点歌请求,
     * 其它歌曲忽略 + 提示用户。avoid 改本地共享列表破坏房间同步状态。 */
    const { useListenTogetherStore } = await import('@renderer/store')
    const lt = useListenTogetherStore()
    if (lt.isInRoom && !lt.canControl) {
      const first = songs[0]
      if (first) {
        lt.requestSong({
          songmid: String(first.songmid),
          source: first.source,
          name: first.name,
          singer: first.singer,
          cover: (first as any).img,
          albumName: first.albumName,
          albumId: first.albumId !== undefined ? String(first.albumId) : undefined,
          hash: first.hash,
          types: first.types,
          lrc: (first as any).lrc ?? null
        })
        await MessagePlugin.success(
          `已提交点歌《${first.name || '?'}》,等待管理员审核(房间内一次只能点一首)`
        )
      }
      return
    }

    localUserStore.replaceSongList(songs)

    /* 一起听 host/admin:整体替换共享列表是明确意图(用户换了个歌单),需要把整个 list
     * 同步到 server queue 让 member 看到。走 syncRoomContextFromLocal 整体上传。
     * 已加 canControl 守卫(上面 member 路径已早 return)。 */
    if (lt.isInRoom && lt.canControl) {
      await lt.syncRoomContextFromLocal({ queueOnly: true })
    }

    // 播放第一首歌曲
    if (songs[0]) {
      const playResult = playSongCallback(songs[0])
      if (playResult && typeof playResult.then === 'function') {
        await playResult
      }
    }

    await MessagePlugin.success(`已用 ${songs.length} 首歌曲替换播放列表`)
  } catch (error: any) {
    console.error('替换播放列表失败:', error)
    if (error.message) {
      await MessagePlugin.error('替换失败: ' + error.message)
      return
    }
    await MessagePlugin.error('替换播放列表失败，请重试')
  }
}

/**
 * 初始化播放列表事件监听器
 * @param localUserStore LocalUserDetail store实例
 * @param playSongCallback 播放歌曲的回调函数
 */
export function initPlaylistEventListeners(
  localUserStore: any,
  playSongCallback: (song: SongList) => Promise<void>
) {
  if (playlistEventListenersInstalled) return
  playlistEventListenersInstalled = true

  // 监听添加到播放列表并播放的事件
  emitter.on('addToPlaylistAndPlay', async (song: SongList) => {
    await addToPlaylistAndPlay(song, localUserStore, playSongCallback)
  })

  // 监听添加到播放列表末尾的事件
  emitter.on('addToPlaylistEnd', async (song: SongList) => {
    await addToPlaylistEnd(song, localUserStore)
  })

  // 监听替换播放列表的事件
  emitter.on('replacePlaylist', async (songs: SongList[]) => {
    await replacePlaylist(songs, localUserStore, playSongCallback)
  })
}

/**
 * 清理播放列表事件监听器
 */
export function destroyPlaylistEventListeners() {
  emitter.off('addToPlaylistAndPlay')
  emitter.off('addToPlaylistEnd')
  emitter.off('replacePlaylist')
  playlistEventListenersInstalled = false
}

/**
 * 触发添加歌曲到播放列表并播放的事件
 * @param song 要添加的歌曲
 */
export function triggerAddToPlaylistAndPlay(song: SongList): boolean {
  const handlers = emitter.all.get('addToPlaylistAndPlay')
  if (!handlers || handlers.length === 0) {
    console.error('播放器事件尚未初始化，无法播放歌曲')
    return false
  }
  emitter.emit('addToPlaylistAndPlay', song)
  return true
}

/**
 * 触发添加歌曲到播放列表末尾的事件
 * @param song 要添加的歌曲
 */
export function triggerAddToPlaylistEnd(song: SongList): boolean {
  const handlers = emitter.all.get('addToPlaylistEnd')
  if (!handlers || handlers.length === 0) {
    console.error('播放器事件尚未初始化，无法添加到播放列表')
    return false
  }
  emitter.emit('addToPlaylistEnd', song)
  return true
}

/**
 * 获取全局事件总线实例
 */
export function getPlaylistEmitter() {
  return emitter
}

/**
 * 将搜索结果转换为SongList格式
 * @param searchResult 搜索结果中的歌曲数据
 * @returns 转换后的SongList对象
 */
export function convertSearchResultToSongList(searchResult: any): SongList {
  return searchResult
}
