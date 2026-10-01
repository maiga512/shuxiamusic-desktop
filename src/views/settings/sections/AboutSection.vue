<script setup lang="ts">
import { ref } from 'vue'
import Versions from '@renderer/components/Versions.vue'
import { useAutoUpdate } from '@renderer/composables/useAutoUpdate'
import { useSettingsStore } from '@renderer/store/Settings'
import { storeToRefs } from 'pinia'

const settingsStore = useSettingsStore()
const { settings } = storeToRefs(settingsStore)

const autoUpdate = ref(settings.value.autoUpdate)
const updateAutoUpdate = () => {
  settingsStore.updateSettings({
    autoUpdate: autoUpdate.value
  })
}

const appVersion = ref('1.0.0')
const isCheckingUpdate = ref(false)
const { checkForUpdates } = useAutoUpdate()

const getAppVersion = async () => {
  try {
    const version = await window.electron.ipcRenderer.invoke('get-app-version')
    if (version) {
      appVersion.value = version
    }
  } catch (error) {
    console.warn('Failed to get app version via IPC:', error)
  }
}

// 初始化时获取版本号
getAppVersion()

const handleCheckUpdate = async () => {
  isCheckingUpdate.value = true
  try {
    await checkForUpdates()
  } catch (error) {
    console.error('检查更新失败:', error)
  } finally {
    isCheckingUpdate.value = false
  }
}

const openLink = (url: string) => {
  window.open(url, '_blank')
}
</script>

<template>
  <div class="settings-section">
    <!-- 应用信息 -->
    <div class="setting-group">
      <div class="app-header">
        <div class="app-logo">
          <img src="/app-icon-square.png" alt="树夏Music" />
        </div>
        <div class="app-info">
          <div class="app-title-row">
            <h2>树夏Music</h2>
            <span class="app-version">v{{ appVersion }}</span>
          </div>
          <p class="app-subtitle">树夏音乐 播放器</p>
          <p class="app-description">
            树夏Music 是一款简洁的跨平台音乐播放器，通过合规插件获取公开音乐信息与播放能力。
          </p>
        </div>
      </div>
    </div>

    <!-- 版本信息 -->
    <div id="about-version" class="setting-group">
      <h3>版本信息</h3>
      <div class="version-section">
        <Versions />
        <div class="update-actions">
          <div class="update-option">
            <t-switch v-model:value="autoUpdate" @change="updateAutoUpdate"></t-switch>
            <div>应用启动时检查更新</div>
          </div>
          <t-button theme="primary" :loading="isCheckingUpdate" @click="handleCheckUpdate">
            {{ isCheckingUpdate ? '检查中...' : '检查更新' }}
          </t-button>
        </div>
      </div>
    </div>

    <!-- 技术栈 -->
    <div id="about-tech" class="setting-group">
      <h3>技术栈</h3>
      <div class="tech-stack">
        <div class="tech-item">
          <span class="tech-name">Tauri 2</span>
          <span class="tech-desc">跨平台桌面应用框架</span>
        </div>
        <div class="tech-item">
          <span class="tech-name">Rust</span>
          <span class="tech-desc">原生后端与系统能力</span>
        </div>
        <div class="tech-item">
          <span class="tech-name">Vue 3</span>
          <span class="tech-desc">响应式前端框架</span>
        </div>
        <div class="tech-item">
          <span class="tech-name">TypeScript</span>
          <span class="tech-desc">类型安全的 JavaScript</span>
        </div>
        <div class="tech-item">
          <span class="tech-name">Vite</span>
          <span class="tech-desc">快速前端构建工具</span>
        </div>
        <div class="tech-item">
          <span class="tech-name">Pinia</span>
          <span class="tech-desc">Vue 状态管理工具</span>
        </div>
        <div
          class="tech-item link"
          style="cursor: pointer"
          @click="openLink('https://github.com/Steve-xmh/applemusic-like-lyrics')"
        >
          <span class="tech-name">AMLL</span>
          <span class="tech-desc"> 歌词组件 </span>
        </div>
      </div>
    </div>

    <!-- 法律声明 -->
    <div id="about-legal" class="setting-group">
      <h3>法律声明</h3>
      <div class="legal-notice">
        <div class="notice-item">
          <h4>🔒 数据与内容责任</h4>
          <p>
            本项目不直接获取、存储、传输任何音乐数据或版权内容，仅提供插件运行框架。
            用户通过插件获取的所有数据，其合法性由插件提供者及用户自行负责。
          </p>
        </div>
        <div class="notice-item">
          <h4>⚖️ 版权合规要求</h4>
          <p>
            用户承诺仅通过合规插件获取音乐相关信息，且获取、使用版权内容的行为符合
            《中华人民共和国著作权法》及相关法律法规，不侵犯任何第三方合法权益。
          </p>
        </div>
        <div class="notice-item">
          <h4>🚫 使用限制</h4>
          <p>
            本项目仅允许用于非商业、纯技术学习目的，禁止用于任何商业运营、盈利活动，
            禁止修改后用于侵犯第三方权益的场景。
          </p>
        </div>
      </div>
    </div>

    <!-- 关于我 -->
    <div id="about-me" class="setting-group">
      <h3>关于我</h3>
      <div class="about-me">
        <h4 class="about-me-name">😊 标点符号</h4>
        <p class="about-me-motto">Leave the comfortable style, and leap into the imagination.</p>
        <p class="about-me-reward-text">如果树夏Music对你有帮助，欢迎扫码支持作者继续优化。</p>
        <img class="about-me-reward-qr" src="/about_author_reward_qr.jpg" alt="标点符号的赞赏码" />
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.setting-group {
  background: var(--settings-group-bg);
  border-radius: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--settings-group-border);
  box-shadow: 0 1px 0.1875rem var(--settings-group-shadow);

  h3 {
    margin: 0 0 0.5rem;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--settings-text-primary);
  }

  > p {
    margin: 0 0 1.5rem;
    color: var(--settings-text-secondary);
    font-size: 0.875rem;
  }
}

