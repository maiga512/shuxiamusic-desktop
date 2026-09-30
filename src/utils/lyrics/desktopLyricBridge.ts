import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { useGlobalPlayStatusStore } from '@renderer/store/GlobalPlayStatus'
import { useSettingsStore } from '@renderer/store/Settings'
import { storeToRefs } from 'pinia'
import { watch } from 'vue'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { isPageIdle } from '@renderer/utils/idleSleep'
import { isNativePlaybackActive, nativeCurrentTime } from '@renderer/utils/audio/nativePlayback'

interface LyricWord {
  word: string
}
interface LyricLine {
  startTime: number
  endTime: number
  words: LyricWord[]
  translatedLyric?: string
}

let installed = false
let playStateInterval: number | null = null
let isLyricWindowOpen = false
let visibilityHandler: (() => void) | null = null

const MENU_BAR_VISIBLE_INTERVAL_MS = 280
const MENU_BAR_HIDDEN_INTERVAL_MS = 1000
const DESKTOP_LYRIC_INTERVAL_MS = 80
const IDLE_INTERVAL_MS = 5000

function buildLyricPayload(lines: LyricLine[]) {
  return JSON.parse(JSON.stringify(lines || []))
}

function computeLyricIndex(timeMs: number, lines: LyricLine[]) {
  if (!lines || lines.length === 0) return -1
  const t = timeMs
  const i = lines.findIndex((l) => t >= l.startTime && t < l.endTime)
  if (i !== -1) return i
  for (let j = lines.length - 1; j >= 0; j--) {
    if (t >= lines[j].startTime) return j
  }
  return -1
}

