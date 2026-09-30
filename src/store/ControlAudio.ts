import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { LocalUserDetailStore } from '@renderer/store/LocalUserDetail'
import {
  attachNativePlaybackStore,
  nativePause,
  nativePlay,
  nativeSetVolume
} from '@renderer/utils/audio/nativePlayback'

import type {
  AudioEventCallback,
  AudioEventType,
  AudioSlot,
  AudioSubscriber,
  UnsubscribeFunction,
  ControlAudioState
} from '@renderer/types/audio'

/**
 * 音频控制状态接口（双槽架构，用于无感过渡）。
 * @property {HTMLAudioElement | null | undefined} audio - 当前活跃槽的音频元素实例（指向 audioA 或 audioB）。
 * @property {HTMLAudioElement | null} audioA - 槽 A 的音频元素。
 * @property {HTMLAudioElement | null} audioB - 槽 B 的音频元素。
 * @property {AudioSlot} primarySlot - 当前活跃槽标识。
 * @property {string} srcA - 槽 A 的音频 URL（模板双向绑定）。
 * @property {string} srcB - 槽 B 的音频 URL（模板双向绑定）。
 * @property {string} secondaryUrl - 过渡期间非活跃槽待播的 URL（调试用）。
 * @property {boolean} isPlay - 是否正在播放。
 * @property {number} currentTime - 当前播放时间（秒）。
 * @property {number} duration - 音频总时长（秒）。
 * @property {number} volume - 音量（0-100）。
 * @property {string} url - 当前活跃槽的音频 URL。
 */