// 关于页面样式
.app-header {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 1rem 0;

  .app-logo {
    width: 4rem;
    height: 4rem;
    flex-shrink: 0;
    border-radius: 0.75rem;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  .app-info {
    flex: 1;

    .app-title-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.25rem;

      h2 {
        margin: 0;
        font-size: 1.5rem;
        font-weight: 700;
        color: var(--settings-text-primary);
      }

      .app-version {
        background: var(--td-brand-color-1);
        color: var(--td-brand-color-6);
        padding: 0.25rem 0.75rem;
        border-radius: 1rem;
        font-size: 0.75rem;
        font-weight: 600;
        border: 1px solid var(--td-brand-color-3);
      }
    }

    .app-subtitle {
      margin: 0 0 0.5rem;
      font-size: 1rem;
      font-weight: 600;
      color: var(--td-brand-color-5);
    }

    .app-description {
      margin: 0;
      color: var(--settings-text-secondary);
      line-height: 1.5;
    }
  }
}

.tech-stack {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15.625rem, 1fr));
  gap: 0.75rem;

  .tech-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: var(--settings-tech-item-bg);
    border-radius: 0.5rem;
    border: 1px solid var(--settings-tech-item-border);
    transition: 0.3s;
    gap: 1rem;

    .tech-name {
      font-weight: 600;
      flex-shrink: 0;
      color: var(--settings-text-primary);
    }

    .tech-desc {
      font-size: 0.875rem;
      color: var(--settings-text-secondary);
    }

    &.link:hover {
      background-color: var(--td-brand-color-1);
      border: 1px solid var(--td-brand-color-5);
    }

    &.link:active {
      transform: scale(0.9);
    }
  }
}

.legal-notice {
  .notice-item {
    margin-bottom: 1.5rem;

    &:last-child {
      margin-bottom: 0;
    }

    h4 {
      margin: 0 0 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--settings-text-primary);
    }

    p {
      margin: 0;
      font-size: 0.875rem;
      color: var(--settings-text-secondary);
      line-height: 1.5;
    }
  }
}

.about-me {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;

  .about-me-name {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--settings-text-primary);
  }

  .about-me-motto {
    margin: 0;
    font-size: 0.875rem;
    font-style: italic;
    color: var(--settings-text-secondary);
    line-height: 1.5;
  }

  .about-me-reward-text {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: var(--settings-text-secondary);
    line-height: 1.5;
  }

  .about-me-reward-qr {
    width: 200px;
    height: 200px;
    object-fit: contain;
    border-radius: 12px;
  }
}

// 版本信息样式
.version-section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  position: relative;

  .update-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .update-option {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
  }
}

@media (max-width: 768px) {
  .app-header {
    flex-direction: column;
    text-align: center;
    gap: 1rem;
  }

  .tech-stack {
    grid-template-columns: 1fr;
  }
}

</style>
