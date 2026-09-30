<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import { isPageIdle } from '@renderer/utils/idleSleep'
import { appWindowState, isAppWindowActive, isAppWindowVisible } from '@renderer/utils/appWindowState'
import { startWindowDrag } from '@renderer/utils/windowDrag'
import {
  PaletteIcon,
  PlayCircleIcon,
  KeyboardIcon,
  TreeRoundDotIcon,
  MusicIcon,
  SaveIcon,
  InfoCircleIcon
} from 'tdesign-icons-vue-next'
import SettingsSearch from '@renderer/components/SettingsSearch.vue'
import type { SearchItem } from './searchIndex'

const AppearanceSection = defineAsyncComponent(() => import('./sections/AppearanceSection.vue'))
const PlaybackSection = defineAsyncComponent(() => import('./sections/PlaybackSection.vue'))
const HotkeySection = defineAsyncComponent(() => import('./sections/HotkeySection.vue'))
const PluginSection = defineAsyncComponent(() => import('./sections/PluginSection.vue'))
const MusicSourceSection = defineAsyncComponent(() => import('./sections/MusicSourceSection.vue'))
const StorageSection = defineAsyncComponent(() => import('./sections/StorageSection.vue'))
const AboutSection = defineAsyncComponent(() => import('./sections/AboutSection.vue'))

// 当前选择的设置分类
const activeCategory = ref<string>('appearance')
const route = useRoute()
const contentPanelRef = ref<HTMLElement>()
const scrollPositions = ref<Record<string, number>>({})
const settingsPageIdle = ref(isPageIdle())
let switchRequestId = 0

const updateSettingsIdleState = () => {
  settingsPageIdle.value = isPageIdle()
}

// 设置分类配置
const settingsCategories = [
  {
    key: 'appearance',
    label: '外观设置',
    icon: PaletteIcon,
    description: '主题、标题栏风格等外观配置'
  },
  {
    key: 'playlist',
    label: '播放设置',
    icon: PlayCircleIcon,
    description: '播放列表、歌词管理、同步服务和相关设置'
  },
  {
    key: 'hotkeys',
    label: '快捷键',
    icon: KeyboardIcon,
    description: '全局快捷键配置'
  },
  {
    key: 'plugins',
    label: '插件管理',
    icon: TreeRoundDotIcon,
    description: '插件安装、配置和管理'
  },
  {
    key: 'music',
    label: '音乐源',
    icon: MusicIcon,
    description: '音乐源选择和音质配置'
  },
  {
    key: 'storage',
    label: '存储管理',
    icon: SaveIcon,
    description: '缓存管理和存储设置'
  },
  {
    key: 'about',
    label: '关于',
    icon: InfoCircleIcon,
    description: '版本信息和功能说明'
  }
]

const sectionComponents: Record<string, any> = {
  appearance: AppearanceSection,
  playlist: PlaybackSection,
  hotkeys: HotkeySection,
  plugins: PluginSection,
  music: MusicSourceSection,
  storage: StorageSection,
  about: AboutSection
}

const currentComponent = computed(() => sectionComponents[activeCategory.value])
const settingsRuntimeClasses = computed(() => ({
  'settings-window-hidden': !isAppWindowVisible(),
  'settings-window-inactive': !isAppWindowActive(),
  'settings-page-idle': settingsPageIdle.value,
  'settings-window-fullscreen': appWindowState.value.fullscreen
}))

// 切换设置分类
const switchCategory = async (categoryKey: string) => {
  if (activeCategory.value === categoryKey) return
  const requestId = ++switchRequestId

  // 保存当前滚动位置
  if (contentPanelRef.value) {
    scrollPositions.value[activeCategory.value] = contentPanelRef.value.scrollTop
  }

  activeCategory.value = categoryKey

  const target = scrollPositions.value[categoryKey] || 0
  await nextTick()
  if (requestId !== switchRequestId) return
  if (target <= 0) {
    if (contentPanelRef.value) contentPanelRef.value.scrollTop = 0
    return
  }
  // 恢复滚动位置要等异步分类组件撑出高度。以前是 20 次 nextTick +
  // 50ms 轮询，每次读 scrollHeight 都会强制同步布局，分类没挂好时会连续
  // 重排一秒，切设置就是在这个循环里卡住的。改成按帧重试，最多 12 帧。
  let attempts = 0
  const restoreScroll = () => {
    if (requestId !== switchRequestId) return
    const panel = contentPanelRef.value
    if (!panel) return
    if (panel.scrollHeight > target + panel.clientHeight / 2 || attempts >= 12) {
      panel.scrollTop = target
      return
    }
    attempts += 1
    window.requestAnimationFrame(restoreScroll)
  }
  restoreScroll()
}