let userInfo: any
export const ControlAudioStore = defineStore(
  'controlAudio',
  () => {
    const Audio = reactive<ControlAudioState>({
      audio: null,
      audioA: null,
      audioB: null,
      primarySlot: 'A',
      srcA: '',
      srcB: '',
      secondaryUrl: '',
      isPlay: false,
      currentTime: 0,
      duration: 0,
      volume: 80,
      url: '',
      eventInit: false
    })

    // -------------------------------------------发布订阅逻辑------------------------------------------
    // 事件订阅者映射表
    /**
     * 音频事件订阅与发布逻辑。
     * @property {Record<AudioEventType, AudioSubscriber[]>} subscribers - 事件订阅者映射表。
     */
    const subscribers = reactive<Record<AudioEventType, AudioSubscriber[]>>({
      ended: [],
      seeked: [],
      timeupdate: [],
      play: [],
      pause: [],
      error: [],
      canplay: [],
      slotSwap: []
    })
    // 生成唯一ID
    const generateId = (): string => {
      return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    // 订阅事件
    /**
     * 订阅音频事件。
     * @param {AudioEventType} eventType - 事件类型。
     * @param {AudioEventCallback} callback - 事件回调函数。
     * @returns {UnsubscribeFunction} 取消订阅的函数。
     */
    const subscribe = (
      eventType: AudioEventType,
      callback: AudioEventCallback
    ): UnsubscribeFunction => {
      const id = generateId()
      const subscriber: AudioSubscriber = { id, callback }

      subscribers[eventType].push(subscriber)

      // 返回取消订阅函数
      return () => {
        const index = subscribers[eventType].findIndex((sub) => sub.id === id)
        if (index > -1) {
          subscribers[eventType].splice(index, 1)
        }
      }
    }

    // 发布事件
    const publish = (eventType: AudioEventType): void => {
      subscribers[eventType].forEach((subscriber) => {
        try {
          subscriber.callback()
        } catch (error) {
          console.error(`音频事件回调执行错误 [${eventType}]:`, error)
        }
      })
    }

    // 清空所有订阅者
    const clearAllSubscribers = (): void => {
      Object.keys(subscribers).forEach((eventType) => {
        subscribers[eventType as AudioEventType] = []
      })
    }

    // 清空特定事件的所有订阅者
    const clearEventSubscribers = (eventType: AudioEventType): void => {
      subscribers[eventType] = []
    }
    // End-------------------------------------------事件订阅者映射表逻辑------------------------------------------

    // 初始化：接收两个 audio 元素（双槽架构）
    const init = (elA: HTMLAudioElement | null, elB: HTMLAudioElement | null) => {
      userInfo = LocalUserDetailStore()
      console.log(elA, elB, '全局音频双槽挂载初始化success')
      Audio.audioA = elA
      Audio.audioB = elB
      Audio.audio = Audio.primarySlot === 'A' ? elA : elB
    }

    const getPrimaryEl = (): HTMLAudioElement | null => {
      return Audio.primarySlot === 'A' ? Audio.audioA : Audio.audioB
    }

    const getSecondaryEl = (): HTMLAudioElement | null => {
      return Audio.primarySlot === 'A' ? Audio.audioB : Audio.audioA
    }

    /**
     * 翻转活跃槽。翻转后 Audio.audio 指向新活跃槽元素，
     * Audio.url 更新为新活跃槽的 src。同时发布 slotSwap 事件
     * 让订阅者（如可视化组件）重新绑定。
     */
    const swapPrimarySlot = () => {
      Audio.primarySlot = Audio.primarySlot === 'A' ? 'B' : 'A'
      Audio.audio = Audio.primarySlot === 'A' ? Audio.audioA : Audio.audioB
      Audio.url = Audio.primarySlot === 'A' ? Audio.srcA : Audio.srcB
      Audio.secondaryUrl = ''
      publish('slotSwap')
    }

    /**
     * 设置当前播放时间。
     * @param {number} time - 播放时间（秒）。
     * @throws {Error} 如果时间不是数字类型。
     */
    const setCurrentTime = (time: number) => {
      if (typeof time === 'number') {
        if (Audio.currentTime === time) return
        const next = Math.round(time * 10) / 10
        if (Audio.currentTime === next) return
        Audio.currentTime = next
        return
      }
      throw new Error('时间必须是数字类型')
    }
    const setDuration = (duration: number) => {
      if (typeof duration === 'number') {
        Audio.duration = duration
        return
      }
      throw new Error('时间必须是数字类型')
    }
    /**
     * 设置音量。
     * @param {number} volume - 音量（0-100）。
     * @param {boolean} transition - 是否使用渐变。
     * @throws {Error} 如果音量不在0-100之间。
     */
const setVolume = (volume: number, transition: boolean = false) => {
      const next =
        typeof volume === 'number'
          ? volume <= 0
            ? 0
            : volume >= 100
              ? 100
              : volume
          : Audio.volume
      const changed = Audio.volume !== next
      if (changed) Audio.volume = next
      if (userInfo && userInfo.userInfo.volume !== next) {
        userInfo.userInfo.volume = next
      }
      if (!changed && !transition) return
      void nativeSetVolume(next, Boolean(Audio.isPlay && transition)).catch((error) => {
        console.warn('[controlAudio] native setVolume failed:', error)
      })
    }

    /**
     * 设置当前活跃槽的音频URL。
     * @param {string} url - 音频URL。
     * @throws {Error} 如果URL为空或无效。
     */
    const setUrl = (url: string) => {
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('音频URL不能为空')
      }

      // 停止当前播放
      if (Audio.isPlay) {
        stop()
      }

      const trimmed = url.trim()
      Audio.srcA = ''
      Audio.srcB = ''
      Audio.secondaryUrl = ''
      Audio.url = trimmed
      Audio.currentTime = 0
      Audio.duration = 0
      console.log('音频URL已设置(native mpv):', Audio.url)
    }

    /**
     * 设置非活跃槽的音频URL（用于无感过渡预加载）。
     */
    const setSecondaryUrl = (url: string) => {
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('次要音频URL不能为空')
      }
      const trimmed = url.trim()
      Audio.srcA = ''
      Audio.srcB = ''
      Audio.secondaryUrl = trimmed
      console.log('次要音频URL已设置(slot', Audio.primarySlot === 'A' ? 'B' : 'A', '):', trimmed)
    }

    /**
     * 清空非活跃槽的 src（过渡完成后清理旧元素）。
     */
    const clearSecondarySrc = () => {
      if (Audio.primarySlot === 'A') {
        Audio.srcB = ''
      } else {
        Audio.srcA = ''
      }
      Audio.secondaryUrl = ''
    }

    const start = async () => nativePlay()
    const stop = () => nativePause()

    attachNativePlaybackStore({
      get Audio() {
        return Audio
      },
      setCurrentTime,
      setDuration,
      publish
    })

    return {
      Audio,
      init,
      setCurrentTime,
      setVolume,
      setUrl,
      setSecondaryUrl,
      clearSecondarySrc,
      getPrimaryEl,
      getSecondaryEl,
      swapPrimarySlot,
      start,
      stop,
      subscribe,
      publish,
      clearAllSubscribers,
      clearEventSubscribers,
      setDuration
    }
  },
  {
    persist: false
  }
)
export type { AudioSlot }
