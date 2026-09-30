/**
 * Electron 对照：src/main/events/pluginNotice.ts sendPluginNotice
 * Worker / NoticeCenter 发出的原始通知，转成渲染进程 PluginNoticeDialog 所需的 DialogNotice。
 * Tauri 适配：通过 sidecar stdout event 发出，Rust 再按同名事件转给前端。
 */

const emitPluginEvent = (event, payload) => {
  try {
    if (typeof globalThis.__ceruSidecarEmit === 'function') {
      globalThis.__ceruSidecarEmit(event, payload)
    }
  } catch {}
}

const isValidHttpUrl = (url) => {
  try {
    const parsed = new URL(String(url || ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const getNoticeTitle = (type) => {
  const titleMap = {
    update: '插件更新',
    error: '插件错误',
    warning: '插件警告',
    info: '插件信息',
    success: '操作成功'
  }
  return titleMap[type] || '插件通知'
}

const getDefaultNoticeMessage = (type, data, pluginName) => {
  switch (type) {
    case 'error':
      return `插件 "${pluginName}" 发生错误: ${data?.error || data?.message || '未知错误'}`
    case 'warning':
      return `插件 "${pluginName}" 警告: ${data?.warning || data?.message || '需要注意'}`
    case 'success':
      return `插件 "${pluginName}" 操作成功: ${data?.message || ''}`
    case 'info':
    default:
      return data?.message || `插件 "${pluginName}" 信息: ${JSON.stringify(data)}`
  }
}

export function sendPluginNotice(noticeData, pluginName, extra = {}) {
  const type = String(noticeData?.type || 'info')
  const data = noticeData?.data && typeof noticeData.data === 'object' ? noticeData.data : {}
  const name = pluginName || noticeData?.pluginName || extra.pluginName || 'Unknown Plugin'
  const pluginId = noticeData?.pluginId || extra.pluginId
  const baseNoticeData = {
    type,
    data,
    timestamp: noticeData?.timestamp || Date.now(),
    pluginName: name,
    pluginId
  }

  const notice = type === 'update' && data.url && isValidHttpUrl(data.url)
    ? {
        ...baseNoticeData,
        dialogType: 'update',
        title: data.title || '插件更新',
        message: data.content || `插件 "${name}" 有新版本可用`,
        updateUrl: data.url,
        pluginType: data.pluginInfo?.type,
        currentVersion: noticeData?.currentVersion || extra.currentVersion || '未知',
        newVersion: data.version,
        actions: [
          { text: '稍后更新', type: 'cancel' },
          { text: '立即更新', type: 'update', primary: true }
        ]
      }
    : {
        ...baseNoticeData,
        dialogType:
          type === 'error'
            ? 'error'
            : type === 'warn' || type === 'warning'
              ? 'warning'
              : type === 'success'
                ? 'success'
                : 'info',
        title: data.title || getNoticeTitle(type),
        message: data.message || data.content || getDefaultNoticeMessage(type, data, name),
        ...(data.url
          ? {
              updateUrl: data.url,
              pluginType: data.pluginInfo?.type
            }
          : {}),
        actions: data.url
          ? [
              { text: '取消', type: 'cancel' },
              { text: '安装并使用', type: 'confirm', primary: true }
            ]
          : [{ text: '我知道了', type: 'confirm', primary: true }]
      }

  emitPluginEvent('plugin-notice', notice)
  return notice
}

export function sendPluginThrottle(pluginId, reason, duration) {
  emitPluginEvent('plugin-throttle', {
    pluginId,
    reason: String(reason || ''),
    duration
  })
}

export function sendPluginDisabled(pluginId, reason) {
  emitPluginEvent('plugin-disabled', {
    pluginId,
    reason: String(reason || '')
  })
}
