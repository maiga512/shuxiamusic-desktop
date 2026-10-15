/**
 * 临时 stub: @tauri-apps/plugin-updater
 *
 * 当前项目的 vite alias 会把 @tauri-apps/plugin-updater 指到这里。
 * 这里保持 Electron 迁移层需要的 checkUpdate / onUpdaterEvent 形态，底层转发到 Tauri v2 updater IPC。
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import type { UnlistenFn } from '@tauri-apps/api/event'

export interface UpdateManifest {
  version: string
  date: string
  body: string
  url?: string
}

export interface UpdateResult {
  shouldUpdate: boolean
  manifest?: UpdateManifest & {
    downloadAndInstall: () => Promise<void>
  }
  downloadAndInstall: () => Promise<void>
}

export interface UpdaterEvent {
  status:
    | 'CHECKING'
    | 'UPDATE_AVAILABLE'
    | 'UPTODATE'
    | 'DOWNLOAD_PROGRESS'
    | 'DOWNLOADED'
    | 'ERROR'
    | 'PENDING'
  data?: Record<string, any>
  error?: string
}

/**
 * 原生 `plugin:updater|check` 返回的是 tauri-plugin-updater 的 Metadata：
 *   { rid, current_version, version, date, body, raw_json }
 * 注意：它**没有** available / shouldUpdate 字段（历史上这里按有这两个字段写，
 * 导致判定恒为 false、永远提示「已是最新」，在线更新完全失效）。
 * rid 是后续 download_and_install 必需的资源句柄。
 */
type NativeUpdate = {
  rid?: number
  version?: string
  current_version?: string
  currentVersion?: string
  date?: string
  body?: string
  raw_json?: Record<string, any>
  rawJson?: Record<string, any>
  // 兼容字段（部分版本/自定义实现可能带）
  available?: boolean
  shouldUpdate?: boolean
  downloadUrl?: string
  url?: string
  manifest?: Record<string, any>
}

type NativeDownloadEvent =
  | { event: 'Started'; data?: { contentLength?: number } }
  | { event: 'Progress'; data?: { chunkLength?: number } }
  | { event: 'Finished'; data?: Record<string, never> }
  | Record<string, any>

const listeners = new Set<(event: UpdaterEvent) => void>()

function emitUpdaterEvent(event: UpdaterEvent) {
  listeners.forEach((listener) => {
    try {
      listener(event)
    } catch (error) {
      console.warn('[tauri-plugin-updater stub] listener failed:', error)
    }
  })
}

function getManifest(update: NativeUpdate): UpdateManifest {
  const manifest = update.manifest || update.raw_json || update.rawJson || update
  return {
    version: String(manifest.version || update.version || ''),
    date: String(manifest.date || update.date || ''),
    body: String(manifest.body || update.body || ''),
    url: String(manifest.url || update.downloadUrl || update.url || ''),
  }
}

function normalizeDownloadEvent(event: NativeDownloadEvent, state: { downloaded: number; total: number }) {
  if (event?.event === 'Started') {
    state.downloaded = 0
    state.total = Number(event.data?.contentLength || 0)
    emitUpdaterEvent({
      status: 'DOWNLOAD_PROGRESS',
      data: { downloaded: state.downloaded, total: state.total },
    })
    return
  }

  if (event?.event === 'Progress') {
    state.downloaded += Number(event.data?.chunkLength || 0)
    emitUpdaterEvent({
      status: 'DOWNLOAD_PROGRESS',
      data: { downloaded: state.downloaded, total: state.total },
    })
    return
  }

  if (event?.event === 'Finished') {
    emitUpdaterEvent({ status: 'DOWNLOADED' })
  }
}

async function invokeUpdater<T>(commands: string[], args?: Record<string, unknown>): Promise<T> {
  let lastError: unknown
  for (const command of commands) {
    try {
      return await invoke<T>(command, args)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

export async function checkUpdate(): Promise<UpdateResult | null> {
  emitUpdaterEvent({ status: 'CHECKING' })

  try {
    const result = await invokeUpdater<NativeUpdate | null>(['plugin:updater|check'])

    if (!result) {
      emitUpdaterEvent({ status: 'UPTODATE' })
      return null
    }

    // 原生 check 只在「确有可用更新」时返回 Some(Metadata)；返回 null 才是已是最新。
    // 旧写法 Boolean(result.available ?? result.shouldUpdate) 恒为 false（Metadata 无这两个字段），
    // 于是永远走「已是最新」分支。这里改为：拿到非空结果即视为有更新，version 作兜底校验。
    const shouldUpdate = Boolean(result.available ?? result.shouldUpdate ?? result.version)
    if (!shouldUpdate) {
      emitUpdaterEvent({ status: 'UPTODATE' })
      return { shouldUpdate, downloadAndInstall: async () => undefined }
    }

    const manifest = getManifest(result)
    emitUpdaterEvent({ status: 'UPDATE_AVAILABLE', data: manifest })

    const downloadAndInstall = async () => {
      const progressState = { downloaded: 0, total: 0 }
      const onEvent = new Channel<NativeDownloadEvent>((event) => {
        normalizeDownloadEvent(event, progressState)
      })

      // 原生命令签名是 download_and_install(rid, on_event, ...)，rid 必填：
      // 不传会直接报参数错误，下载永远失败（这是第二个 bug）。
      await invokeUpdater<void>(['plugin:updater|download_and_install'], {
        rid: result.rid,
        onEvent,
      })
      emitUpdaterEvent({ status: 'DOWNLOADED' })
    }

    return {
      shouldUpdate,
      manifest: {
        ...manifest,
        downloadAndInstall,
      },
      downloadAndInstall,
    }
  } catch (error) {
    console.warn('[tauri-plugin-updater stub] checkUpdate failed:', error)
    emitUpdaterEvent({ status: 'ERROR', error: String(error) })
    return null
  }
}

export async function installUpdate(): Promise<void> {
  try {
    // download_and_install 需要 rid，必须先 check 拿到更新句柄，不能直接裸调。
    const result = await checkUpdate()
    if (!result?.shouldUpdate) {
      emitUpdaterEvent({ status: 'UPTODATE' })
      return
    }
    await result.downloadAndInstall()
  } catch (error) {
    console.warn('[tauri-plugin-updater stub] installUpdate failed:', error)
    emitUpdaterEvent({ status: 'ERROR', error: String(error) })
  }
}

export async function onUpdaterEvent(
  callback: (event: UpdaterEvent) => void,
): Promise<UnlistenFn> {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export default { checkUpdate, installUpdate, onUpdaterEvent }
