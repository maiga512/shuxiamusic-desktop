import defaultCover from '/default-cover.png'
import songListAPI from '@renderer/api/songList'
import { resolveSongCover as resolveSongCoverBySearch } from '@renderer/utils/audio/coverResolver'

const INVALID_COVER_VALUES = new Set([
  '',
  'default-cover',
  '/default-cover.png',
  'resources/logo.png',
  'logo.svg'
])

export function isUsableCover(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return normalized.length > 0 && !INVALID_COVER_VALUES.has(normalized)
}

function extractCoverUrl(value: any): string {
  if (typeof value === 'string') return value.trim()
  if (!value || typeof value !== 'object') return ''
  return String(
    value.url ||
      value.body ||
      value.data?.url ||
      value.data?.body ||
      value.picUrl ||
      value.pic_url ||
      value.cover ||
      value.img ||
      ''
  ).trim()
}

export async function resolveSongCover(song: any, source?: string): Promise<string> {
  if (!song || typeof song !== 'object') return ''
  const servicePluginId = String(song._servicePluginId || '').trim()
  // Service-plugin artwork can require its authenticated session cookie. Fetch
  // it through the plugin bridge instead of trusting a URL that returns JSON.
  if (isUsableCover(song.img) && !servicePluginId) return song.img

  let coverSource = source || song.source || song._servicePluginId || ''
  if (!coverSource || coverSource === 'all') {
    coverSource = song.source || song._servicePluginId || ''
  }
  if (!coverSource || coverSource === 'local') return ''

  try {
    const result = await window.api.music.requestSdk('getPic', {
      source: coverSource,
      songInfo: song
    })
    const cover = extractCoverUrl(result)
    if (isUsableCover(cover)) {
      song.img = cover
      return cover
    }
  } catch {}

  // Electron falls back to searching the configured music sources when the
  // provider does not expose reliable artwork. Reuse that exact matcher so a
  // missing playlist/song cover does not leave a broken image in the UI.
  try {
    const searched = await resolveSongCoverBySearch({ ...song, img: '' }, { skipGetPic: true })
    if (isUsableCover(searched)) {
      song.img = searched
      return searched
    }
  } catch {}

  return ''
}

async function resolveFirstPlaylistSongCover(
  songs: any[],
  source: string,
  concurrency = 4
): Promise<string> {
  const candidates = songs.filter(Boolean).slice(0, 24)
  if (candidates.length === 0) return ''

  let cursor = 0
  let resolved = ''
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, candidates.length)) },
    async () => {
      while (!resolved && cursor < candidates.length) {
        const song = candidates[cursor++]
        const cover = await resolveSongCover(song, song?.source || source)
        if (cover && !resolved) resolved = cover
      }
    }
  )
  await Promise.all(workers)
  return resolved
}

export async function hydrateMissingSongCovers(
  songs: any[],
  source: string,
  concurrency = 6
): Promise<void> {
  const pending = songs.filter((song) => song && !isUsableCover(song.img))
  if (pending.length === 0) return

  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, pending.length)) },
    async () => {
      while (cursor < pending.length) {
        const index = cursor++
        await resolveSongCover(pending[index], source)
      }
    }
  )
  await Promise.all(workers)
}

export async function resolvePlaylistCover(options: {
  songs?: any[]
  source?: string
  currentCover?: string
  playlistId?: string
  persist?: boolean
}): Promise<string> {
  const { songs = [], source = '', currentCover = '', playlistId = '', persist = false } = options
  const resolvedCurrent = isUsableCover(currentCover) ? currentCover.trim() : ''

  let cover = resolvedCurrent
  if (!cover) {
    cover = await resolveFirstPlaylistSongCover(songs, source)
  }

  const finalCover = cover || defaultCover
  if (persist && playlistId && finalCover !== resolvedCurrent) {
    await songListAPI.updateCover(playlistId, finalCover).catch(() => null)
  }
  return finalCover
}
