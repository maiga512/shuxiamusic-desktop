import { ControlAudioStore } from '@renderer/store/ControlAudio'
import mediaSessionController from '@renderer/utils/audio/useSmtc'

let installed = false
let smtcTimer: any = null
let globalKeyDownHandler: ((e: KeyboardEvent) => void) | null = null
let removeMusicCtrlListener: (() => void) | null = null

function dispatch(name: string, val?: any, source?: string) {
  window.dispatchEvent(new CustomEvent('global-music-control', { detail: { name, val, source } }))
}

export function installGlobalMusicControls() {
  if (installed) return
  installed = true

  const controlAudio = ControlAudioStore()

  // 初始化 SMTC，并在音频元素可用时同步一次播放状态与动作处理器
  const tryInitSmtc = () => {
    const el = controlAudio.Audio.audio
    if (!el) return
    mediaSessionController.init(el, {
      // source='media' 标记：系统媒体键可能同时经 Rust MPRemoteCommandCenter 和
      // WKWebView Media Session 两条链路投递，onGlobalCtrl 里对同指令做 250ms 去重。
      play: () => dispatch('play', undefined, 'media'),
      pause: () => dispatch('pause', undefined, 'media'),
      playPrevious: () => dispatch('playPrev', undefined, 'media'),
      playNext: () => dispatch('playNext', undefined, 'media')
    })
    // 初始同步状态
    mediaSessionController.updatePlaybackState(
      controlAudio.Audio.isPlay ? 'playing' : 'paused'
    )
  }
  // 尝试立即初始化一次
  tryInitSmtc()
  // 若 URL 变化或 audio 初始化稍后完成，由组件/Store 负责赋值；这里轮询几次兜底初始化
  let smtcTries = 0
  if (smtcTimer) clearInterval(smtcTimer)
  smtcTimer = setInterval(() => {
    if (smtcTries > 20) {
      if (smtcTimer) {
        clearInterval(smtcTimer)
        smtcTimer = null
      }
      return
    }
    smtcTries++
    if (controlAudio.Audio.audio) {
      tryInitSmtc()
      if (smtcTimer) {
        clearInterval(smtcTimer)
        smtcTimer = null
      }
    }
  }, 150)

  let keyThrottle = false
  const throttle = (cb: () => void, delay: number) => {
    if (keyThrottle) return
    keyThrottle = true
    setTimeout(() => {
      try {
        cb()
      } finally {
        keyThrottle = false
      }
    }, delay)
  }

  globalKeyDownHandler = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    const tag = (target?.tagName || '').toLowerCase()
    const isEditable =
      target?.hasAttribute('contenteditable') ||
      tag === 'input' ||
      tag === 'textarea' ||
      (target as HTMLInputElement)?.type === 'text' ||
      (target as HTMLInputElement)?.type === 'search' ||
      (target as HTMLInputElement)?.type === 'password' ||
      (target as HTMLInputElement)?.type === 'email' ||
      (target as HTMLInputElement)?.type === 'url' ||
      (target as HTMLInputElement)?.type === 'number'

    throttle(() => {
      if (isEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        dispatch('toggle')
      } else if (e.code === 'ArrowUp') {
        e.preventDefault()
        dispatch('volumeDelta', 5)
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        dispatch('volumeDelta', -5)
      } else if (e.code === 'ArrowLeft') {
        dispatch('seekDelta', -5)
      } else if (e.code === 'ArrowRight') {
        dispatch('seekDelta', 5)
      } else if (e.code === 'KeyF') {
        e.preventDefault()
        dispatch('toggleFullPlay')
      }
    }, 100)
  }

  document.addEventListener('keydown', globalKeyDownHandler)

  // 托盘/系统快捷键回调。Electron 主通道其实是 playPrev/playNext/toggle；
  // music-control 只是兜底。这里按 payload.action 分发，绝不能一律 toggle。
  try {
    window.electron?.ipcRenderer?.on?.('desktop-lyric-open-change', (_: any, open: boolean) => {
      ;(window as any).__shuxiaDesktopLyricOpen = !!open
    })
    window.electron?.ipcRenderer?.invoke?.('get-lyric-open-state')?.then?.((open: boolean) => {
      ;(window as any).__shuxiaDesktopLyricOpen = !!open
    }).catch?.(() => {})

    removeMusicCtrlListener = (window as any).api?.onMusicCtrl?.((payload?: any) => {
      const action =
        typeof payload === 'string'
          ? payload
          : payload?.action || payload?.name || (Array.isArray(payload) ? payload[0] : '')
      const val =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? payload.value ?? payload.val
          : Array.isArray(payload)
            ? payload[1]
            : undefined
      if (!action) return
      if (action === 'toggleDesktopLyric') {
        window.electron?.ipcRenderer?.send?.(
          'change-desktop-lyric',
          !(window as any).__shuxiaDesktopLyricOpen
        )
        return
      }
      // Dedicated channels already go through Provider.vue; this is only a fallback.
      dispatch(String(action), val)
    })
  } catch {
    // ignore
  }
}

export function uninstallGlobalMusicControls() {
  if (!installed) return
  installed = false

  if (smtcTimer) {
    clearInterval(smtcTimer)
    smtcTimer = null
  }

  if (globalKeyDownHandler) {
    document.removeEventListener('keydown', globalKeyDownHandler)
    globalKeyDownHandler = null
  }

  if (removeMusicCtrlListener) {
    removeMusicCtrlListener()
    removeMusicCtrlListener = null
  }

  mediaSessionController.cleanup()
}
