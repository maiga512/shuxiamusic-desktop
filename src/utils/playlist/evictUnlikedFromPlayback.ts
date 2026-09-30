import { toRaw } from 'vue'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { playSong } from '@renderer/utils/audio/globaPlayList'
import { crossfadeManager } from '@renderer/utils/audio/crossfade'

type EvictSongLike = {
  songmid?: string | number | null
  source?: string | null
  hash?: string | null
  name?: string | null
  singer?: string | null
}

const songIdentity = (song: EvictSongLike | null | undefined) => {
  if (!song) return ''
  if (song.songmid !== undefined && song.songmid !== null && song.songmid !== '') {
    return String(song.songmid)
  }
  if (song.hash) return String(song.hash)
  return `${song.name || ''}_${song.singer || ''}`
}

const sameSong = (left: EvictSongLike | null | undefined, right: EvictSongLike | null | undefined) => {
  if (!left || !right) return false
  const leftId = songIdentity(left)
  const rightId = songIdentity(right)
  if (!leftId || !rightId || leftId !== rightId) return false
  if (left.source && right.source) return left.source === right.source
  return true
}

/**
 * 取消喜欢 / 从「我的喜欢」移出后：
 * - 若这首在当前播放队列，删掉
 * - 若正好是正在播的歌，立刻切到下一首（没有下一首就停）
 *
 * 一起听房间里只有有控制权才动共享队列；无控制权只保留取消喜欢本身。
 */
export async function evictUnlikedSongFromPlayback(song: EvictSongLike): Promise<boolean> {
  return removeSongFromPlaybackQueue(song, { skipListenTogether: false })
}

/**
 * 从播放队列删歌。若删的是正在播的那首，先记下一首再删，删完立刻播下一首；没有下一首就停。
 */
export async function removeSongFromPlaybackQueue(
  song: EvictSongLike,
  options: { skipListenTogether?: boolean } = {}
): Promise<boolean> {
  const targetId = songIdentity(song)
  if (!targetId) return false

  if (!options.skipListenTogether) {
    try {
      const { useListenTogetherStore } = await import('@renderer/store')
      const lt = useListenTogetherStore()
      if (lt.isInRoom) {
        if (!lt.canControl) return false
        const queueItem =
          lt.queue.find((item) => sameSong(item.song as any, song)) || null
        if (!queueItem?.itemId) return false
        lt.removeFromQueue(queueItem.itemId)
        return true
      }
    } catch {
      // store 未就绪时退回本地队列处理
    }
  }

  const localUserStore = LocalUserDetailStore()
  const controlAudio = ControlAudioStore()
  const queue = localUserStore.list || []
  const indexes = queue
    .map((item, index) => (sameSong(item as any, song) ? index : -1))
    .filter((index) => index >= 0)

  if (indexes.length === 0) return false

  const currentId = String(localUserStore.userInfo.lastPlaySongId || '')
  const currentSource = localUserStore.userInfo.lastPlaySongSource || ''
  const isCurrent =
    currentId === targetId && (!song.source || !currentSource || song.source === currentSource)

  let nextSong: any = null
  if (isCurrent && queue.length > 1) {
    const currentIndex = indexes[0]
    for (let offset = 1; offset < queue.length; offset++) {
      const candidate = queue[(currentIndex + offset) % queue.length]
      if (!sameSong(candidate as any, song)) {
        nextSong = candidate
        break
      }
    }
  }

  // 从后往前删，避免索引错位
  for (let i = indexes.length - 1; i >= 0; i--) {
    const item = queue[indexes[i]]
    if (item?.songmid !== undefined && item?.songmid !== null) {
      localUserStore.removeSong(item.songmid)
    }
  }

  if (!isCurrent) return true

  if (nextSong) {
    crossfadeManager.cancel()
    await playSong(toRaw(nextSong) as any, { immediate: true })
    return true
  }

  try {
    crossfadeManager.cancel()
    controlAudio.stop?.()
  } catch {
    // ignore
  }
  localUserStore.userInfo.lastPlaySongId = null as any
  localUserStore.userInfo.lastPlaySongSource = null
  return true
}
