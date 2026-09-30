/*
 * Copyright (c) 2025. 时迁酱 Inc. All rights reserved.
 *
 * This software is the confidential and proprietary information of 时迁酱.
 * Unauthorized copying of this file, via any medium is strictly prohibited.
 *
 * @author 时迁酱，无聊的霜霜，Star
 * @since 2025-9-19
 * @version 1.0
 */

import { nativeCurrentTime, nativeDuration } from './nativePlayback'
import { resolveSongCover } from './coverResolver'
import { rewritePublicCoverUrl } from '../coverThumb'

interface MediaSessionCallbacks {
  play: () => void
  pause: () => void
  playPrevious: () => void
  playNext: () => void
}

interface TrackMetadata {
  title: string
  artist: string
  album: string
  artworkUrl: string
}

function firstCoverValue(song: any): string {
  const candidates = [
    song?.img,
    song?.picUrl,
    song?.pic_url,
    song?.coverImg,
    song?.coverImgUrl,
    song?.cover,
    song?.artwork,
    song?.image,
    song?.pic,
    song?.album?.picUrl,
    song?.album?.cover,
    song?.album?.coverImgUrl
  ]
  return candidates.find((value) => typeof value === 'string' && value.trim())?.trim() || ''
}

function normalizeArtworkUrl(value: string): string {
  const url = String(value || '').trim()
  if (!url || url === 'default-cover' || url.startsWith('blob:')) return ''
  if (url.startsWith('data:')) return url
  return rewritePublicCoverUrl(url, 512)
}

function isDefaultArtwork(value: string): boolean {
  return !value || value === '/default-cover.png' || value.endsWith('/default-cover.png')
}

type NativeNowPlayingPayload = {
  title?: string
  artist?: string
  album?: string
  artworkUrl?: string
  duration?: number
  elapsed?: number
  playing?: boolean
  rate?: number
}

const syncNativeNowPlaying = (payload: NativeNowPlayingPayload) => {
  const invoke = (window as any)?.__TAURI__?.core?.invoke
  if (typeof invoke !== 'function') return
  void invoke('now_playing_update', payload).catch(() => {})
}

const readPlaybackClock = () => {
  try {
    return {
      elapsed: Number(nativeCurrentTime() || 0) || 0,
      duration: Number(nativeDuration() || 0) || 0
    }
  } catch {
    return { elapsed: 0, duration: 0 }
  }
}

/**
 * Media Session API 控制器
 * 用于管理浏览器的媒体会话，支持系统级媒体控制
 */
class MediaSessionController {
  private audioElement: HTMLAudioElement | null = null
  private callbacks: MediaSessionCallbacks | null = null
  private eventListeners: Array<{
    element: HTMLAudioElement
    event: string
    handler: EventListener
  }> = []
  private artworkRequestId = 0

  /**
   * 检查浏览器是否支持 Media Session API
   */
  private get isSupported(): boolean {
    return 'mediaSession' in navigator
  }

  /**
   * 更新媒体会话元数据
   */
  updateMetadata(metadata: TrackMetadata, song?: any): void {
    if (!this.isSupported) return

    try {
      const requestId = ++this.artworkRequestId
      const immediateArtwork = normalizeArtworkUrl(
        isDefaultArtwork(metadata.artworkUrl) ? firstCoverValue(song) : metadata.artworkUrl
      )
      // 确保元数据完整性，避免空值导致SMTC显示异常
      const safeMetadata = {
        title: metadata.title || '未知歌曲',
        artist: metadata.artist || '未知艺术家',
        album: metadata.album || '未知专辑',
        artwork: immediateArtwork ? this.generateArtworkSizes(immediateArtwork) : []
      }

      navigator.mediaSession.metadata = new MediaMetadata(safeMetadata)
      const clock = readPlaybackClock()
      syncNativeNowPlaying({
        title: safeMetadata.title,
        artist: safeMetadata.artist,
        album: safeMetadata.album,
        artworkUrl: immediateArtwork,
        elapsed: clock.elapsed,
        duration: clock.duration,
        playing: navigator.mediaSession.playbackState === 'playing'
      })

      // A playlist item can expose coverImgUrl/cover while img is empty. Resolve
      // that artwork asynchronously so metadata updates never delay playback.
      if (song && isDefaultArtwork(immediateArtwork)) {
        void resolveSongCover(song)
          .then((resolved) => {
            if (requestId !== this.artworkRequestId || !resolved) return
            const artworkUrl = normalizeArtworkUrl(resolved)
            if (!artworkUrl) return
            this.updateMetadata({ ...metadata, artworkUrl }, { ...song, img: resolved })
          })
          .catch(() => {})
      }
    } catch (error) {
      console.warn('Failed to update media session metadata:', error)
    }
  }

