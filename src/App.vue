<template>
  <Provider v-if="!$route.path.includes('desktop-lyric')">
    <GlobalBackground />
    <div
      class="tauri-window-drag-strip"
      data-tauri-drag-region
      @mousedown="startWindowDrag"
      aria-hidden="true"
    ></div>

    <router-view v-slot="{ Component }">
      <Transition
        :enter-active-class="dissolvingWelcome ? 'welcome-reveal pagesApp' : `animate__animated animate__fadeIn pagesApp`"
        :leave-active-class="dissolvingWelcome ? 'welcome-dissolve pagesApp' : `animate__animated animate__fadeOut pagesApp`"
      >
        <component :is="Component" />
      </Transition>
    </router-view>

    <!-- 一起听 Toast —— 全屏播放器未展开时新聊天走这里(节流) -->
    <LtChatToast />
    <!-- 全局更新对话框：发现新版本 → 下载进度条 → 下载完成 → 用户点“重启安装” -->
    <UpdateDialog />
  </Provider>
  <router-view v-else />
  <GlobalContextMenu />
</template>

<style>
.tauri-window-drag-strip {
  position: fixed;
  top: 0;
  left: 0;
  /* 右上角留给设置/迷你/最小化/最大化/关闭，约 5 * 2.25rem + padding */
  right: 13.5rem;
  height: 24px;
  z-index: 99999;
  pointer-events: auto;
}

body.full-play-open .tauri-window-drag-strip {
  pointer-events: none;
}

html,
body,
#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--td-bg-color-container, #ffffff);
}

html.desktop-lyric-window,
html.desktop-lyric-window body,
html.desktop-lyric-window #app {
  background: transparent !important;
  background-color: transparent !important;
}

.home {
  width: 100vw;
  height: 100vh;
}

.home,
.home-container,
.main-container {
  overflow: hidden;
  background-clip: padding-box;
  isolation: isolate;
}
</style>