function scrollToSection(sectionId?: string) {
  if (!sectionId) return
  let attempts = 0
  const maxAttempts = 20
  const tryScroll = () => {
    const el = document.getElementById(sectionId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.remove('highlight-flash')
      void el.offsetWidth
      el.classList.add('highlight-flash')
      setTimeout(() => el.classList.remove('highlight-flash'), 2000)
    } else if (attempts < maxAttempts) {
      attempts++
      setTimeout(tryScroll, 100)
    }
  }
  tryScroll()
}

watch(
  () => route.query,
  async (q) => {
    const category = String(q.category || '')
    const section = String(q.section || '')
    if (category && category !== activeCategory.value) {
      await switchCategory(category)
      await nextTick()
    }
    if (section) {
      await nextTick()
      scrollToSection(section)
    }
  },
  { immediate: true, deep: true }
)

onMounted(() => {
  window.addEventListener('ceru-wake', updateSettingsIdleState)
  window.addEventListener('ceru-sleep', updateSettingsIdleState)
})

onUnmounted(() => {
  window.removeEventListener('ceru-wake', updateSettingsIdleState)
  window.removeEventListener('ceru-sleep', updateSettingsIdleState)
})

const handleSearchSelect = async (item: SearchItem) => {
  console.log('Settings: Handling search select', item)
  if (activeCategory.value !== item.category) {
    console.log('Settings: Switching category to', item.category)
    await switchCategory(item.category)
    // Wait for Vue to update DOM
    await nextTick()
    // Small delay to ensure component is activated/mounted
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  // Retry mechanism to find the element
  let attempts = 0
  const maxAttempts = 20

  const tryScroll = () => {
    const element = document.getElementById(item.id)
    console.log(`Settings: Trying to find element ${item.id}, attempt ${attempts + 1}`)

    if (element) {
      console.log('Settings: Scrolling to element')
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })

      // Remove existing highlight if any
      element.classList.remove('highlight-flash')
      // Force reflow
      void element.offsetWidth
      // Add highlight
      element.classList.add('highlight-flash')

      setTimeout(() => {
        element.classList.remove('highlight-flash')
      }, 2000)
    } else if (attempts < maxAttempts) {
      attempts++
      setTimeout(tryScroll, 100)
    } else {
      console.warn('Settings: Element not found after retries', item.id)
    }
  }

  tryScroll()
}
</script>

<template>
  <div class="main-container" :class="settingsRuntimeClasses">
    <!-- 标题栏 -->
    <div class="header" data-tauri-drag-region @mousedown="startWindowDrag">
      <TitleBarControls title="设置" :show-back="true" :show-account="false">
        <template #extra>
          <div style="flex-shrink: 0">
            <SettingsSearch @select="handleSearchSelect" />
          </div>
        </template>
      </TitleBarControls>
    </div>

    <!-- 主要内容区域 -->
    <div class="settings-layout">
      <!-- 左侧导航栏 -->
      <div class="sidebar" style="width: 17.5rem; min-width: 17.5rem; max-width: 17.5rem; flex: 0 0 17.5rem" @mousedown="startWindowDrag">
        <nav class="sidebar-nav">
          <div
            v-for="category in settingsCategories"
            :id="`settings-nav-${category.key}`"
            :key="category.key"
            class="nav-item"
            data-no-window-drag
            :class="{ active: activeCategory === category.key }"
            @click="switchCategory(category.key)"
          >
            <div class="nav-icon">
              <component :is="category.icon" />
            </div>
            <div class="nav-content">
              <div class="nav-label">{{ category.label }}</div>
              <div class="nav-description">{{ category.description }}</div>
            </div>
          </div>
        </nav>
      </div>

      <!-- 右侧内容面板 -->
      <div class="content-panel">
        <div ref="contentPanelRef" class="panel-content">
          <!-- 切走就卸载，不 KeepAlive，插件/播放设置的 DOM 不能堆在内存里。 -->
          <component
            :is="currentComponent"
            :key="activeCategory"
            @switch-category="switchCategory"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.main-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--settings-main-bg);
}