export function installDesktopLyricBridge() {
  if (installed) return
  installed = true

  const controlAudio = ControlAudioStore()
  const globalPlayStatus = useGlobalPlayStatusStore()
  const settingsStore = useSettingsStore()
  const { player } = storeToRefs(globalPlayStatus)
  const localUserStore = LocalUserDetailStore()
  const { userInfo } = storeToRefs(localUserStore)

  let lastIndex = -1
  let lastPlayState: any = undefined
  let lastSongKey = ""

  const getCurrentTimeMs = () => {
    if (isNativePlaybackActive()) {
      return Math.round((nativeCurrentTime() || 0) * 1000)
    }
    const audioEl = controlAudio.Audio.audio
    const rawTime =
      audioEl && Number.isFinite(audioEl.currentTime)
        ? audioEl.currentTime
        : controlAudio.Audio.currentTime
    return Math.round((rawTime || 0) * 1000)
  }

const needsMenuBarLyric = () => Boolean(settingsStore.settings.macStatusBarLyricEnabled)
  const needsDesktopLyric = () => isLyricWindowOpen
  const needsLyricConsumers = () => needsMenuBarLyric() || needsDesktopLyric()

  const syncLyricConsumerFlags = () => {
    try {
      ;(window as any).__CERU_DESKTOP_LYRIC_OPEN__ = isLyricWindowOpen
      ;(window as any).__CERU_SETTINGS__ = {
        ...((window as any).__CERU_SETTINGS__ || {}),
        macStatusBarLyricEnabled: Boolean(settingsStore.settings.macStatusBarLyricEnabled),
      }
    } catch {}
  }
  syncLyricConsumerFlags()

  const resolveTimeMs = () => {
    let ms = getCurrentTimeMs()
    if (ms <= 0) {
      const currentSong = player.value.songInfo as any
      const lastId = userInfo.value?.lastPlaySongId
      const songId = currentSong?.songmid
      const restoreMs = Math.round(Number(userInfo.value?.currentTime || 0) * 1000)
      if (lastId && songId && lastId === songId && restoreMs > 0) {
        ms = restoreMs
      }
    }
    return ms
  }

  watch(
    () => player.value.lyrics.lines,
    (lines) => {
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-change', buildLyricPayload(lines))
      pushSnapshot()
    },
    { immediate: true }
  )

  watch(
    () => player.value.songInfo,
    (song) => {
      try {
        const name = (song as any)?.name || ''
        const artist = (song as any)?.singer || ''
        // Don't blank the desktop lyric to "纯音乐" on every song change.
        // Lyrics often arrive a tick later; clearing first causes a sticky
        // placeholder until another manual switch. Title updates immediately,
        // and the lyrics watcher / pushSnapshot replace lines when ready.
        if (name || artist) {
          ;(window as any)?.electron?.ipcRenderer?.send?.('play-song-change', { name, artist })
        }
        pushSnapshot()
      } catch {}
    },
    { immediate: true }
  )

  const checkPlayState = () => {
    if (controlAudio.Audio.isPlay !== lastPlayState) {
      lastPlayState = controlAudio.Audio.isPlay
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-status-change', lastPlayState)
    }
  }
  watch(() => controlAudio.Audio.isPlay, checkPlayState, { immediate: true })

  watch(
    () => [player.value.isLoading, player.value.lyrics.lines] as const,
    ([loading, lines]) => {
      if (!loading) {
        ;(window as any)?.electron?.ipcRenderer?.send?.(
          'play-lyric-change',
          buildLyricPayload((lines as any[]) || [])
        )
        pushSnapshot()
      }
    }
  )

  function pushSnapshot() {
    // Send unconditionally — the timer and song/lyrics watchers must never be
    // blocked by a settings flag that may not be restored yet.
    try {
      const currentSong = player.value.songInfo as any
      const name = currentSong?.name || ''
      const artist = currentSong?.singer || ''
      if (name || artist) {
        ;(window as any)?.electron?.ipcRenderer?.send?.('play-song-change', { name, artist })
      }
      const currentLines = (player.value.lyrics?.lines as any[]) || []
      // Keep the previous lyric frame if the new song's lyrics have not arrived yet.
      // Pushing [] here is what made the desktop lyric stick on "纯音乐，请欣赏".
      if (!currentLines.length && globalPlayStatus.player?.isLoading) {
        return
      }
      ;(window as any)?.electron?.ipcRenderer?.send?.(
        'play-lyric-change',
        buildLyricPayload(currentLines)
      )
      const ms = resolveTimeMs()
      const idx = computeLyricIndex(ms, currentLines as any)
      lastIndex = idx
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-index', idx)
      // Progress is only useful for the desktop lyric window (30% gate).
      if (needsDesktopLyric()) {
        let progress = 0
        if (idx >= 0 && currentLines[idx]) {
          const line = currentLines[idx] as any
          const dur = Math.max(1, (line.endTime ?? line.startTime + 1) - line.startTime)
          progress = Math.min(1, Math.max(0, (ms - line.startTime) / dur))
        }
        ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-progress', {
          index: idx,
          progress,
          currentMs: ms,
          timestamp: performance.now()
        })
      }
      ;(window as any)?.electron?.ipcRenderer?.send?.(
        'play-status-change',
        !!controlAudio.Audio.isPlay
      )
    } catch {}
  }

  pushSnapshot()

  ;(window as any)?.electron?.ipcRenderer?.on?.('lyric-window-ready', () => {
    pushSnapshot()
  })