<!-- 启动星空化开：主页先挂在下面，启动层放大模糊淡出 -->
<style>
.welcome-dissolve.pagesApp {
  z-index: 30000;
  pointer-events: none;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  transform-origin: center center;
  animation: shuxiaWelcomeDissolve 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform, filter;
}
.welcome-reveal.pagesApp {
  z-index: 1;
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  transform-origin: center center;
  animation: shuxiaWelcomeReveal 0.8s cubic-bezier(0.22, 1, 0.36, 1) both;
  will-change: opacity, transform, filter;
}
@keyframes shuxiaWelcomeDissolve {
  0% {
    opacity: 1;
    filter: blur(0) saturate(1) brightness(1);
    transform: scale(1);
  }
  55% {
    opacity: 0.42;
    filter: blur(10px) saturate(1.06) brightness(1.07);
    transform: scale(1.035);
  }
  100% {
    opacity: 0;
    filter: blur(20px) saturate(1.12) brightness(1.12);
    transform: scale(1.07);
  }
}
@keyframes shuxiaWelcomeReveal {
  0% {
    opacity: 0.3;
    filter: blur(8px);
    transform: scale(1.025);
  }
  100% {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .welcome-dissolve.pagesApp,
  .welcome-reveal.pagesApp {
    animation-duration: 0.01ms !important;
  }
}
</style>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { MessagePlugin } from 'tdesign-vue-next'
import { useSettingsStore } from '@renderer/store/Settings'
import UpdateDialog from '@renderer/components/UpdateDialog.vue'
import shareAPI from '@renderer/api/share'
import { startNasSyncPoller, stopNasSyncPoller } from '@renderer/services/nasSyncPoller'
import { initIdleSleep, destroyIdleSleep } from './utils/idleSleep'
import { initAppWindowState, destroyAppWindowState, isAppWindowVisible } from './utils/appWindowState'
import { startWindowDrag } from './utils/windowDrag'
import { welcomeTransitionActive } from './utils/navigation/welcomeTransition'

const route = useRoute()
const router = useRouter()
const settingsStore = useSettingsStore()
const dissolvingWelcome = ref(false)
const stopWelcomeDissolveGuard = router.beforeEach((to, from) => {
  dissolvingWelcome.value = from.name === 'welcome' && to.path.startsWith('/home')
  welcomeTransitionActive.value = dissolvingWelcome.value
})
const setDesktopLyricRootState = (enabled: boolean) => {
  document.documentElement.classList.toggle('desktop-lyric-window', enabled)
}
watch(
  () => route.path,
  (path) => setDesktopLyricRootState(String(path || '').startsWith('/desktop-lyric')),
  { immediate: true }
)
// 启动页路由是 '/'(welcome)；其它路由（/home/*, /settings 等）视为应用就绪
// 排除桌面歌词与识别 worker 这种独立窗口
const isAppReady = computed(() => {
  const p = route.path || ''
  if (p === '/' || p === '') return false
  if (p.startsWith('/desktop-lyric')) return false
  if (p.startsWith('/recognition-worker')) return false
  return true
})

interface DeepLinkQueueOptions {
  label: string
  handler: (id: string) => Promise<void>
}

function createDeepLinkQueue({ label, handler }: DeepLinkQueueOptions) {
  const pending = ref<string[]>([])
  const processed = new Set<string>()

  const handle = async (id: string) => {
    if (!id || processed.has(id)) return
    processed.add(id)
    try {
      await handler(id)
    } finally {
      processed.delete(id)
    }
  }

  const enqueueOrHandle = (id: string) => {
    if (!id) return
    if (isAppReady.value) {
      handle(id)
    } else if (!pending.value.includes(id)) {
      pending.value.push(id)
    }
  }

  const flush = async (parallel = true) => {
    if (!pending.value.length) return
    const ids = pending.value.splice(0)
    console.log(`[${label}] flush:`, ids)
    if (parallel) await Promise.all(ids.map(handle))
    else for (const id of ids) await handle(id)
  }

  return { pending, enqueueOrHandle, flush }
}

const songShareQueue = createDeepLinkQueue({
  label: 'share',
  handler: async (id) => {
    console.log('[share] 处理分享 id:', id)
    MessagePlugin.info(`正在打开分享：${id}`)
    try {
      const detail = await shareAPI.getById(id)
      if (!detail || !detail.song) {
        MessagePlugin.error('分享已失效或已过期')
        return
      }
      const song: any = {
        ...detail.song,
        source: (detail.song as any).source || detail.source
      }
      const emitter = (window as any).musicEmitter
      if (!emitter) {
        MessagePlugin.error('播放器未就绪，请稍候重试')
        return
      }
      emitter.emit('addToPlaylistAndPlay', song)
    } catch (e: any) {
      console.error('打开分享失败', e)
      MessagePlugin.error(
        '打开分享失败：' + (e?.response?.data?.message || e?.message || '未知错误')
      )
    }
  }
})

const playlistShareQueue = createDeepLinkQueue({
  label: 'playlist-share',
  handler: async (id) => {
    console.log('[playlist-share] 处理歌单分享 id:', id)
    MessagePlugin.info(`正在打开歌单分享：${id}`)
    try {
      const detail = await shareAPI.getPlaylistById(id, 0)
      if (!detail?.playlist) {
        MessagePlugin.error('歌单分享不存在或已失效')
        return
      }
      await router.push({
        name: 'list',
        params: { id },
        query: {
          title: detail.playlist.name,
          author: detail.username || 'share',
          cover: detail.playlist.cover || '',
          total: String(detail.playlist.total || 0),
          source: 'share',
          type: 'playlist_share',
          description: detail.playlist.describe || '',
          cloudId: detail.playlist.id,
          meta: JSON.stringify({
            cloudId: detail.playlist.id,
            playlistShareId: detail.id,
            sourceShare: true,
            canPlay: detail.canPlay,
            playExpiresAt: detail.playExpiresAt,
            openInAppScheme: detail.openInAppScheme
          })
        }
      })
    } catch (e: any) {
      console.error('打开歌单分享失败', e)
      MessagePlugin.error(
        '打开歌单分享失败：' + (e?.response?.data?.message || e?.message || '未知错误')
      )
    }
  }
})

let startupMicrophoneRequested = false
const ensureStartupMicrophonePermission = async () => {
  if (startupMicrophoneRequested) return
  startupMicrophoneRequested = true
  // 不再在启动/首播时主动申请麦克风权限。
  // 原因：requestMicrophone() 内部的 getUserMedia({ audio: true }) 一旦被调用，会把已连接的
  // AirPods 等蓝牙耳机从音乐模式(A2DP)切进通话模式(HFP/SCO)，后果是：
  //   1) 音乐输出被系统甩到笔记本扬声器，耳机里没声；
  //   2) mpv 的 CoreAudio 输出被设备切换噎住，播放时钟卡死；
  //   3) 耳机的捏停 / 双击切歌退化成「通话控制」，媒体控制失效。
  // 播放器本身没有任何功能消费麦克风流，这个开机抢麦是无谓的。若将来某功能确实需要，
  // 应在该功能入口按需调用 permissions.requestMicrophone()，而不是启动即抢。
}

// 延迟请求麦克风权限：监听第一次播放开始后再请求，避免阻塞启动播放流程
const scheduleDelayedMicrophoneRequest = () => {
  if (startupMicrophoneRequested) return
  // 监听全局播放控制事件，第一次播放开始时请求麦克风权限
  const onPlay = () => {
    // 播放稳定后（2.5s）再请求：过早请求会在淡入过程中打断音频
    setTimeout(() => {
      void ensureStartupMicrophonePermission()
    }, 2500)
    // 只监听一次，移除监听器
    window.removeEventListener('global-music-control', onGlobalCtrlForMic)
  }
  const onGlobalCtrlForMic = (e: any) => {
    if (e?.detail?.name === 'play' || e?.detail?.name === 'toggle') {
      onPlay()
    }
  }
  window.addEventListener('global-music-control', onGlobalCtrlForMic)
}

watch(isAppReady, (ready) => {
  if (!ready) return
  songShareQueue.flush(true)
  // router.push 互斥，串行处理避免覆盖
  playlistShareQueue.flush(false)
  // 延迟请求麦克风权限：等待第一次播放开始后再请求，避免阻塞启动播放流程
  scheduleDelayedMicrophoneRequest()
})

let unsubShareOpen: (() => void) | null = null
let unsubPlaylistShareOpen: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null

// 处理 Ctrl+W / Alt+F4 的关闭请求，模拟点击关闭按钮行为
const handleWindowCloseRequest = () => {
  // 关窗（尤其是关到托盘，页面不卸载、不触发 pagehide）前先让播放页把
  // 进度 / 列表强制落盘，否则重启会恢复到上一次 tick 的旧进度。
  try {
    window.dispatchEvent(new CustomEvent('shuxia-persist-playback-state'))
  } catch {}
  const settings = settingsStore.settings
  if (!settings.hasConfiguredCloseBehavior) {
    // 未配置过关闭行为，通过自定义事件通知 TitleBarControls 显示对话框
    window.dispatchEvent(new CustomEvent('shuxia-show-close-dialog'))
    return
  }
  if (settings.closeToTray) {
    window.api?.setMiniMode(true)
  } else {
    window.api?.close()
  }
}

onMounted(async () => {
  // Start sync before awaiting optional startup services. Some share/plugin IPC calls can
  // wait for the sidecar; delaying the poller behind them loses realtime events at launch.
  startNasSyncPoller()
  // 启动时把窗口标题置为软件名(若 PlayMusic 后续挂载且有歌,会立刻覆盖为"歌名 - 歌手")
  try {
    ;(window as any).api?.app?.setTitle?.('树夏Music')
    ;(window as any).api?.app?.setProgress?.(-1)
  } catch (e) {
    console.warn('[app] init title/progress failed', e)
  }

  if (window?.api?.share?.onShareOpen) {
    unsubShareOpen = window.api.share.onShareOpen(({ id }) => songShareQueue.enqueueOrHandle(id))
  }
  if (window?.api?.share?.onPlaylistShareOpen) {
    unsubPlaylistShareOpen = window.api.share.onPlaylistShareOpen(({ id }) =>
      playlistShareQueue.enqueueOrHandle(id)
    )
  }
  try {
    const ids = (await window?.api?.share?.getPending?.()) || []
    for (const id of ids) songShareQueue.enqueueOrHandle(id)
    const playlistIds = (await window?.api?.share?.getPendingPlaylistShares?.()) || []
    for (const id of playlistIds) playlistShareQueue.enqueueOrHandle(id)
  } catch (e) {
    console.warn('[share] 拉取待处理分享 id 失败', e)
  }

  // 监听主进程发送的关闭请求（Ctrl+W / Alt+F4）
  if (window.api?.windowClose?.onRequest) {
    unsubCloseRequest = window.api.windowClose.onRequest(() => handleWindowCloseRequest())
  }

  // 启动页面闲置休眠监听
  initIdleSleep()
  initAppWindowState()
  // 窗口隐藏时冻结 CSS 动画/过渡，降低 GPU 开销
  const onVisibility = () => {
    const visible = isAppWindowVisible()
    document.body.classList.toggle('window-hidden', !visible)
    if (!visible) {
      document.documentElement.style.setProperty('--shuxia-freeze-w', `${Math.max(1, window.innerWidth)}px`)
      document.documentElement.style.setProperty('--shuxia-freeze-h', `${Math.max(1, window.innerHeight)}px`)
    }
  }
  window.addEventListener('shuxia-window-state-change', onVisibility)
  document.addEventListener('visibilitychange', onVisibility)
  onVisibility()
  // 保存引用以便卸载时清理
  ;(window as any).__shuxiaVisibilityHandler = onVisibility
})

onBeforeUnmount(() => {
  setDesktopLyricRootState(false)
  stopWelcomeDissolveGuard()
  unsubShareOpen?.()
  unsubShareOpen = null
  unsubPlaylistShareOpen?.()
  unsubPlaylistShareOpen = null
  unsubCloseRequest?.()
  unsubCloseRequest = null

  // 销毁闲置休眠监听
  stopNasSyncPoller()
  destroyIdleSleep()
  destroyAppWindowState()

  // 清理可见性监听
  const h = (window as any).__shuxiaVisibilityHandler
  if (h) {
    window.removeEventListener('shuxia-window-state-change', h)
    document.removeEventListener('visibilitychange', h)
    ;(window as any).__shuxiaVisibilityHandler = null
  }
})
</script>

<style scoped>
/* 窗口隐藏/最小化时，冻结所有 CSS 动画和过渡，降低 GPU 开销 */
:global(body.window-hidden),
:global(body.window-hidden) * {
  animation-play-state: paused !important;
  transition-duration: 0s !important;
}
</style>

<!-- 非 scoped 全局样式：窗口隐藏时降低 backdrop-filter 开销 -->
<style>
body.window-hidden {
  --player-blur: 0px;
}
body {
  --player-blur: 15px;
}

/* Freeze list/settings paint only. Never freeze .home: dock + FullPlay live there
   and WebKit skips hit-testing skipped subtrees (first Dock click eaten). */
html:not(.desktop-lyric-window) body.window-hidden .home-container,
html:not(.desktop-lyric-window) body.window-hidden .main-container,
html:not(.desktop-lyric-window) body.window-hidden .global-background-container {
  content-visibility: hidden;
  contain-intrinsic-size: var(--shuxia-freeze-w, 100vw) var(--shuxia-freeze-h, 100vh);
  pointer-events: none;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
</style>
