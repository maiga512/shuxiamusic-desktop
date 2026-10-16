import { NotifyPlugin } from 'tdesign-vue-next'

import {
  downloadState,
  type DownloadProgress,
  type UpdateInfo,
  type UpdatePhase
} from './autoUpdateState'

// 向后兼容：既有组件（UpdateProgress / UpdateExample）从本模块导入 downloadState 与类型。
export { downloadState, type DownloadProgress, type UpdateInfo, type UpdatePhase }

// 版本号比较（形如 "1.1.2"）：a>b→1，a<b→-1，相等→0；非数字段按 0 处理，"1.1.2"<"1.1.13"。
function compareVersions(a: string, b: string): number {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10))
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

export class AutoUpdateService {
  private static instance: AutoUpdateService
  private isListening = false
  private lastErrorMessage = ''
  private lastErrorAt = 0
  // 跟踪当前这次“检查更新”是手动触发还是后台静默触发。
  // 后台静默检查：不提示“已是最新”、检查阶段报错不弹窗。
  // 手动检查：提示“已是最新”、检查报错弹窗。
  private checkInFlight = false
  private checkIsSilent = true
  private checkToken = 0
  // 本轮检查发现新版本时是否自动开始下载：
  //   后台静默检查 → 自动下载（带进度对话框，让用户看得见）；
  //   手动“检查更新” → 只弹对话框，等用户点“立即更新”。
  private autoStartDownloadOnAvailable = false

  constructor() {
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

    // 检查中：不再弹“正在检查更新”toast（后台静默；手动检查由按钮 loading 反馈）。
    // 只更新状态机，避免打断用户、避免重复叠加提示。
    window.api.autoUpdater.onCheckingForUpdate(() => {
      if (downloadState.phase === 'idle' || downloadState.phase === 'error') {
        downloadState.phase = 'checking'
      }
    })

    window.api.autoUpdater.onUpdateAvailable((updateInfo: UpdateInfo) => {
      const autoStart = this.autoStartDownloadOnAvailable
      this.autoStartDownloadOnAvailable = false
      this.checkInFlight = false
      this.checkIsSilent = true

      const incoming = updateInfo?.name
      const current = downloadState.updateInfo?.name
      const busy =
        downloadState.phase === 'downloaded' || downloadState.phase === 'downloading'
      // 同一版本已在下载/已下载待安装：不重复下载，只确保对话框提示（“重启安装”）。
      // 若到来的是更新的版本（incoming !== current），则重新走下载流程。
      if (busy && !!incoming && incoming === current) {
        downloadState.dialogVisible = true
        return
      }

      downloadState.updateInfo = updateInfo || downloadState.updateInfo
      downloadState.phase = 'available'
      downloadState.dialogVisible = true
      if (autoStart) void this.startDownload()
    })

    window.api.autoUpdater.onUpdateNotAvailable(() => {
      // 只有手动检查才提示“已是最新”；后台静默。
      const silent = this.checkIsSilent
      this.checkInFlight = false
      this.checkIsSilent = true
      if (downloadState.phase === 'checking' || downloadState.phase === 'idle') {
        downloadState.phase = 'idle'
      }
      if (!silent) this.showNoUpdateNotification()
    })

    window.api.autoUpdater.onDownloadStarted(() => {
      // 下载开始：置为下载中（此前误置 false 导致进度条永远不显示）。
      // 进度数值由 onDownloadProgress 回写，这里不重置，避免进度回闪。
      downloadState.phase = 'downloading'
      downloadState.isDownloading = true
    })

    window.api.autoUpdater.onDownloadProgress((progress: DownloadProgress) => {
      downloadState.phase = 'downloading'
      downloadState.isDownloading = true
      downloadState.progress = progress
    })

    window.api.autoUpdater.onUpdateDownloaded(() => {
      // 下载（并就地替换 .app）完成：转“待安装”，弹“重启安装”，交给用户确认。
      downloadState.phase = 'downloaded'
      downloadState.isDownloading = false
      downloadState.progress = { ...downloadState.progress, percent: 100 }
      downloadState.errorMessage = ''
      downloadState.dialogVisible = true
      void window.api.autoUpdater.recordEvent({ status: 'PENDING' })
    })

    window.api.autoUpdater.onError(
      (error: string | { code?: string; message: string; raw?: string }) => {
        // 后台静默检查阶段的报错不弹窗，只记日志；下载等其它阶段照常提示。
        const duringSilentCheck = this.checkInFlight && this.checkIsSilent
        this.checkInFlight = false
        this.checkIsSilent = true
        if (duringSilentCheck) {
          console.warn('[auto-update] 后台检查出错(静默):', error)
          if (downloadState.phase === 'checking') downloadState.phase = 'idle'
          return
        }
        this.showUpdateErrorNotification(error)
      }
    )

    // Tauri updater 只支持全量替换，差分回退事件为空实现，保留接口兼容。
    window.api.autoUpdater.onDifferentialFallback(() => {})
  }