  /**
   * 生成不同尺寸的封面图片配置
   */
  private generateArtworkSizes(artworkUrl: string): MediaImage[] {
    const sizes = ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512']
    return sizes.map((size) => ({
      src: artworkUrl,
      sizes: size,
      type: 'image/png'
    }))
  }

  /**
   * 初始化媒体会话控制器
   */
  init(audioElement: HTMLAudioElement, callbacks: MediaSessionCallbacks): void {
    if (!this.isSupported) {
      console.warn('Media Session API is not supported in this browser')
      return
    }

    // 清理之前的监听器
    this.cleanup()

    this.audioElement = audioElement
    this.callbacks = callbacks

    // 只设置媒体会话动作处理器，不自动监听音频事件
    // 让应用层手动控制播放状态更新，避免循环调用
    this.setupMediaSessionActionHandlers()

    // 初始同步播放状态，确保组件重挂载后 UI 与实际状态一致
    try {
      navigator.mediaSession.playbackState = this.audioElement?.paused === false ? 'playing' : 'paused'
    } catch (error) {
      console.warn('Failed to sync initial playback state:', error)
    }
  }

  /**
   * 设置媒体会话动作处理器
   */
  private setupMediaSessionActionHandlers(): void {
    if (!this.callbacks) return

    const actionHandlers: Array<[MediaSessionAction, () => void]> = [
      ['play', this.callbacks.play],
      ['pause', this.callbacks.pause],
      ['previoustrack', this.callbacks.playPrevious],
      ['nexttrack', this.callbacks.playNext]
    ]

    actionHandlers.forEach(([action, handler]) => {
      navigator.mediaSession.setActionHandler(action, handler)
    })

    // 设置 seekto 处理器
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (!details.seekTime) return
      window.dispatchEvent(
        new CustomEvent('global-music-control', {
          detail: { name: 'seekAbsolute', val: details.seekTime }
        })
      )
    })
  }

  /**
   * 更新播放状态
   */
  updatePlaybackState(state: MediaSessionPlaybackState): void {
    if (!this.isSupported) return

    try {
      navigator.mediaSession.playbackState = state
      const meta = navigator.mediaSession.metadata
      const clock = readPlaybackClock()
      syncNativeNowPlaying({
        title: meta?.title || undefined,
        artist: meta?.artist || undefined,
        album: meta?.album || undefined,
        elapsed: clock.elapsed,
        duration: clock.duration,
        playing: state === 'playing',
        rate: state === 'playing' ? 1 : 0
      })
    } catch (error) {
      console.warn('Failed to update playback state:', error)
    }
  }

  /**
   * 清理事件监听器和媒体会话
   */
  cleanup(): void {
    // 移除音频事件监听器
    this.eventListeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler)
    })
    this.eventListeners = []

    // 清理媒体会话动作处理器
    if (this.isSupported) {
      const actions: MediaSessionAction[] = [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekto'
      ]
      actions.forEach((action) => {
        navigator.mediaSession.setActionHandler(action, null)
      })
    }

    this.audioElement = null
    this.callbacks = null
  }
}

// 导出单例实例
export default new MediaSessionController()
