/**
 * 主页板块空闲预热：应用启动/进入主页稳定后，把「发现」「播客」的首屏首批数据
 * 在后台写入 sessionCache。各页面视图已有 SWR（命中缓存立即渲染、后台刷新），
 * 预热后第一次点板块就有内容。
 *
 * 内存口径：只缓存元数据（歌单/分类/封面 URL 列表），不保留任何 DOM；
 * 单次预热 3~4 个小请求，失败静默（视图首次进入时仍走原网络路径，行为不变）。
 */
import { storeToRefs } from 'pinia'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { getSessionCache, setSessionCache } from '@renderer/utils/cache/sessionCache'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'
import { podcastApi } from '@renderer/api/podcast'

const PREFETCH_DELAY_MS = 1200
let scheduled = false

// —— 与 find.vue 保持同步 ——
const DISCOVER_LIMIT = 30
const mapDiscoverItem = (item: any) => ({
  id: item.id,
  title: item.name,
  description: item.desc || '精选歌单',
  cover: item.img || '/default-cover.png',
  playCount: item.play_count,
  author: item.author,
  total: item.total,
  time: item.time,
  source: item.source
})

// —— 与 podcast.vue 保持同步（列数锁死 5、每页 3 行）——
const PODCAST_PAGE_SIZE = 5 * 3
const plainCategory = (category?: { id: number; rawId?: string; name: string; subCategories?: { id: string; name: string }[] } | null) => {
  if (!category) return null
  return {
    id: category.id,
    rawId: category.rawId || '',
    name: category.name,
    subCategories: (category.subCategories || []).map((item) => ({
      id: item.id,
      name: item.name
    }))
  }
}

async function prefetchDiscover(): Promise<void> {
  try {
    const { userSource } = storeToRefs(LocalUserDetailStore())
    const source = userSource.value.source || 'wy'
    const api = (window as any).api?.music?.requestSdk

    const tagsKey = `discover:tags:${source}`
    if (!getSessionCache(tagsKey)) {
      const res = await api?.('getPlaylistTags', { source })
      if (source !== (userSource.value.source || 'wy')) return
      setSessionCache(tagsKey, {
        tags: res?.tags || [],
        hotTag: res?.hotTag || []
      })
    }

    const listKey = `discover:playlists:${source}::hot`
    if (!getSessionCache(listKey)) {
      const res = await api?.('getCategoryPlaylists', {
        source,
        sortId: 'hot',
        tagId: '',
        page: 1,
        limit: DISCOVER_LIMIT
      })
      if (source !== (userSource.value.source || 'wy')) return
      const rawList = Array.isArray(res?.list) ? res.list : []
      const list = rawList.map(mapDiscoverItem)
      const total = Number(res?.total || 0)
      setSessionCache(listKey, {
        list,
        page: 2,
        total,
        noMore: list.length >= total || list.length === 0
      })
    }
  } catch (e) {
    console.warn('发现页预热失败（忽略，进入页面仍走正常加载）:', e)
  }
}

async function prefetchPodcast(): Promise<void> {
  try {
    const categories = (await podcastApi.getCategories(true)) || []
    const first = Array.isArray(categories) ? categories[0] : null
    if (!first) return
    const pageKey = `podcast:page:${first.rawId || first.name}::1:${PODCAST_PAGE_SIZE}`
    if (getSessionCache(pageKey)) return
    const res = await podcastApi.getCategoryPage({
      category: plainCategory(first),
      secondName: undefined,
      page: 1,
      pageSize: PODCAST_PAGE_SIZE
    })
    if (res) setSessionCache(pageKey, res)
  } catch (e) {
    console.warn('播客页预热失败（忽略，进入页面仍走正常加载）:', e)
  }
}

/** 进入主页后调用：延迟到空闲、全程只写缓存、每会话一次。 */
export function scheduleHomePrefetch(): void {
  if (scheduled) return
  scheduled = true
  window.setTimeout(() => {
    if (!isAppWindowVisible()) return
    void prefetchDiscover()
    void prefetchPodcast()
  }, PREFETCH_DELAY_MS)
}
