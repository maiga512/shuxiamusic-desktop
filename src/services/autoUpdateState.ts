import { reactive } from 'vue'

// 纯状态（不依赖 window.api / 副作用），可被任意组件（如全局 UpdateDialog）安全导入，
// 避免在 createTauriBridge() 建好 window.api 之前就实例化 AutoUpdateService。

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

// 更新状态机阶段：驱动全局 UpdateDialog 的展示与按钮。
export type UpdatePhase =
  | 'idle' // 初始 / 无进行中的更新
  | 'checking' // 正在检查
  | 'available' // 发现新版本，待下载
  | 'downloading' // 正在下载
  | 'downloaded' // 已下载，等待用户点“重启安装”
  | 'error' // 出错

// 响应式更新状态：全局 UpdateDialog（与可选状态栏）都读它。
export const downloadState = reactive({
  phase: 'idle' as UpdatePhase,
  isDownloading: false,
  progress: { percent: 0, transferred: 0, total: 0 } as DownloadProgress,
  updateInfo: null as UpdateInfo | null,
  errorMessage: '',
  // 是否显示“发现新版本 / 下载进度 / 重启安装”对话框。
  dialogVisible: false
})
