import { toRaw } from 'vue'

const podcastBridge = () => (window.api.podcast as any)

const plain = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(toRaw(value as any))) as T
  } catch {
    return toRaw(value as any) as T
  }
}

export const isPodcastProgram = (song: any): boolean =>
  Boolean(song?.contentType === 'radio-program' || song?.programId || song?.podcastProgramId)

export const podcastApi = {
  getLoginState: () => podcastBridge().getLoginState?.() || Promise.resolve({ loggedIn: false }),
  createQr: () => podcastBridge().createQr?.() || Promise.resolve({}),
  checkQr: (key: string) => podcastBridge().checkQr?.(key) || Promise.resolve({}),
  logout: () => podcastBridge().logout?.() || Promise.resolve(),
  getCategories: (forceRefresh = false) => podcastBridge().getCategories?.(forceRefresh) || podcastBridge().getCategories?.() || Promise.resolve([]),
  getCategoryPage: (payload: Record<string, any>) => podcastBridge().getCategoryPage?.(plain(payload)) || podcastBridge().getCategoryPrograms?.(String(payload.categoryId || payload.id || ''), payload.page || 1, payload.limit || 30) || Promise.resolve({ list: [], radios: [] }),
  getCategoryTotal: (payload: Record<string, any>) => podcastBridge().getCategoryTotal?.(plain(payload)) || Promise.resolve(0),
  getHomeChannel: (payload: Record<string, any>) => podcastBridge().getHomeChannel?.(plain(payload)) || podcastBridge().getRecommendations?.(payload.limit || 30) || Promise.resolve({ radios: [] }),
  search: (payload: Record<string, any>) => podcastBridge().search?.(plain(payload)) || Promise.resolve({ list: [], total: 0 }),
  getPrograms: (payload: Record<string, any>) => podcastBridge().getPrograms?.(plain(payload)) || Promise.resolve({ list: [], total: 0 }),
  getRadioDetail: (radioId: string) => podcastBridge().getRadioDetail?.(radioId) || Promise.resolve(null),
  getPlayUrl: (payload: Record<string, any>) => podcastBridge().getPlayUrl?.(plain(payload)) || Promise.resolve(null),
  getProgramLyric: (song: any) => podcastBridge().getProgramLyric?.(plain(song)) || Promise.resolve({ lyric: '' })
}

export default podcastApi
