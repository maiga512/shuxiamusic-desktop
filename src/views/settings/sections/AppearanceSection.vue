<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import { useSettingsStore } from '@renderer/store/Settings'
import TitleBarControls from '@renderer/components/TitleBarControls.vue'
import ThemeSelector from '@renderer/components/ThemeSelector.vue'

const LyricFontSettings = defineAsyncComponent(
  () => import('@renderer/components/Settings/LyricFontSettings.vue')
)
const DesktopLyricStyle = defineAsyncComponent(
  () => import('@renderer/components/Settings/DesktopLyricStyle.vue')
)
const GlobalBackgroundSettings = defineAsyncComponent(
  () => import('@renderer/components/Settings/GlobalBackgroundSettings.vue')
)

const userStore = LocalUserDetailStore()
const { userInfo } = storeToRefs(userStore)
const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)
const isMac = computed(() => /mac/i.test(navigator.platform || navigator.userAgent))

const currentStyle = ref<'windows' | 'traffic-light'>(
  userInfo.value.topBarStyle ? 'traffic-light' : 'windows'
)

const switchStyle = (style: 'windows' | 'traffic-light'): void => {
  currentStyle.value = style
  userInfo.value.topBarStyle = style === 'traffic-light'
}
</script>

<template>
  <div class="settings-section">
    <!-- 基础外观 -->
    <t-card title="基础外观" class="setting-card" hover-shadow>
      <div id="appearance-titlebar" class="setting-group-item">
        <div class="setting-label">
          <h4>标题栏风格</h4>
          <p>选择您喜欢的标题栏控制按钮风格</p>
        </div>

        <div class="style-buttons">
          <t-button
            :theme="currentStyle === 'windows' ? 'primary' : 'default'"
            @click="switchStyle('windows')"
          >
            Windows 风格
          </t-button>
          <t-button
            :theme="currentStyle === 'traffic-light' ? 'primary' : 'default'"
            @click="switchStyle('traffic-light')"
          >
            红绿灯风格
          </t-button>
        </div>

        <div class="style-preview">
          <div class="preview-item">
            <h4>Windows 风格</h4>
            <div class="mock-titlebar">
              <div class="mock-title">Windows 风格标题栏</div>
              <TitleBarControls control-style="windows" />
            </div>
          </div>
          <div class="preview-item">
            <h4>红绿灯风格 (macOS)</h4>
            <div class="mock-titlebar">
              <div class="mock-title">红绿灯风格标题栏</div>
              <TitleBarControls control-style="traffic-light" />
            </div>
          </div>
        </div>
      </div>

      <t-divider />

      <div id="appearance-close-behavior" class="setting-group-item">
        <div class="setting-label">
          <h4>关闭按钮行为</h4>
          <p>设置点击窗口关闭按钮时的行为</p>
        </div>
        <div class="setting-control" style="display: flex; align-items: center; gap: 0.625rem">
          <t-switch
            :value="settings.closeToTray"
            @change="(val) => settingsStore.updateSettings({ closeToTray: Boolean(val) })"
          />
          <span class="setting-text">{{
            settings.closeToTray ? '最小化到托盘' : '直接退出应用'
          }}</span>
        </div>
      </div>

      <t-divider />

      <div id="appearance-theme" class="setting-group-item">
        <div class="setting-label">
          <h4>应用主题色</h4>
          <p>选择应用的主题颜色</p>
        </div>
        <ThemeSelector />
      </div>

      <t-divider />

      <div
        v-if="settingsStore.shouldUseSpringFestivalTheme()"
        id="appearance-festival-theme"
        class="setting-group-item"
      >
        <div class="setting-label">
          <h4>节日主题(限时体验)</h4>
          <p>当前为春节主题，您可以选择关闭</p>
        </div>
        <div class="setting-control" style="display: flex; align-items: center; gap: 0.625rem">
          <t-button
            v-if="!settings.springFestivalDisabled"
            theme="danger"
            @click="settingsStore.disableSpringFestivalTheme()"
          >
            关闭春节主题
          </t-button>
          <template v-else>
            <t-tag theme="default">春节主题已关闭</t-tag>
            <t-button
              theme="success"
              variant="outline"
              @click="settingsStore.enableSpringFestivalTheme()"
            >
              开启春节主题
            </t-button>
          </template>
        </div>
      </div>
    </t-card>

    <div class="setting-spacer"></div>
    <t-card title="全局背景" class="setting-card" hover-shadow>
      <GlobalBackgroundSettings />
    </t-card>

    <template v-if="isMac">
      <div class="setting-spacer"></div>
      <t-card id="appearance-mac-status-lyric" title="状态栏歌词" class="setting-card" hover-shadow>
        <div class="setting-group-item">
          <div class="setting-label">
            <h4>菜单栏显示歌词</h4>
            <p>开启后在 mac 状态栏显示当前歌词，并可通过状态栏菜单控制歌曲。</p>
          </div>
          <div class="setting-control" style="display: flex; align-items: center; gap: 0.625rem">
            <t-switch
              :value="settings.macStatusBarLyricEnabled"
              @change="
                (val) => settingsStore.updateSettings({ macStatusBarLyricEnabled: Boolean(val) })
              "
            />
            <span class="setting-text">{{
              settings.macStatusBarLyricEnabled ? '已开启状态栏歌词' : '已关闭状态栏歌词'
            }}</span>
          </div>
        </div>
      </t-card>
    </template>

    <!-- 歌词设置 -->
    <div class="setting-spacer"></div>
    <div id="appearance-lyric-font">
      <LyricFontSettings />
    </div>

    <div class="setting-spacer"></div>
    <div id="appearance-desktop-lyric">
      <DesktopLyricStyle />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.setting-group-item {
  margin-bottom: 1.5rem;

  &:last-child {
    margin-bottom: 0;
  }
}

.setting-label {
  margin-bottom: 1rem;

  h4 {
    margin: 0 0 0.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--td-text-color-primary);
  }

  p {
    margin: 0;
    font-size: 0.75rem;
    color: var(--td-text-color-secondary);
  }
}

.style-buttons {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.5rem;

  .t-button {
    transition: all 0.2s ease;
    &:hover {
      transform: translateY(-1px);
    }
  }
}

.style-preview {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;

  .preview-item {
    background: var(--settings-preview-bg);
    padding: 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--settings-preview-border);

    h4 {
      margin: 0 0 0.75rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--settings-text-primary);
    }
  }
}

.mock-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: var(--settings-mock-titlebar-bg);
  border-radius: 0.375rem;
  border: 1px solid var(--settings-mock-titlebar-border);

  .mock-title {
    font-weight: 500;
    color: var(--settings-text-primary);
    font-size: 0.875rem;
  }
}

.setting-spacer {
  height: 1.5rem;
}

@media (max-width: 768px) {
  .style-preview {
    grid-template-columns: 1fr;
  }
}
</style>