  // 停止监听更新消息
  stopListening() {
    if (!this.isListening) return
    this.isListening = false
    window.api.autoUpdater.removeAllListeners()
  }

  // 检查更新
  // options.silent = true 表示后台自动检查：检查/无新版全程静默；有新版自动下载（带进度）。
  // options.silent 缺省/false 表示手动“检查更新”：有新版只弹对话框，等用户点“立即更新”。
  async checkForUpdates(options?: { silent?: boolean }) {
    const silent = options?.silent === true
    // 后台检查不打断正在进行的检查（可能是用户刚点的手动检查）。
    if (silent && this.checkInFlight) return

    const token = ++this.checkToken
    this.checkInFlight = true
    this.checkIsSilent = silent
    this.autoStartDownloadOnAvailable = silent
    if (downloadState.phase === 'idle' || downloadState.phase === 'error') {
      downloadState.phase = 'checking'
    }
    // 兜底：万一没有收到任何结果事件，60s 后清掉在途标记，避免误伤后续下载报错。
    window.setTimeout(() => {
      if (this.checkToken === token) {
        this.checkInFlight = false
        if (downloadState.phase === 'checking') downloadState.phase = 'idle'
      }
    }, 60000)
    try {
      await window.api.autoUpdater.checkForUpdates()
      // 结果由事件驱动（UPDATE_AVAILABLE / UPTODATE）。若事件没把 phase 推走，兜底回到 idle。
      if (this.checkToken === token && downloadState.phase === 'checking') {
        downloadState.phase = 'idle'
      }
    } catch (error) {
      if (this.checkToken === token) this.checkInFlight = false
      if (silent) {
        console.warn('[auto-update] 后台检查失败:', error)
        if (downloadState.phase === 'checking') downloadState.phase = 'idle'
        return
      }
      console.error('检查更新失败:', error)
      downloadState.phase = 'error'
      downloadState.errorMessage = String((error as any)?.message || error)
      NotifyPlugin.error({
        title: '更新检查失败',
        content: '无法检查更新，请稍后重试',
        duration: 3000
      })
    }
  }

  // 开始下载更新（带进度）。由对话框“立即更新”或后台自动触发。
  async startDownload() {
    if (downloadState.isDownloading || downloadState.phase === 'downloading') return
    downloadState.phase = 'downloading'
    downloadState.isDownloading = true
    downloadState.progress = { percent: 0, transferred: 0, total: 0 }
    downloadState.errorMessage = ''
    try {
      // bridge 侧 downloadUpdate 会 await 整个下载（进度经事件上报）；完成后记录 pending。
      await window.api.autoUpdater.downloadUpdate('full')
      // 兜底：事件未把 phase 置为 downloaded 时手动兜底。
      if (downloadState.phase === 'downloading') {
        downloadState.phase = 'downloaded'
      }
    } catch (error) {
      console.error('下载更新失败:', error)
      downloadState.isDownloading = false
      downloadState.phase = 'error'
      downloadState.errorMessage = String((error as any)?.message || error)
    }
  }

  // 安装更新：用户点“重启安装”后调用——重启进程，让就地替换后的新版本生效。
  async installNow() {
    try {
      await window.api.autoUpdater.quitAndInstall()
    } catch (error) {
      console.error('安装更新失败:', error)
      NotifyPlugin.error({
        title: '安装更新失败',
        content: '无法重启安装，请手动重启应用',
        duration: 5000
      })
    }
  }

  // 兼容旧接口名（composable/旧组件仍可能在用）。
  async downloadUpdate(_mode?: 'differential' | 'full') {
    return this.startDownload()
  }
  async quitAndInstall() {
    return this.installNow()
  }

