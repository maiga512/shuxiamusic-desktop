import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { ControlAudioStore } from '@renderer/store/ControlAudio'

import type { SongList } from '@renderer/types/audio'
import type { UserInfo } from '@renderer/types/userInfo'

const SONG_LIST_SAVE_DELAY_MS = 400
const USER_INFO_SAVE_DELAY_MS = 1200
// 对齐安卓 3s 节流：进度变化单独用更短的节流窗口写盘，不再被 watch 去重吞掉
const CURRENT_TIME_SAVE_DELAY_MS = 3000
let songListSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSongList: SongList[] | null = null
let songListFlushBound = false
let userInfoSaveTimer: ReturnType<typeof setTimeout> | null = null
let pendingUserInfo: UserInfo | null = null
let currentTimeSaveTimer: ReturnType<typeof setTimeout> | null = null

function persistSongList(songs: SongList[]) {
  localStorage.setItem('songList', JSON.stringify(songs))
}

function flushPendingSongList() {
  if (songListSaveTimer !== null) {
    clearTimeout(songListSaveTimer)
    songListSaveTimer = null
  }
  if (!pendingSongList) return
  persistSongList(pendingSongList)
  pendingSongList = null
}

function scheduleSongListPersist(songs: SongList[]) {
  pendingSongList = songs
  if (songListSaveTimer !== null) clearTimeout(songListSaveTimer)
  songListSaveTimer = setTimeout(() => {
    songListSaveTimer = null
    if (!pendingSongList) return
    persistSongList(pendingSongList)
    pendingSongList = null
  }, SONG_LIST_SAVE_DELAY_MS)
}

function persistUserInfo(info: UserInfo) {
  localStorage.setItem('userInfo', JSON.stringify(info))
}

function flushPendingUserInfo() {
  if (userInfoSaveTimer !== null) {
    clearTimeout(userInfoSaveTimer)
    userInfoSaveTimer = null
  }
  if (currentTimeSaveTimer !== null) {
    clearTimeout(currentTimeSaveTimer)
    currentTimeSaveTimer = null
  }
  if (!pendingUserInfo) return
  persistUserInfo(pendingUserInfo)
  pendingUserInfo = null
}

function scheduleUserInfoPersist(info: UserInfo) {
  pendingUserInfo = info
  if (userInfoSaveTimer !== null) clearTimeout(userInfoSaveTimer)
  userInfoSaveTimer = setTimeout(() => {
    userInfoSaveTimer = null
    if (!pendingUserInfo) return
    persistUserInfo(pendingUserInfo)
    pendingUserInfo = null
  }, USER_INFO_SAVE_DELAY_MS)
}

// currentTime 高频变化走独立的 3s 节流（对齐安卓 persistPlaybackState），
// 避免被下面的"非进度字段去重"直接吞掉导致进度长时间不落盘。
function scheduleCurrentTimePersist(info: UserInfo) {
  pendingUserInfo = info
  if (currentTimeSaveTimer !== null) return
  currentTimeSaveTimer = setTimeout(() => {
    currentTimeSaveTimer = null
    if (!pendingUserInfo) return
    persistUserInfo(pendingUserInfo)
    pendingUserInfo = null
  }, CURRENT_TIME_SAVE_DELAY_MS)
}

function ensureSongListFlushListeners() {
  if (songListFlushBound || typeof window === 'undefined') return
  songListFlushBound = true
  window.addEventListener('pagehide', flushPendingSongList)
  window.addEventListener('beforeunload', flushPendingSongList)
  window.addEventListener('pagehide', flushPendingUserInfo)
  window.addEventListener('beforeunload', flushPendingUserInfo)
}

