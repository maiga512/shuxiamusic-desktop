<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { useSettingsStore } from '@renderer/store/Settings'
import { storeToRefs } from 'pinia'
import { isAppWindowVisible } from '@renderer/utils/appWindowState'

const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

const bgSettings = computed(() => settings.value.globalBackground)

const isEnabled = computed(() => bgSettings.value?.enable && bgSettings.value?.url)
const bgType = computed(() => bgSettings.value?.type || 'none')

/**
 * 设置里存的是用户选的本地文件路径（`file:///…`）。
 * webview 不能直接加载 `file://`（生产环境是 `tauri://localhost`，跨 scheme 被
 * WebKit 拦掉），必须换成 asset 协议地址——Cargo.toml 开了 `protocol-asset`，
 * tauri.conf.json 配了 `assetProtocol.scope`。http(s)/data/blob 原样放行。
 */
function toRenderableSrc(input: string | undefined): string {
  const url = (input || '').trim()
  if (!url) return ''
  if (/^(https?|data|blob):/i.test(url)) return url
  const localPath = url.startsWith('file://') ? decodeURI(url.slice('file://'.length)) : url
  try {
    return convertFileSrc(localPath)
  } catch {
    return url
  }
}

const bgUrl = computed(() => toRenderableSrc(bgSettings.value?.url))
const bgOpacity = computed(() => bgSettings.value?.opacity ?? 0.5)
const bgBlur = computed(() => bgSettings.value?.blur ?? 10)
const bgBrightness = computed(() => bgSettings.value?.brightness ?? 0.8)

const videoRef = ref<HTMLVideoElement | null>(null)

const syncVideoPlayback = () => {
  const video = videoRef.value
  if (!video) return
  if (!isEnabled.value || bgType.value !== 'video' || !isAppWindowVisible()) {
    video.pause()
    return
  }
  video.play().catch((e) => console.error('Video auto-play failed:', e))
}

watch(
  [bgType, bgUrl, isEnabled],
  ([type, _url, enabled]) => {
    if (enabled && type === 'video' && videoRef.value) {
      videoRef.value.load()
      syncVideoPlayback()
    } else if (videoRef.value) {
      videoRef.value.pause()
    }
  },
  { immediate: true }
)

onMounted(() => {
  document.addEventListener('visibilitychange', syncVideoPlayback)
  window.addEventListener('shuxia-window-state-change', syncVideoPlayback)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncVideoPlayback)
  window.removeEventListener('shuxia-window-state-change', syncVideoPlayback)
  videoRef.value?.pause()
})

const appContainerStyle = computed(() => {
  if (isEnabled.value) {
    // When background is enabled, we need to make some main containers transparent
    return {
      '--td-bg-color-container': 'transparent',
      '--td-bg-color-page': 'transparent',
      '--td-bg-color-secondarycontainer': 'transparent'
    }
  }
  return {}
})

// Dynamically inject styles into body or #app to make them transparent if needed
const styleElement = document.createElement('style')
styleElement.id = 'global-bg-transparency'

watch(
  [isEnabled, () => settings.value.isDarkMode],
  ([enabled, isDark]) => {
    const appEl = document.getElementById('app')
    if (enabled) {
      if (appEl) appEl.style.backgroundColor = 'transparent'
      document.body.style.backgroundColor = 'transparent'
      if (!document.head.contains(styleElement)) {
        document.head.appendChild(styleElement)
      }
      const containerColor = isDark ? '36, 36, 36' : '255, 255, 255'
      const pageColor = isDark ? '24, 24, 24' : '243, 243, 243'
      const hoverColor = isDark ? '255, 255, 255' : '0, 0, 0'
      // Add custom styles to make components slightly transparent
      styleElement.innerHTML = `
        :root, body[theme-mode="dark"], body[theme-mode="light"] {
          --td-bg-color-container: rgba(${containerColor}, 0.3) !important;
          --td-bg-color-page: transparent !important;
          --td-bg-color-secondarycontainer: rgba(${pageColor}, 0.2) !important;
          --td-bg-color-component: rgba(${containerColor}, 0.3) !important;
          --td-bg-color-component-hover: rgba(${hoverColor}, 0.05) !important;
          --td-bg-color-component-active: rgba(${hoverColor}, 0.1) !important;
          --list-content-bg: rgba(${containerColor}, 0.3) !important;
        }
        .home-container .sidebar {
          background-image: none !important;
          background-color: rgba(${containerColor}, 0.2) !important;
          backdrop-filter: blur(10px);
        }
        .home-container .header {
          background-color: transparent !important;
        }
        .mainContent {
          background-color: transparent !important;
        }
        .scrollable-content {
          background: rgba(${containerColor}, 0.3) !important;
          backdrop-filter: blur(8px);
        }
        /*
         * 设置页有自己的不透明底色变量（--settings-main-bg 等，定义在 main.css 的
         * :root 上），首页那套 --td-bg-color-* 覆盖管不到它，所以整个设置页会把全局
         * 背景整页盖住。这里只覆盖"底色变量"、不改 background 属性，既不用跟 scoped
         * 样式比优先级，也不会影响其它主题变量（边框/文字色保持原样）。
         */
        .main-container {
          --settings-main-bg: transparent !important;
          --settings-header-bg: transparent !important;
          --settings-sidebar-bg: transparent !important;
          --settings-content-bg: transparent !important;
          --settings-group-bg: rgba(${containerColor}, 0.3) !important;
          --settings-source-card-bg: rgba(${containerColor}, 0.3) !important;
          --settings-feature-bg: rgba(${pageColor}, 0.22) !important;
          --settings-preview-bg: rgba(${pageColor}, 0.22) !important;
          --settings-mock-titlebar-bg: rgba(${pageColor}, 0.22) !important;
          --settings-api-tips-bg: rgba(${pageColor}, 0.22) !important;
          --settings-quality-container-bg: rgba(${pageColor}, 0.22) !important;
          --settings-source-icon-bg: rgba(${pageColor}, 0.3) !important;
          --settings-footer-bg: rgba(${pageColor}, 0.2) !important;
          --settings-version-bg: rgba(${pageColor}, 0.26) !important;
          --settings-nav-hover-bg: rgba(${hoverColor}, 0.06) !important;
        }
        .main-container .sidebar,
        .main-container .header {
          backdrop-filter: blur(10px);
        }
        .main-container .sidebar {
          background-image: none !important;
        }
      `
    } else {
      if (appEl) appEl.style.backgroundColor = ''
      document.body.style.backgroundColor = ''
      if (document.head.contains(styleElement)) {
        document.head.removeChild(styleElement)
      }
    }
  },
  { immediate: true }
)
</script>

<template>
  <div v-if="isEnabled" class="global-background-container" :style="appContainerStyle">
    <div
      class="global-background-media"
      :style="{
        opacity: bgOpacity,
        filter: `blur(${bgBlur}px) brightness(${bgBrightness})`
      }"
    >
      <video
        v-if="bgType === 'video'"
        ref="videoRef"
        :src="bgUrl"
        loop
        muted
        autoplay
        playsinline
        class="bg-video"
      ></video>
      <div v-else class="bg-image" :style="{ backgroundImage: `url('${bgUrl}')` }"></div>
    </div>
  </div>
</template>

<style scoped>
.global-background-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: -999;
  pointer-events: none;
  overflow: hidden;
  background-color: var(--td-bg-color-page);
}

.global-background-media {
  position: absolute;
  top: -10%;
  left: -10%;
  width: 120%;
  height: 120%;
  transition: all 0.3s ease;
}

.bg-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bg-image {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
</style>