;(window as any)?.electron?.ipcRenderer?.on?.(
    'desktop-lyric-open-change',
    (_: any, open: boolean) => {
      isLyricWindowOpen = open
      syncLyricConsumerFlags()
      if (open) pushSnapshot()
      reschedule(open ? DESKTOP_LYRIC_INTERVAL_MS : MENU_BAR_VISIBLE_INTERVAL_MS)
    }
  )

  // Electron enables menu-bar lyric with an immediate refresh of the current
  // song/lyric snapshot. Mirror that when the setting flips on.
  watch(
    () => settingsStore.settings.macStatusBarLyricEnabled,
    (enabled) => {
      syncLyricConsumerFlags()
      if (enabled) pushSnapshot()
      reschedule(enabled ? MENU_BAR_VISIBLE_INTERVAL_MS : IDLE_INTERVAL_MS)
    },
    { immediate: true }
  )

  function reschedule(delay = MENU_BAR_VISIBLE_INTERVAL_MS) {
    if (playStateInterval !== null) {
      window.clearTimeout(playStateInterval)
      playStateInterval = null
    }
    if (!installed) return
    playStateInterval = window.setTimeout(scheduleNext, delay) as unknown as number
  }

  function scheduleNext() {
    if (!installed) {
      playStateInterval = null
      return
    }

    const menuBarOn = needsMenuBarLyric()
    const desktopOn = needsDesktopLyric()
    const hidden = document.hidden
    const idle = isPageIdle()
    const ms = resolveTimeMs()
    const currentLines = player.value.lyrics.lines || []
    const idx = computeLyricIndex(ms, currentLines)

    // Always send lyric index to Rust — even when neither consumer is flagged.
    // The needsLyricConsumers() guard in pushSnapshot() can block events during
    // settings restore race; the timer must be the reliable fallback.
    if (idx !== lastIndex) {
      lastIndex = idx
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-index', idx)
    }

    // Always send play status so Rust menu bar stays in sync
    if (controlAudio.Audio.isPlay !== lastPlayState) {
      lastPlayState = controlAudio.Audio.isPlay
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-status-change', lastPlayState)
    }

    // Detect song change — Vue watchers may be throttled when the window is hidden.
    const currentSong = player.value.songInfo as any
    const songKey = `${currentSong?.songmid || ''}|${currentSong?.name || ''}`
    if (songKey && songKey !== lastSongKey) {
      lastSongKey = songKey
      const name = currentSong?.name || ''
      const artist = currentSong?.singer || ''
      if (name || artist) {
        ;(window as any)?.electron?.ipcRenderer?.send?.('play-song-change', { name, artist })
      }
      ;(window as any)?.electron?.ipcRenderer?.send?.(
        'play-lyric-change',
        buildLyricPayload(currentLines)
      )
    }

    // Desktop lyric owns progress payloads; menu-bar only needs index changes.
    if (desktopOn && !hidden) {
      let progress = 0
      if (idx >= 0 && currentLines[idx]) {
        const line = currentLines[idx]
        const dur = Math.max(1, (line.endTime ?? line.startTime + 1) - line.startTime)
        progress = Math.min(1, Math.max(0, (ms - line.startTime) / dur))
      }
      ;(window as any)?.electron?.ipcRenderer?.send?.('play-lyric-progress', {
        index: idx,
        progress,
        currentMs: ms,
        timestamp: performance.now()
      })
    }

    // Determine next interval — keep the timer alive even when no consumer is flagged,
    // so lyric index/status always reach Rust.
    let interval: number
    if (desktopOn && !hidden && !idle) {
      interval = DESKTOP_LYRIC_INTERVAL_MS
    } else if (menuBarOn && hidden && controlAudio.Audio.isPlay) {
      interval = 2000
    } else if (menuBarOn && (hidden || idle)) {
      interval = 2000
    } else if (menuBarOn || desktopOn) {
      interval = MENU_BAR_VISIBLE_INTERVAL_MS
    } else {
      // No consumer flagged yet — keep ticking at a low rate so that when the
      // setting is restored from DB the next pushSnapshot() reaches Rust.
      interval = IDLE_INTERVAL_MS
    }

    playStateInterval = window.setTimeout(scheduleNext, interval) as unknown as number
  }

  playStateInterval = window.setTimeout(scheduleNext, 200) as unknown as number

  visibilityHandler = () => {
    pushSnapshot()
    reschedule(MENU_BAR_VISIBLE_INTERVAL_MS)
  }
  document.addEventListener('visibilitychange', visibilityHandler)
  window.addEventListener('ceru-window-state-change', visibilityHandler)
  window.addEventListener('ceru-wake', visibilityHandler)
  window.addEventListener('ceru-sync-tray-lyric', visibilityHandler)
}

export function uninstallDesktopLyricBridge() {
  if (playStateInterval !== null) {
    clearTimeout(playStateInterval)
    playStateInterval = null
  }

  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    window.removeEventListener('ceru-window-state-change', visibilityHandler)
    window.removeEventListener('ceru-wake', visibilityHandler)
    window.removeEventListener('ceru-sync-tray-lyric', visibilityHandler)
    visibilityHandler = null
  }

  installed = false
}
