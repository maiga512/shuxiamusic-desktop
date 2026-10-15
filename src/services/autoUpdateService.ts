import { NotifyPlugin } from 'tdesign-vue-next'

import { reactive } from 'vue'

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
}

export interface UpdateInfo {
  url: string
  name: string
  notes: string
  pub_date: string
  supportsDifferential?: boolean
  mode?: 'differential' | 'full'
}

// 响应式的下载状态
export const downloadState = reactive({
  isDownloading: false,
  progress: {
    percent: 0,
    transferred: 0,
    total: 0
  } as DownloadProgress,
  updateInfo: null as UpdateInfo | null
})

export class AutoUpdateService {
  private static instance: AutoUpdateService
  private isListening = false
  private lastErrorMessage = ''
  private lastErrorAt = 0
  // 跟踪当前这次“检查更新”是手动触发还是后台静默触发。
  // 后台检查全程静默：不提示“已是最新”、检查阶段的报错也不弹窗。
  // 默认按静默处理，只有手动点“检查更新”时才临时置为非静默，用完即复位，
  // 避免任何非手动来源的检查结果误弹“已是最新”。
  private checkInFlight = false
  private checkIsSilent = true
  private checkToken = 0

  constructor() {
    // 构造函数中自动开始监听
    this.startListening()
  }

  static getInstance(): AutoUpdateService {
    if (!AutoUpdateService.instance) {
      AutoUpdateService.instance = new AutoUpdateService()
    }
    return AutoUpdateService.instance
  }

  // 开始监听更新消息
  startListening() {
    if (this.isListening) return

    this.isListening = true

    // 监听各种更新事件
    window.api.autoUpdater.onCheckingForUpdate(() => {
      this.showCheckingNotification()
    })

    window.api.autoUpdater.onUpdateAvailable((updateInfo: UpdateInfo) => {
      // 有新版无论手动/后台都照常走（下载 + 后续提示）。
      this.checkInFlight = false
      this.checkIsSilent = true
      void this.showUpdateAvailableDialog(updateInfo)
    })

    window.api.autoUpdater.onUpdateNotAvailable(() => {
      // 只有手动检查才提示“已是最新”；后台/其它来源静默。
      const silent = this.checkIsSilent
      this.checkInFlight = false
      this.checkIsSilent = true
      if (!silent) this.showNoUpdateNotification()
    })

    window.api.autoUpdater.onDownloadStarted((updateInfo: UpdateInfo) => {
      this.handleDownloadStarted(updateInfo)
    })

    window.api.autoUpdater.onDownloadProgress((progress: DownloadProgress) => {
      console.log(progress)

      this.showDownloadProgressNotification(progress)
    })

    window.api.autoUpdater.onUpdateDownloaded(() => {
      this.showUpdateDownloadedDialog()
    })

    window.api.autoUpdater.onError(
      (error: string | { code?: string; message: string; raw?: string }) => {
        // 后台静默检查阶段的报错不弹窗，只记日志；下载等其它阶段的报错照常提示。
        const duringSilentCheck = this.checkInFlight && this.checkIsSilent
        this.checkInFlight = false
        this.checkIsSilent = true
        if (duringSilentCheck) {
          console.warn('[auto-update] 后台检查出错(静默):', error)
          return
        }
        this.showUpdateErrorNotification(error)
      }
    )

    window.api.autoUpdater.onDifferentialFallback((info: { reason: string }) => {
      this.showDifferentialFallbackNotification(info?.reason)
    })
  }

  // 停止监听更新消息
  stopListening() {
    if (!this.isListening) return

    this.isListening = false
    window.api.autoUpdater.removeAllListeners()
  }

  // 检查更新
  // options.silent = true 表示后台自动检查：全程静默（不提示“已是最新”、检查报错不弹窗）。
  async checkForUpdates(options?: { silent?: boolean }) {
    const silent = options?.silent === true
    // 后台检查不打断正在进行的检查（可能是用户刚点的手动检查）。
    if (silent && this.checkInFlight) return
    const token = ++this.checkToken
    this.checkInFlight = true
    this.checkIsSilent = silent
    // 兜底：万一没有收到任何结果事件，60s 后清掉在途标记，避免误伤后续的下载报错。
    window.setTimeout(() => {
      if (this.checkToken === token) this.checkInFlight = false
    }, 60000)
    try {
      await window.api.autoUpdater.checkForUpdates()
    } catch (error) {
      if (this.checkToken === token) this.checkInFlight = false
      if (silent) {
        console.warn('[auto-update] 后台检查失败:', error)
        return
      }
      console.error('检查更新失败:', error)
      NotifyPlugin.error({
        title: '更新检查失败',
        content: '无法检查更新，请稍后重试',
        duration: 3000
      })
    }
  }

  // 下载更新
  async downloadUpdate(mode?: 'differential' | 'full') {
    try {
      await window.api.autoUpdater.downloadUpdate(mode)
    } catch (error) {
      console.error('下载更新失败:', error)
      NotifyPlugin.error({
        title: '下载更新失败',
        content: '无法下载更新，请稍后重试',
        duration: 3000
      })
    }
  }

