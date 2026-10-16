<template>
  <div v-if="show" class="update-dialog-overlay" role="dialog" aria-modal="false">
    <div class="update-dialog-card">
      <!-- 头部 -->
      <div class="ud-header">
        <div class="ud-icon" :class="`ud-icon--${downloadState.phase}`">
          <span v-if="isDownloading" class="ud-spinner"></span>
          <span v-else class="ud-emoji">{{ phaseEmoji }}</span>
        </div>
        <div class="ud-titles">
          <h3 class="ud-title">{{ phaseTitle }}</h3>
          <p v-if="versionText" class="ud-subtitle">{{ versionText }}</p>
        </div>
      </div>

      <!-- 主体 -->
      <div class="ud-body">
        <!-- 可用 / 下载中：版本说明 -->
        <p v-if="showNotes" class="ud-notes">{{ notes }}</p>

        <!-- 进度条（下载中 / 已下载完成） -->
        <div v-if="isDownloading || downloadState.phase === 'downloaded'" class="ud-progress">
          <div class="ud-progress-bar">
            <div
              class="ud-progress-fill"
              :class="{ 'ud-progress-fill--indeterminate': indeterminate }"
              :style="indeterminate ? undefined : { width: percentText }"
            ></div>
          </div>
          <div class="ud-progress-meta">
            <span class="ud-progress-percent">{{ percentText }}</span>
            <span class="ud-progress-size">{{ sizeText }}</span>
          </div>
          <div v-if="speedText" class="ud-progress-speed">{{ speedText }}</div>
        </div>

        <!-- 错误信息 -->
        <p v-if="downloadState.phase === 'error' && downloadState.errorMessage" class="ud-error">
          {{ downloadState.errorMessage }}
        </p>
      </div>

      <!-- 底部按钮：按阶段切换 -->
      <div class="ud-footer">
        <!-- 可用：稍后提醒 / 立即更新 -->
        <template v-if="downloadState.phase === 'available'">
          <t-button theme="default" variant="text" @click="handleLater">稍后提醒</t-button>
          <t-button theme="primary" @click="handleStartDownload">立即更新</t-button>
        </template>

        <!-- 下载中：后台下载（不阻塞使用，完成后会再提示安装） -->
        <template v-else-if="isDownloading">
          <t-button theme="default" variant="text" @click="handleBackgroundDownload">
            后台下载
          </t-button>
        </template>

        <!-- 已下载：稍后 / 重启安装 -->
        <template v-else-if="downloadState.phase === 'downloaded'">
          <t-button theme="default" variant="text" @click="handleLater">稍后</t-button>
          <t-button theme="primary" @click="handleInstall">重启安装</t-button>
        </template>

        <!-- 错误：关闭 / 重试 -->
        <template v-else-if="downloadState.phase === 'error'">
          <t-button theme="default" variant="text" @click="handleClose">关闭</t-button>
          <t-button theme="primary" @click="handleStartDownload">重试</t-button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { downloadState } from '../services/autoUpdateState'

// 注意：这里只静态导入纯状态（autoUpdateState），不导入 autoUpdateService/composable，
// 避免在 createTauriBridge() 建好 window.api 之前实例化更新服务。
// 实际下载 / 安装直接走 window.api.autoUpdater（window.api 就绪后才可能触发这些按钮）。

const isDownloading = computed(() => downloadState.isDownloading)
const show = computed(() => downloadState.dialogVisible)

const versionText = computed(() => {
  const name = downloadState.updateInfo?.name
  return name ? `树夏Music v${name}` : ''
})

const notes = computed(() => {
  const notes = downloadState.updateInfo?.notes?.trim()
  return notes || '修复已知问题，优化体验。'
})

const showNotes = computed(
  () =>
    (downloadState.phase === 'available' ||
      downloadState.phase === 'downloading' ||
      downloadState.phase === 'downloaded') &&
    Boolean(notes.value)
)

const percentText = computed(() => {
  if (indeterminate.value) return '…'
  return `${Math.round(downloadState.progress.percent)}%`
})

// 服务端未返回 Content-Length（total=0）时，显示不定长进度条，而不是卡在 0%。
const indeterminate = computed(() => downloadState.isDownloading && downloadState.progress.total <= 0)

const sizeText = computed(() => {
  const { transferred, total } = downloadState.progress
  if (!total) return transferred > 0 ? `已下载 ${formatBytes(transferred)}` : '正在连接…'
  return `${formatBytes(transferred)} / ${formatBytes(total)}`
})

const phaseTitle = computed(() => {
  switch (downloadState.phase) {
    case 'checking':
      return '正在检查更新'
    case 'available':
      return '发现新版本'
    case 'downloading':
      return '正在下载更新'
    case 'downloaded':
      return '更新已下载完成'
    case 'error':
      return '更新遇到问题'
    default:
      return '应用更新'
  }
})

const phaseEmoji = computed(() => {
  switch (downloadState.phase) {
    case 'checking':
      return '⏳'
    case 'available':
      return '🆕'
    case 'downloading':
      return '⬇️'
    case 'downloaded':
      return '✅'
    case 'error':
      return '⚠️'
    default:
      return '📦'
  }
})