.header {
  -webkit-app-region: drag;
  display: flex;
  align-items: center;
  background: var(--settings-header-bg);
  padding: 1.5rem;
  z-index: 1000;
}

.settings-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

// 左侧导航栏
.sidebar {
  width: 17.5rem;
  min-width: 17.5rem;
  max-width: 17.5rem;
  flex: 0 0 17.5rem;
  background: var(--settings-sidebar-bg);
  padding-right: 0.3125rem;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding-left: 0.3125rem;

  .sidebar-nav {
    flex: 1;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1.5rem;
    margin-top: 0.3125rem;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      border-color 0.15s ease;
    border-left: 0.1875rem solid transparent;
    border-radius: 0.3125rem;

    &:hover {
      background: var(--settings-nav-hover-bg);
    }

    &.active {
      background: var(--settings-nav-active-bg);
      border-left-color: var(--settings-nav-active-border);

      .nav-icon {
        color: var(--settings-nav-icon-active);
      }

      .nav-label {
        color: var(--settings-nav-label-active);
        font-weight: 600;
      }
    }

    .nav-icon {
      width: 1.25rem;
      height: 1.25rem;
      color: var(--settings-nav-icon-color);
      display: flex;
      justify-content: center;
      align-items: center;

      svg {
        width: 100%;
        height: 100%;
      }

      transition: color 0.2s ease;
    }

    .nav-content {
      flex: 1;
      min-width: 0;

      .nav-label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--settings-nav-label-color);
        margin-bottom: 0.125rem;
        transition: color 0.2s ease;
      }

      .nav-description {
        font-size: 0.75rem;
        color: var(--settings-nav-desc-color);
        line-height: 1.3;
      }
    }
  }
}

// 右侧内容面板
.content-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0.625rem;

  .panel-content {
    flex: 1;
    overflow-y: auto;
    background: var(--settings-main-bg);
    scroll-behavior: auto;
    contain: layout style;
  }
}

// 设置页切换优先保证即时响应，避免大量入场动画和延迟制造“卡住”的错觉。
:deep(.settings-section),
:deep(.setting-group) {
  animation: none !important;
}

// 屏幕外的设置卡片延后布局和绘制，减少一次切换需要处理的高度。
:deep(.setting-group) {
  content-visibility: auto;
  contain-intrinsic-size: auto 20rem;
}

// 响应式设计
@media (max-width: 64rem) {
  .settings-layout {
    flex-direction: column;
  }

  .sidebar {
    width: 100%;
    max-height: 12.5rem;
    border-right: none;
    border-bottom: 1px solid #e2e8f0;

    .sidebar-nav {
      display: flex;
      overflow-x: auto;
      padding: 0.5rem;

      .nav-item {
        flex-shrink: 0;
        min-width: 12.5rem;
        border-left: none;
        border-bottom: 0.1875rem solid transparent;

        &.active {
          border-left: none;
          border-bottom-color: #3b82f6;
        }
      }
    }
  }
}

.settings-window-hidden,
.settings-window-inactive,
.settings-page-idle {
  :deep(.settings-section),
  :deep(.setting-group),
  :deep(.setting-card),
  :deep(.highlight-flash::after) {
    animation-duration: 0.001s !important;
    animation-delay: 0s !important;
  }
}

.settings-window-hidden,
.settings-page-idle {
  .sidebar .nav-item,
  .sidebar .nav-icon,
  .sidebar .nav-label {
    transition-duration: 0s !important;
  }

  .panel-content {
    scroll-behavior: auto;
  }
}

// 过渡动画效果
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateX(1.25rem);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}

.fade-slide-enter-to,
.fade-slide-leave-from {
  opacity: 1;
  transform: translateX(0);
}

// Scrollbar styling
.sidebar,
.panel-content {
  // Webkit
  &::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: transparent;
  }
  // Firefox
  scrollbar-width: none;
  // IE/Edge
  -ms-overflow-style: none;
}

:deep(.highlight-flash) {
  position: relative;
}

:deep(.highlight-flash::after) {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  animation: flashHighlight 2s ease-out;
  z-index: 10;
}

@keyframes flashHighlight {
  0% {
    background-color: rgba(var(--td-brand-color-rgb), 0.2);
    box-shadow: 0 0 0 0.125rem var(--td-brand-color);
  }
  50% {
    background-color: rgba(var(--td-brand-color-rgb), 0.1);
  }
  100% {
    background-color: transparent;
    box-shadow: none;
  }
}
</style>