  // 安装更新：Tauri updater 已经下载的更新会在应用退出/下次启动时处理。
  async quitAndInstall() {
    try {
      await window.api.autoUpdater.quitAndInstall()
    } catch (error) {
      console.error('安装更新失败:', error)
      NotifyPlugin.error({
        title: '安装更新失败',
        content: '无法安装更新，请稍后重启应用',
        duration: 3000
      })
    }
  }

  // 显示检查更新通知
  private showCheckingNotification() {
    // 检查中有即时反馈，避免用户以为没反应而连点（连点曾导致并发下载互相打架）
    NotifyPlugin.info({
      title: '正在检查更新',
      content: '请稍候...',
      duration: 1500
    })
  }

  // 显示有更新可用：后台自动下载，不弹出更新对话框。
  private async showUpdateAvailableDialog(updateInfo: UpdateInfo) {
    downloadState.updateInfo = updateInfo

    try {
      const tasks = await window.api.download.getTasks()
      const updateTask = (tasks || []).find((t: any) => t?.songInfo?.source === 'update')
      if (updateTask && ['downloading', 'queued'].includes(updateTask.status)) return
    } catch {}

    try {
      await this.downloadUpdate('full')
    } catch (error) {
      console.warn('[auto-update] 后台下载失败:', error)
    }
  }

  // 询问用户选择更新方式 (差分/全量)
  private askModeAndDownload() {
    const dialog = DialogPlugin.confirm({
      header: '选择更新方式',
      body: () => {
        const content =
          '差分更新: 仅下载变化的部分,体积小、速度快,推荐使用\n\n全量更新: 重新下载完整安装包,适用于差分失败时的备用方案'
        return h(
          'div',
          { style: 'white-space: pre-line; max-height: 60vh; overflow-y: auto' },
          content
        )
      },
      confirmBtn: '差分更新 (推荐)',
      cancelBtn: '全量更新',
      onConfirm: () => {
        this.downloadUpdate('differential')
        dialog.hide()
      },
      onCancel: () => {
        this.downloadUpdate('full')
        dialog.hide()
      }
    })
  }

  // 显示无更新通知
  private showNoUpdateNotification() {
    NotifyPlugin.info({
      title: '已是最新版本',
      content: '当前已是最新版本，无需更新',
      duration: 1500
    })
  }

  // 处理下载开始事件
  private handleDownloadStarted(updateInfo: UpdateInfo) {
    downloadState.isDownloading = false
    downloadState.updateInfo = updateInfo
    downloadState.progress = { percent: 0, transferred: 0, total: 0 }
    const isDifferential = updateInfo.mode === 'differential'
    NotifyPlugin.info({
      title: '开始下载更新',
      content: isDifferential
        ? '正在以差分方式下载,完成后将提示安装'
        : '已加入下载管理，可在“下载管理”查看进度',
      duration: 3000
    })
  }

  // 更新下载进度状态
  private showDownloadProgressNotification(progress: DownloadProgress) {
    // 已迁移到下载管理，保持兼容但不再显示覆盖层
    downloadState.progress = progress
  }

  // 更新下载完成后只记录待安装状态；下次启动由 Tauri updater 完成安装。
  private showUpdateDownloadedDialog() {
    downloadState.isDownloading = false
    downloadState.progress.percent = 100
    void window.api.autoUpdater.recordEvent({ status: 'PENDING' })
  }

  // 显示更新错误通知
  private showUpdateErrorNotification(
    error: string | { code?: string; message?: string; raw?: string } | null | undefined
  ) {
    // 30s dedup: same error only shows once to avoid repeated popups
    const now = Date.now()
    const errorKey = typeof error === 'string' ? error : (error?.message || error?.raw || 'unknown')
    if (errorKey === this.lastErrorMessage && now - this.lastErrorAt < 30000) return
    this.lastErrorMessage = errorKey
    this.lastErrorAt = now
    if (!error) {
      NotifyPlugin.error({
        title: '更新失败',
        content: '未知错误,请稍后重试',
        duration: 5000
      })
      return
    }

    if (typeof error === 'string') {
      NotifyPlugin.error({
        title: '更新失败',
        content: error,
        duration: 5000
      })
      return
    }

    // 结构化错误: 主进程已经把 ENOTFOUND/ETIMEDOUT 等翻译成中文 message
    const friendly = error.message || error.raw || '未知错误,请稍后重试'
    const lines = [friendly]
    if (error.code && friendly !== error.code) lines.push(`错误代码: ${error.code}`)
    NotifyPlugin.error({
      title: '更新失败',
      content: lines.join('\n'),
      duration: 6000
    })
  }

  // 差分下载失败,自动回退全量时的提示
  private showDifferentialFallbackNotification(reason?: string) {
    NotifyPlugin.warning({
      title: '差分更新失败',
      content: `${reason || '差分下载失败'}, 已自动切换到全量下载`,
      duration: 4000
    })
  }

  // 格式化字节大小
}

// 导出单例实例
export const autoUpdateService = AutoUpdateService.getInstance()
