import { autoUpdateService, downloadState } from '../services/autoUpdateService'

export function useAutoUpdate() {
  // 检查更新（手动：silent 缺省 false，有新版只弹对话框，等用户点“立即更新”）
  const checkForUpdates = async (options?: { silent?: boolean }) => {
    await autoUpdateService.checkForUpdates(options)
  }

  // 开始下载更新（带进度）
  const downloadUpdate = async () => {
    await autoUpdateService.startDownload()
  }

  // 安装更新：重启进程，让新版本生效
  const quitAndInstall = async () => {
    await autoUpdateService.installNow()
  }

  // 打开 / 关闭更新对话框
  const openUpdateDialog = () => autoUpdateService.openDialog()
  const closeUpdateDialog = () => autoUpdateService.closeDialog()

  return {
    checkForUpdates,
    downloadUpdate,
    startDownload: downloadUpdate,
    quitAndInstall,
    installNow: quitAndInstall,
    openUpdateDialog,
    closeUpdateDialog,
    downloadState // 导出下载/更新状态供组件使用
  }
}
