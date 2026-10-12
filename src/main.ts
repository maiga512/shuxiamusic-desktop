// 基础样式
// 全局基础样式：根字号 min(max(1.4vw,15px),18px)、底栏高度变量 --play-bottom-height、
// 以及 *{box-sizing:border-box} 等重置。与 Electron 对齐，必须最先加载——缺失会导致
// 页面高度链塌陷(无法滚动)、Dock 变窄、歌单按钮溢出、全屏播放布局错乱。
import './assets/base.css'
import 'tdesign-vue-next/es/style/index.css'
import 'tdesign-vue-next/es/message/style/index.css'
import 'tdesign-vue-next/es/dialog/style/index.css'
import 'tdesign-vue-next/es/notification/style/index.css'
import 'tdesign-vue-next/es/loading/style/index.css'
import 'animate.css'
// 引入iconfont图标样式
import './assets/icon_font/iconfont.css'
import './assets/icon_font/iconfont.js'
// Tauri bridge (replaces Electron preload API)
import { createTauriBridge } from './tauri-bridge'
try {
  createTauriBridge()
} catch (error) {
  console.error('[bootstrap] Tauri bridge 初始化失败:', error)
}

// 只预热插件目录和注册表，不把全部洛雪 worker 拉进内存。真正切歌/搜源时再起对应 worker。

if (window.location.hash.startsWith('#/desktop-lyric')) {
  document.documentElement.classList.add('desktop-lyric-window')
  document.documentElement.style.background = 'transparent'
  document.documentElement.style.backgroundColor = 'transparent'
  if (document.body) {
    document.body.style.background = 'transparent'
    document.body.style.backgroundColor = 'transparent'
  }
} else {
  void (async () => {
    try {
      await window.api?.plugins?.initializeSystem?.()
    } catch (error) {
      console.warn('[plugins] 启动预热失败:', error)
    }
    try {
      const result = await window.api?.plugins?.syncFeiniuOnStartup?.()
      if (result?.errors?.length) {
        console.warn('[飞牛] 启动同步完成但有错误:', result.errors)
      } else if (result) {
        console.info('[飞牛] 启动同步完成', {
          imported: Array.isArray(result.imported) ? result.imported.length : 0,
          skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
        })
      }
      if (Array.isArray(result?.imported) && result.imported.length > 0) {
        window.dispatchEvent(new Event('playlist-updated'))
      }
    } catch (error) {
      console.warn('[飞牛] 启动同步失败:', error)
    }
  })()
}

window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true })

document.addEventListener(
  'error',
  (event) => {
    const target = event.target
    if (!(target instanceof HTMLImageElement)) return
    if (target.dataset.ceruImageRetry === '1') return
    target.dataset.ceruImageRetry = '1'
    target.referrerPolicy = 'no-referrer'
    // Electron keeps the original URL. Rewriting http CDN covers to https
    // breaks Kuwo artwork (HTTP 514) and still fails if ATS blocked the first load.
    target.src = target.src
  },
  true,
)
// vue

import App from './App.vue'
import { createApp, watch } from 'vue'
import BrowserLogtoClient, {
  LogtoConfig,
  UserScope,
  BrowserStorage,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState
} from '@logto/browser'
import LogtoClient, { createRequester, type ClientAdapter } from '@logto/client'
import config from './config'
const { endpoint, appId, resources } = config
import { Request } from '@renderer/utils/request'
import { installMessageBehavior } from '@renderer/utils/ui/message'
// router
import router from './router'
import { useSettingsStore } from '@renderer/store/Settings'
// pinia
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
const appConfig: LogtoConfig = {
  endpoint,
  appId,
  resources,
  scopes: [
    UserScope.Email,
    UserScope.Phone,
    UserScope.CustomData,
    UserScope.Identities,
    UserScope.Profile
  ]
}

const createLogtoClient = () => {
  const openInSystemBrowser = async (url: string) => {
    await window.api?.music?.openExternal?.(url)
  }

  if (window.api?.music?.openExternal) {
    const adapter: ClientAdapter = {
      requester: createRequester(fetch),
      navigate: (url) => openInSystemBrowser(url),
      storage: new BrowserStorage(appId),
      generateCodeChallenge,
      generateCodeVerifier,
      generateState
    }
    return new LogtoClient(appConfig, adapter)
  }

  return new BrowserLogtoClient(appConfig)
}

const logtoClient = createLogtoClient()
Request.setLogtoClient(logtoClient as InstanceType<typeof BrowserLogtoClient>)
config.instance = logtoClient as InstanceType<typeof BrowserLogtoClient>
installMessageBehavior()