export const LocalUserDetailStore = defineStore(
  'Local',
  () => {
    // 播放队列改用 shallowRef：不再为队列里每一首歌逐字段建响应式代理，
    // 大队列内存显著下降。代价是所有增删改必须整表替换（下面几个 helper 已改），
    // 不能再就地 push/splice/unshift。
    const list = shallowRef<SongList[]>([])
    const userInfo = ref<UserInfo>({})
    const initialization = ref(false)
    const isWatchStarted = ref(false) // 防止重复创建 watch
    let lastStableUserInfo = ''

function init(): void {
      // 幂等保护：Provider 与播放模块都会确保本地状态已加载，
      // 重复执行会把内存里的新进度用旧的持久化值覆盖回去。
      if (initialization.value) return
      const UserInfoLocal = localStorage.getItem('userInfo')
      const ListLocal = localStorage.getItem('songList')
      if (UserInfoLocal) {
        userInfo.value = JSON.parse(UserInfoLocal) as UserInfo
        if (!userInfo.value.sourceQualityMap) userInfo.value.sourceQualityMap = {}
        // 0 是合法的持久化音量（用户主动拖到 0% = 静音），必须保留；
        // 只有缺失/非数字/越界才回退到 80。旧代码把 0 改成 80，
        // 会让"上次拖到 0"的用户重启后又突然有声音。
        const persistedVolume = Number(userInfo.value.volume)
        userInfo.value.volume = Number.isFinite(persistedVolume)
          ? Math.max(0, Math.min(100, persistedVolume))
          : 80
      } else {
        userInfo.value = {
          lastPlaySongId: null,
          topBarStyle: false,
          mainColor: '#00DAC0',
          volume: 80,
          currentTime: 0,
          selectSources: 'wy',
          sourceQualityMap: {},
          hasGuide: false
        }
        localStorage.setItem('userInfo', JSON.stringify(userInfo.value))
      }
      if (ListLocal) {
        list.value = JSON.parse(ListLocal) as SongList[]
      } else {
        list.value = []
        localStorage.setItem('songList', JSON.stringify([]))
      }
      console.log('init local user detail')
      initialization.value = true
      const Audio = ControlAudioStore()
      startWatch()
      Audio.setVolume(userInfo.value.volume as number)
    }
    function startWatch() {
      // 防止重复创建 watch
      if (isWatchStarted.value) {
        console.log('watch already started, skipping')
        return
      }
      isWatchStarted.value = true
      console.log('startWatch')
      ensureSongListFlushListeners()
      const persistNow = () => persistUserInfo(userInfo.value)
      window.addEventListener('pagehide', persistNow)
      window.addEventListener('ceru-sleep', persistNow)
      watch(
        list,
        (newVal) => {
          scheduleSongListPersist(newVal)
        }
        // list 现在是 shallowRef，所有变更都整表替换 .value，
        // 不需要 deep 深遍历，reassign 即可触发落盘。
      )
      watch(
        userInfo,
        (newVal) => {
          const stable = JSON.stringify({ ...newVal, currentTime: 0 })
          if (stable !== lastStableUserInfo) {
            lastStableUserInfo = stable
            scheduleUserInfoPersist(newVal)
            return
          }
          // 只有进度变化也按 3s 节流落盘，保证暂停/退出后能恢复到最近位置
          scheduleCurrentTimePersist(newVal)
        },
        {
          deep: true
        }
      )
    }

    function addSong(song: SongList) {
      if (!list.value.find((item) => item.songmid === song.songmid)) {
        list.value = [...list.value, song]
      }

      return list.value
    }

    function addSongToFirst(song: SongList) {
      const existingIndex = list.value.findIndex((item) => item.songmid === song.songmid)
      if (existingIndex !== -1) {
        // 如果歌曲已存在，将其移动到第一位
        const next = [...list.value]
        const [existingSong] = next.splice(existingIndex, 1)
        next.unshift(existingSong)
        list.value = next
      } else {
        // 如果歌曲不存在，添加到第一位
        list.value = [song, ...list.value]
      }
      return list.value
    }

    function removeSong(songId: number | string) {
      const index = list.value.findIndex((item) => item.songmid === songId)
      if (index !== -1) {
        const newList = [...list.value]
        newList.splice(index, 1)
        list.value = newList
      }
    }

    function clearList() {
      list.value = []
    }
    function replaceSongList(songs: SongList[]) {
      const seen1 = new Set<string | number>()
      console.log(
        'origin',
        songs.filter((item) => {
          const keyValue = item.songmid
          if (seen1.has(keyValue)) {
            return false
          } else {
            seen1.add(keyValue)
            return true
          }
        })
      )

      const seen = new Set<string | number>()
      const deduped: SongList[] = []
      for (const s of songs) {
        const mid = (s as any).songmid
        if (!seen.has(mid)) {
          seen.add(mid)
          deduped.push(s)
        }
      }
      console.log('size', seen.size)
      list.value = deduped
      return list.value
    }
    const userSource = computed(() => {
      return {
        pluginId: userInfo.value.pluginId,
        source: userInfo.value.selectSources,
        quality:
          (userInfo.value.sourceQualityMap || {})[userInfo.value.selectSources as string] ||
          userInfo.value.selectQuality
      }
    })
    return {
      list,
      userInfo,
      initialization,
      init,
      addSong,
      addSongToFirst,
      removeSong,
      clearList,
      replaceSongList,
      userSource
    }
  },
  {
    persist: false
  }
)