// ---- 下载速度 ----
const downloadSpeed = ref(0)
let lastTransferred = 0
let lastTime = 0
let speedTimer: ReturnType<typeof setInterval> | null = null

const speedText = computed(() =>
  downloadSpeed.value > 0 ? `下载速度 ${formatBytes(downloadSpeed.value)}/s` : ''
)

const tickSpeed = () => {
  const now = Date.now()
  const cur = downloadState.progress.transferred
  if (lastTime > 0) {
    const dt = (now - lastTime) / 1000
    if (dt > 0) downloadSpeed.value = Math.max(0, (cur - lastTransferred) / dt)
  }
  lastTransferred = cur
  lastTime = now
}

function ensureSpeedTimer() {
  if (speedTimer) return
  lastTransferred = 0
  lastTime = 0
  downloadSpeed.value = 0
  tickSpeed()
  speedTimer = setInterval(tickSpeed, 800)
}
function stopSpeedTimer() {
  if (speedTimer) {
    clearInterval(speedTimer)
    speedTimer = null
  }
  downloadSpeed.value = 0
}

watch(isDownloading, (down) => (down ? ensureSpeedTimer() : stopSpeedTimer()))
onUnmounted(stopSpeedTimer)

// ---- 动作（直接走 window.api；进度/阶段由 AutoUpdateService 的事件监听器回写 downloadState） ----
const handleStartDownload = () => {
  if (downloadState.isDownloading) return
  downloadState.phase = 'downloading'
  downloadState.isDownloading = true
  downloadState.progress = { percent: 0, transferred: 0, total: 0 }
  downloadState.errorMessage = ''
  void window.api?.autoUpdater?.downloadUpdate('full')
}

const handleInstall = () => {
  // 用户确认安装：重启进程，让就地替换后的新版本生效（此调用后应用会重启，await 不会返回）。
  void window.api?.autoUpdater?.quitAndInstall()
}

const handleBackgroundDownload = () => {
  // 隐藏对话框，下载在后台继续；下载完成时 AutoUpdateService 会重新打开对话框提示“重启安装”。
  downloadState.dialogVisible = false
}

const handleLater = () => {
  downloadState.dialogVisible = false
}

const handleClose = () => {
  downloadState.dialogVisible = false
}

// 格式化字节大小
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}
</script>

<style scoped>
.update-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100000;
  animation: ud-fade 0.18s ease;
}

.update-dialog-card {
  width: min(440px, calc(100vw - 3rem));
  background: var(--td-bg-color-container, #fff);
  color: var(--td-text-color-primary, #1f1f1f);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  overflow: hidden;
  animation: ud-pop 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.ud-header {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1.15rem 1.35rem 0.75rem;
}

.ud-icon {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.35rem;
  background: var(--td-brand-color-1, #e8f8f3);
  flex-shrink: 0;
}
.ud-icon--error {
  background: var(--td-error-color-light, #ffece8);
}
.ud-emoji {
  line-height: 1;
}

.ud-spinner {
  width: 20px;
  height: 20px;
  border: 2.5px solid var(--td-brand-color-3, #b7e6d8);
  border-top-color: var(--td-brand-color-6, #00a870);
  border-radius: 50%;
  animation: ud-spin 0.8s linear infinite;
}

.ud-titles {
  min-width: 0;
}
.ud-title {
  margin: 0;
  font-size: 1.06rem;
  font-weight: 700;
}
.ud-subtitle {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  color: var(--td-text-color-secondary, #777);
}

.ud-body {
  padding: 0.4rem 1.35rem 0.5rem;
}
.ud-notes {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  line-height: 1.55;
  color: var(--td-text-color-secondary, #666);
  white-space: pre-wrap;
  max-height: 8rem;
  overflow-y: auto;
  word-break: break-word;
}

.ud-progress {
  margin-top: 0.5rem;
}
.ud-progress-bar {
  height: 9px;
  border-radius: 6px;
  background: var(--td-bg-color-secondarycontainer, #eee);
  overflow: hidden;
}
.ud-progress-fill {
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--td-brand-color-6, #00a870), var(--td-brand-color-3, #7ce0c4));
  transition: width 0.35s ease;
}
.ud-progress-fill--indeterminate {
  width: 40%;
  transition: none;
  animation: ud-slide 1.15s ease-in-out infinite;
}
.ud-progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 0.4rem;
  font-size: 0.82rem;
}
.ud-progress-percent {
  font-weight: 700;
  color: var(--td-brand-color-6, #00a870);
}
.ud-progress-size {
  color: var(--td-text-color-secondary, #888);
}
.ud-progress-speed {
  margin-top: 0.25rem;
  text-align: right;
  font-size: 0.78rem;
  color: var(--td-text-color-placeholder, #aaa);
}

.ud-error {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--td-error-color, #e34d59);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 8rem;
  overflow-y: auto;
}

.ud-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.85rem 1.35rem 1.2rem;
}

@keyframes ud-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ud-pop {
  from { opacity: 0; transform: translateY(10px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ud-spin {
  to { transform: rotate(360deg); }
}
@keyframes ud-slide {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}

@media (prefers-reduced-motion: reduce) {
  .update-dialog-overlay,
  .update-dialog-card,
  .ud-spinner {
    animation: none;
  }
}
</style>