const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
let autoUpdateCheckTimer: number | undefined
let autoUpdateCheckInFlight = false

async function checkForUpdatesInBackground() {
  if (autoUpdateCheckInFlight) return
  autoUpdateCheckInFlight = true
  try {
    // 走更新服务并标记为静默：后台检查不提示“已是最新”、检查报错也不弹窗。
    const { autoUpdateService } = await import('./services/autoUpdateService')
    await autoUpdateService.checkForUpdates({ silent: true })
  } catch (error) {
    console.warn('[auto-update] 后台检查失败:', error)
  } finally {
    autoUpdateCheckInFlight = false
  }
}

function stopBackgroundUpdateCheck() {
  if (autoUpdateCheckTimer) {
    window.clearInterval(autoUpdateCheckTimer)
    autoUpdateCheckTimer = undefined
  }
}

function startBackgroundUpdateCheck() {
  if (window.location.hash.startsWith('#/desktop-lyric')) return
  if (settingsStore.settings.autoUpdate === false) return
  window.setTimeout(() => {
    void checkForUpdatesInBackground()
    autoUpdateCheckTimer = window.setInterval(() => {
      void checkForUpdatesInBackground()
    }, AUTO_UPDATE_CHECK_INTERVAL_MS)
  }, 15_000)
}

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
app.use(pinia)

const settingsStore = useSettingsStore(pinia)
let restoringNativeSettings = true
const devStartRoute = import.meta.env.DEV ? String(import.meta.env.VITE_DEV_ROUTE || '') : ''

const restoreNativeImpactSettings = async () => {
  try {
    const nativeSettings = await window.api?.settings?.getNativeImpactSettings?.()
    if (!nativeSettings) return

    const hasPersisted = nativeSettings.hasPersisted || {}
    const patch: Record<string, any> = {}
    if (hasPersisted.closeToTray) {
      patch.closeToTray = Boolean(nativeSettings.closeToTray)
    }
    if (hasPersisted.macStatusBarLyricEnabled) {
      patch.macStatusBarLyricEnabled = Boolean(nativeSettings.macStatusBarLyricEnabled)
    }
    if (Object.keys(patch).length > 0) {
      settingsStore.updateSettings(patch)
    }
  } catch (error) {
    console.warn('[settings] 恢复原生设置失败:', error)
  } finally {
    restoringNativeSettings = false
    persistNativeImpactSettings()
  }
}

const persistNativeImpactSettings = () => {
  if (restoringNativeSettings) return
  try {
    window.api?.settings?.setNativeImpactSettings?.({
      closeToTray: Boolean(settingsStore.settings.closeToTray),
      macStatusBarLyricEnabled: Boolean(settingsStore.settings.macStatusBarLyricEnabled)
    })
  } catch {}
}

watch(
  () => settingsStore.settings.macStatusBarLyricEnabled,
  (enabled) => {
    persistNativeImpactSettings()
    try {
      window.api?.desktopLyric?.setMacStatusBarLyric?.(Boolean(enabled))
      if (enabled) {
        window.dispatchEvent(new Event('ceru-sync-tray-lyric'))
      }
    } catch {}
  },
  { immediate: true }
)
watch(
  () => settingsStore.settings.closeToTray,
  () => {
    persistNativeImpactSettings()
  }
)

app.use(router)

// WKWebView can still rubber-band text/image selection on drag even with CSS
// user-select:none. Block selectstart globally, except intentional text areas.
const allowTextSelect = (el: Element | null) => {
  if (!el) return false
  const node = el as HTMLElement
  if (node.closest?.('input, textarea, [contenteditable="true"], .allow-text-select')) return true
  let cur: HTMLElement | null = node
  while (cur) {
    const cs = window.getComputedStyle(cur)
    if (cs.userSelect === 'text' || (cs as any).webkitUserSelect === 'text') return true
    cur = cur.parentElement
  }
  return false
}
document.addEventListener(
  'selectstart',
  (event) => {
    const target = event.target as Element | null
    if (!allowTextSelect(target)) event.preventDefault()
  },
  { capture: true }
)

app.mount('#app')
startBackgroundUpdateCheck()

// 窗口隐藏时停止自动更新检查，节省CPU
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopBackgroundUpdateCheck()
  } else {
    startBackgroundUpdateCheck()
  }
})

if (devStartRoute) {
  router.replace(devStartRoute).catch(() => undefined)
}
void restoreNativeImpactSettings().catch(() => {})