  openDialog() {
    downloadState.dialogVisible = true
  }
  closeDialog() {
    downloadState.dialogVisible = false
  }

  // 启动时读取持久化的更新状态：
  //   - 上一轮“下载完成、待安装”(pending) 且当前运行版本仍比待安装版本旧
  //     → 弹“重启安装”对话框，让用户点确认后重启生效（不静默自动安装）。
  //   - 当前运行版本已 >= 待安装版本
  //     → 说明刚更新完重启过来、新版已在跑 → 清掉 pending，不再弹框。
  //       （否则每次启动都弹“重启安装”、点了又重启回同一版本，来回跳——“一直在跳转”的根因。）
  async initFromPersistedState() {
    try {
      const state = (await window.api?.autoUpdater?.getState?.()) as any
      const status = state?.status
      const info = state?.updateInfo
      if (status !== 'pending' || !info?.name) return

      const pendingVersion = String(info.name || '')
      const currentVersion = await this.getCurrentAppVersion()
      if (currentVersion && compareVersions(currentVersion, pendingVersion) >= 0) {
        // 更新已生效：把状态从 pending 归位到 up-to-date（同时清掉 updateInfo），避免下次启动再弹。
        downloadState.phase = 'idle'
        try {
          await window.api?.autoUpdater?.recordEvent?.({ status: 'UPTODATE' })
        } catch {
          /* 清状态失败不影响启动，最多下次再判一次 */
        }
        return
      }

      // 当前比待安装旧：下载完成但尚未重启 → 弹“重启安装”。
      downloadState.phase = 'downloaded'
      downloadState.isDownloading = false
      downloadState.updateInfo = {
        url: info.url || '',
        name: info.name || '',
        notes: info.notes || '',
        pub_date: info.pub_date || '',
        mode: info.mode === 'differential' ? 'differential' : 'full'
      }
      downloadState.progress = { percent: 100, transferred: 0, total: 0 }
      downloadState.errorMessage = ''
      downloadState.dialogVisible = true
    } catch (error) {
      console.warn('[auto-update] 读取持久化更新状态失败:', error)
    }
  }

  // 当前运行版本号（Rust package_info.version，唯一来源 package.json）。失败返回 ''。
  private async getCurrentAppVersion(): Promise<string> {
    try {
      const v = (await window.electron?.ipcRenderer?.invoke?.('get-app-version')) as unknown
      return String(v || '')
    } catch {
      return ''
    }
  }

  // 显示无更新通知（仅手动检查）
  private showNoUpdateNotification() {
    NotifyPlugin.info({
      title: '已是最新版本',
      content: '当前已是最新版本，无需更新',
      duration: 2000
    })
  }

  // 显示更新错误通知
  private showUpdateErrorNotification(
    error: string | { code?: string; message?: string; raw?: string } | null | undefined
  ) {
    // 30s dedup: 同一错误 30 秒内只提示一次，避免重复弹窗。
    const now = Date.now()
    const errorKey =
      typeof error === 'string' ? error : (error?.message || error?.raw || 'unknown')
    if (errorKey === this.lastErrorMessage && now - this.lastErrorAt < 30000) return
    this.lastErrorMessage = errorKey
    this.lastErrorAt = now

    downloadState.isDownloading = false

    if (!error) {
      downloadState.phase = 'error'
      downloadState.errorMessage = '未知错误,请稍后重试'
      downloadState.dialogVisible = true
      NotifyPlugin.error({ title: '更新失败', content: '未知错误,请稍后重试', duration: 5000 })
      return
    }

    let friendly: string
    if (typeof error === 'string') {
      friendly = error
    } else {
      friendly = error.message || error.raw || '未知错误,请稍后重试'
      if (error.code && friendly !== error.code) friendly = `${friendly}\n错误代码: ${error.code}`
    }

    const wasWorking = downloadState.phase === 'downloading' || downloadState.phase === 'checking'
    if (wasWorking) {
      downloadState.phase = 'error'
      downloadState.errorMessage = friendly
      // 下载/检查中出错：在对话框里显示，便于用户“重试”。
      downloadState.dialogVisible = true
    }
    NotifyPlugin.error({ title: '更新失败', content: friendly, duration: 6000 })
  }
}

// 导出单例实例
export const autoUpdateService = AutoUpdateService.getInstance()
