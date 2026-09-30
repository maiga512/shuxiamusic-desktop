/**
 * Lightweight bridge for the desktop-lyric window only.
 * Avoids loading the full app bridge (plugins, music SDK, updater, etc.).
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'

type Disposer = () => void

const channelDisposers = new Map<string, Disposer[]>()

async function safeInvoke<T = any>(cmd: string, args?: Record<string, any>, fallback?: T): Promise<T> {
  try {
    return (await invoke(cmd, args)) as T
  } catch (error) {
    console.warn(`[desktop-lyric-bridge] invoke ${cmd} failed`, error)
    return fallback as T
  }
}

function trackDisposer(channel: string, disposer: Disposer) {
  const list = channelDisposers.get(channel) || []
  list.push(disposer)
  channelDisposers.set(channel, list)
}

function clearChannel(channel?: string) {
  if (!channel) {
    for (const list of channelDisposers.values()) {
      for (const dispose of list) {
        try {
          dispose()
        } catch {}
      }
    }
    channelDisposers.clear()
    return
  }
  const list = channelDisposers.get(channel) || []
  for (const dispose of list) {
    try {
      dispose()
    } catch {}
  }
  channelDisposers.delete(channel)
}

export function createDesktopLyricBridge() {
  const ipcRenderer = {
    send: (channel: string, ...args: any[]) => {
      if (channel === 'change-desktop-lyric') {
        void safeInvoke('toggle_desktop_lyric', { show: Boolean(args[0]) })
        return
      }
      if (channel === 'set-desktop-lyric-option') {
        void safeInvoke('set_desktop_lyric_option', { option: args[0] })
        return
      }
      if (channel === 'set-desktop-lyric-font') {
        void safeInvoke('set_desktop_lyric_option', {
          option: { fontFamily: String(args[0] || '') },
        })
        return
      }
      if (channel === 'toogleDesktopLyricLock') {
        void safeInvoke('set_desktop_lyric_lock', { isLock: Boolean(args[0]) })
        return
      }
      if (channel === 'move-window') {
        const [x, y, width, height] = args.map((item) => Number(item))
        void safeInvoke('move_desktop_lyric_window', { x, y, width, height })
        return
      }
      if (channel === 'update-window-height') {
        void safeInvoke('update_desktop_lyric_window_height', { height: Number(args[0]) })
        return
      }
      if (channel === 'closeDesktopLyric') {
        void safeInvoke('close_desktop_lyric_window')
        return
      }
      if (channel === 'lyric-window-ready') {
        void safeInvoke('desktop_lyric_window_ready')
        return
      }
      if (channel === 'win-show') {
        void safeInvoke('show_main_window')
        return
      }
      if (channel === 'send-main-event') {
        const [eventName, ...eventArgs] = args
        if (typeof eventName === 'string') {
          void emit(eventName, eventArgs.length <= 1 ? eventArgs[0] : eventArgs)
        }
        return
      }
      void emit(channel, args.length === 1 ? args[0] : args)
    },
    invoke: (channel: string, ..._args: any[]) => {
      if (channel === 'get-window-bounds') return safeInvoke('get_window_bounds')
      if (channel === 'get-cursor-position') return safeInvoke('get_cursor_position')
      if (channel === 'get-desktop-lyric-option') return safeInvoke('get_desktop_lyric_option')
      if (channel === 'get-all-work-area') return safeInvoke('get_all_work_area')
      if (channel === 'get-screen-size') return safeInvoke('get_screen_size')
      if (channel === 'get-lyric-lock-state') return safeInvoke('get_lyric_lock_state')
      if (channel === 'get-lyric-open-state') return safeInvoke('get_lyric_open_state')
      return safeInvoke(channel.replace(/-/g, '_'))
    },
    on: (channel: string, listener: (...args: any[]) => void) => {
      let unlisten: Disposer | null = null
      void listen(channel, (event) => {
        listener(null, event.payload)
      }).then((fn) => {
        unlisten = fn
        trackDisposer(channel, fn)
      })
      return () => {
        if (unlisten) unlisten()
      }
    },
    removeListener: (channel?: string) => {
      clearChannel(channel)
    },
    removeAllListeners: (channel?: string) => {
      clearChannel(channel)
    },
  }

  ;(window as any).electron = {
    process: {
      versions: {
        electron: 'tauri',
        chrome: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1] || 'latest',
        node: 'tauri',
        tauri: '2.x',
      },
    },
    ipcRenderer,
  }

  ;(window as any).api = {
    desktopLyric: {
      toggle: (show: boolean) => safeInvoke('toggle_desktop_lyric', { show }),
      getOption: () => safeInvoke('get_desktop_lyric_option'),
      setOption: (option: any) => safeInvoke('set_desktop_lyric_option', { option }),
      isOpen: () => safeInvoke('lyric_window_get_open_state'),
      getWindowBounds: () => safeInvoke('get_window_bounds'),
      getAllWorkArea: () => safeInvoke('get_all_work_area'),
      getScreenSize: () => safeInvoke('get_screen_size'),
      setLyricLock: (isLock: boolean) => safeInvoke('set_desktop_lyric_lock', { isLock }),
      getLyricLockState: () => safeInvoke('get_lyric_lock_state'),
    },
  }
}
