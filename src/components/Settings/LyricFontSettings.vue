<template>
  <div class="lyric-font-settings">
    <t-card title="歌词字体设置" hover-shadow>
      <div class="controls">
        <div class="field">
          <label>选择字体（支持多选）</label>
          <t-select
            v-model="lyricFontFamily"
            :options="fontOptions"
            placeholder="请选择字体"
            filterable
            multiple
            @change="handleFontChange"
          />
        </div>

        <div class="row">
          <div class="field">
            <label>字体倍率 (Rate)</label>
            <t-input-number v-model="lyricFontRate" :min="0.1" :max="2" :step="0.05" />
          </div>
          <div class="field">
            <label>字重(100-900)</label>
            <t-input-number v-model="lyricFontWeight" :min="100" :max="900" :step="100" />
          </div>
        </div>

        <div class="preview">
          <div
            class="preview-lyric"
            :style="{
              fontFamily: settings.lyricFontFamily,
              fontSize: `calc(min(clamp(30px, 2.5vw, 50px), 5vh) * ${settings.FullPlayLyricFontRate || 1.0})`,
              fontWeight: settings.lyricFontWeight
            }"
          >
            这是一段歌词预览 Text Preview 123
          </div>
        </div>
      </div>
    </t-card>
  </div>
</template>

<script setup lang="ts">
import '@renderer/assets/lyric-fonts.css'
import { ref, onMounted, computed } from 'vue'
import { useSettingsStore } from '@renderer/store/Settings'
import { storeToRefs } from 'pinia'
import { MessagePlugin } from 'tdesign-vue-next'

const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

const lyricFontRate = computed({
  get: () => settings.value.FullPlayLyricFontRate || 1.0,
  set: (val: number) => {
    settingsStore.updateSettings({ FullPlayLyricFontRate: val })
  }
})

const lyricFontWeight = computed({
  get: () => settings.value.lyricFontWeight || 700,
  set: (val: number) => {
    settingsStore.updateSettings({ lyricFontWeight: val })
  }
})

// Local state for v-model to sync with settings store
const lyricFontFamily = computed({
  get: () => {
    const font = settings.value.lyricFontFamily || 'PingFangSC-Semibold'
    // Split by comma and filter empty strings to get array for multi-select
    return font.split(',').filter(Boolean)
  },
  set: (val: string[]) => {
    // Join by comma to store as string
    settingsStore.updateSettings({ lyricFontFamily: val.join(',') })
  }
})

const fontList = ref<string[]>([])

// 字体列表缓存：字体枚举是慢操作（macOS 上曾走 system_profiler 要 20 秒以上），
// 每次进设置都重新拉会让界面发卡，所以先同步读缓存渲染，再后台刷新。
const FONT_LIST_CACHE_KEY = 'ceru_font_list_cache_v1'
const FONT_LIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const readCachedFontList = (): string[] => {
  try {
    const raw = localStorage.getItem(FONT_LIST_CACHE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.fonts) ? parsed.fonts.filter((f: unknown) => typeof f === 'string') : []
  } catch {
    return []
  }
}

const writeCachedFontList = (fonts: string[]) => {
  try {
    localStorage.setItem(
      FONT_LIST_CACHE_KEY,
      JSON.stringify({ fonts, updatedAt: Date.now() })
    )
  } catch {}
}

const cachedFontListAge = (): number => {
  try {
    const raw = localStorage.getItem(FONT_LIST_CACHE_KEY)
    if (!raw) return Number.POSITIVE_INFINITY
    const parsed = JSON.parse(raw)
    const updatedAt = Number(parsed?.updatedAt || 0)
    if (!updatedAt) return Number.POSITIVE_INFINITY
    return Date.now() - updatedAt
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const fontOptions = computed(() => {
  return fontList.value.map((font) => {
    let label = font
    if (font === 'lyricfont') {
      label = '阿里巴巴圆润体 (lyricfont)'
    } else if (font === 'PingFangSC-Semibold') {
      label = '苹方-简 中粗体 (PingFangSC-Semibold)'
    }
    return {
      label: label,
      value: font
    }
  })
})

const handleFontChange = () => {
  // Automatically saved by the setter of the computed property
  MessagePlugin.success('字体设置已更新')

  // Sync to desktop lyric if needed (but desktop lyric reads options on open/change,
  // currently desktop lyric doesn't know about font family)
  // We need to send an IPC message to desktop lyric window to update font family

  // Get current font family
  const font = settings.value.lyricFontFamily

  // Send IPC to main process, which forwards to lyric window or updates config
  window.electron.ipcRenderer.send('set-desktop-lyric-font', font)
}

onMounted(() => {
  // 先用缓存立即渲染，不阻塞界面
  const cached = readCachedFontList()
  if (cached.length > 0) fontList.value = cached

  // 缓存新鲜就不刷新；过期或为空时后台刷新（不 await，界面先可用）
  if (cached.length > 0 && cachedFontListAge() < FONT_LIST_CACHE_TTL_MS) return

  void (async () => {
    try {
      const fonts = await window.electron.ipcRenderer.invoke('get-font-list')
      if (Array.isArray(fonts) && fonts.length > 0) {
        fontList.value = fonts
        writeCachedFontList(fonts)
      } else if (cached.length === 0) {
        fontList.value = ['PingFangSC-Semibold', 'lyricfont']
      }
    } catch (e) {
      console.error('Failed to get font list', e)
      if (cached.length === 0) fontList.value = ['PingFangSC-Semibold', 'lyricfont']
    }
  })()
})
</script>

<style scoped>
.lyric-font-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.controls {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.preview {
  margin-top: 16px;
  padding: 30px;
  border: 1px dashed var(--td-border-level-1-color);
  border-radius: var(--td-radius-medium);
  background: var(--settings-preview-bg);
}
.preview-lyric {
  text-align: center;
  font-weight: 700;
  /* Ensure preview handles overflow gracefully if font is huge */
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
