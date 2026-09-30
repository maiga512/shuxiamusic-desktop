import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { MessagePlugin } from 'tdesign-vue-next'

export interface AudioOutputDevice {
  deviceId: string
  kind: MediaDeviceKind
  label: string
  groupId: string
}

type NativeAudioOutputDevice = {
  deviceId?: string
  device_id?: string
  label?: string
  kind?: string
  groupId?: string
  group_id?: string
  isDefault?: boolean
  is_default?: boolean
}

const normalizeNativeDevices = (raw: unknown): AudioOutputDevice[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      const device = (item || {}) as NativeAudioOutputDevice
      const deviceId = String(device.deviceId || device.device_id || '').trim()
      if (!deviceId) return null
      return {
        deviceId,
        kind: 'audiooutput' as MediaDeviceKind,
        label: String(device.label || deviceId).trim() || deviceId,
        groupId: String(device.groupId || device.group_id || deviceId)
      }
    })
    .filter((item): item is AudioOutputDevice => Boolean(item))
}

const mergeOutputDevices = (...lists: AudioOutputDevice[][]): AudioOutputDevice[] => {
  const merged = new Map<string, AudioOutputDevice>()
  for (const list of lists) {
    for (const device of list) {
      if (!device?.deviceId) continue
      const prev = merged.get(device.deviceId)
      if (!prev) {
        merged.set(device.deviceId, device)
        continue
      }
      // Prefer a human label when one side only has a placeholder.
      const prevLooksFake = !prev.label || /Speaker \(/i.test(prev.label)
      if (prevLooksFake && device.label) merged.set(device.deviceId, device)
    }
  }
  if (!merged.has('default')) {
    merged.set('default', {
      deviceId: 'default',
      kind: 'audiooutput',
      label: '系统默认',
      groupId: 'default'
    })
  }
  return Array.from(merged.values())
}

const looksLikePlaceholderLabel = (label?: string) => {
  const value = String(label || '').trim()
  return !value || /^Speaker \(/i.test(value) || value === 'default'
}

const unlockBrowserDeviceLabels = async () => {
  try {
    const permissions = (window as any)?.api?.permissions
    if (typeof permissions?.requestMicrophone === 'function') {
      await permissions.requestMicrophone()
      return
    }
  } catch {
    // Ignore: native enumeration is the real fallback.
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
  } catch {
    // Ignore permission failures; still try enumerate/native list.
  }
}

/** Prefer browser deviceId (setSinkId needs it) and fill missing labels from native. */
const coalesceOutputDevices = (
  browserDevices: AudioOutputDevice[],
  nativeDevices: AudioOutputDevice[]
): AudioOutputDevice[] => {
  const nativeNamed = nativeDevices.filter((d) => d.deviceId !== 'default')
  const browserNamed = browserDevices.filter((d) => d.deviceId !== 'default')

  if (browserNamed.length > 0) {
    const labeled = browserNamed.map((device, index) => {
      if (!looksLikePlaceholderLabel(device.label)) return device
      const native = nativeNamed[index]
      if (!native?.label) return device
      return { ...device, label: native.label }
    })
    return mergeOutputDevices(
      [
        {
          deviceId: 'default',
          kind: 'audiooutput',
          label: '系统默认',
          groupId: 'default'
        }
      ],
      labeled
    )
  }

  return mergeOutputDevices(nativeDevices, browserDevices)
}

export interface DeviceStats {
  sampleRate: number
  channelCount: number
  latency: number
}

export const useAudioOutputStore = defineStore(
  'audioOutput',
  () => {
    const devices = ref<AudioOutputDevice[]>([])
    const currentDeviceId = ref<string>('default')
    const isLoading = ref(false)
    const error = ref<string | null>(null)
    const deviceStats = ref<DeviceStats>({
      sampleRate: 0,
      channelCount: 0,
      latency: 0
    })

    // For A/B testing
    const primaryDeviceId = ref<string>('default')
    const secondaryDeviceId = ref<string>('')
    const activeABChannel = ref<'A' | 'B'>('A') // 'A' or 'B'

    const sortedDevices = computed(() => {
      return [...devices.value].sort((a, b) => {
        if (a.deviceId === 'default') return -1
        if (b.deviceId === 'default') return 1
        return a.label.localeCompare(b.label)
      })
    })

    const currentDeviceLabel = computed(() => {
      const device = devices.value.find((d) => d.deviceId === currentDeviceId.value)
      return device ? device.label : 'Default'
    })

    // Scan for available audio output devices
    const scanDevices = async () => {
      isLoading.value = true
      error.value = null
      try {
        const readBrowserDevices = async () => {
          const allDevices = await navigator.mediaDevices.enumerateDevices()
          return allDevices
            .filter((device) => device.kind === 'audiooutput')
            .map((device) => ({
              deviceId: device.deviceId,
              kind: device.kind,
              label: device.label || `Speaker (${device.deviceId.slice(0, 5)}...)`,
              groupId: device.groupId
            }))
        }

        let browserDevices: AudioOutputDevice[] = []
        try {
          browserDevices = await readBrowserDevices()
        } catch (browserErr) {
          console.warn('Browser audio device enumeration failed:', browserErr)
        }

        const needsUnlock =
          browserDevices.length === 0 ||
          browserDevices.some((device) => looksLikePlaceholderLabel(device.label))
        if (needsUnlock) {
          await unlockBrowserDeviceLabels()
          try {
            browserDevices = await readBrowserDevices()
          } catch (browserErr) {
            console.warn('Browser audio device re-enumeration failed:', browserErr)
          }
        }

        let nativeDevices: AudioOutputDevice[] = []
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const listed = await invoke('native_audio_list_output_devices')
          nativeDevices = normalizeNativeDevices(listed)
        } catch (nativeErr) {
          console.warn('Native audio device enumeration failed:', nativeErr)
        }

        // Prefer browser ids when available (setSinkId needs them). If the
        // browser list is empty, keep native names so A/B UI is still usable.
        devices.value = coalesceOutputDevices(browserDevices, nativeDevices)

        if (!devices.value.length) {
          error.value = '未找到音频输出设备'
        }

        // Verify if current device still exists
        if (
          currentDeviceId.value !== 'default' &&
          !devices.value.find((d) => d.deviceId === currentDeviceId.value)
        ) {
          console.warn(
            `Previously selected device ${currentDeviceId.value} not found, reverting to default.`
          )
          currentDeviceId.value = 'default'
          MessagePlugin.warning('上次使用的音频设备未找到，已切换回默认设备')
        }
      } catch (err: any) {
        console.error('Failed to enumerate audio devices:', err)
        if (err?.name === 'NotAllowedError') {
          error.value = '访问音频设备权限被拒绝，请检查系统设置'
        } else if (err?.name === 'NotFoundError') {
          error.value = '未找到音频输出设备'
        } else {
          error.value = err?.message || '无法获取音频设备列表'
        }
        MessagePlugin.error(error.value || '获取音频设备列表失败')
      } finally {
        isLoading.value = false
      }
    }

    // Debug: Simulate large number of devices for performance testing
    const simulateDevices = (count: number = 100) => {
      const fakeDevices: AudioOutputDevice[] = []
      for (let i = 0; i < count; i++) {
        fakeDevices.push({
          deviceId: `fake-device-${i}`,
          kind: 'audiooutput',
          label: `Simulated Speaker ${i + 1} - High Definition Audio Device`,
          groupId: `fake-group-${i}`
        })
      }
      devices.value = [...devices.value, ...fakeDevices]
      MessagePlugin.info(`已生成 ${count} 个虚拟设备用于性能测试`)
    }

    // Set the audio output device
    const setDevice = async (deviceId: string) => {
      if (deviceId === currentDeviceId.value) return

      try {
        // We will delegate the actual switching to the AudioManager or GlobalAudio component
        // This store mainly manages the state.
        // However, we can emit an event or rely on a watcher in the component.
        currentDeviceId.value = deviceId

        // Update A/B state if applicable
        if (activeABChannel.value === 'A') {
          primaryDeviceId.value = deviceId
        } else {
          secondaryDeviceId.value = deviceId
        }

        if (String(deviceId).startsWith('cpal:')) {
          MessagePlugin.warning(
            `已选择 ${currentDeviceLabel.value}。当前 WebView 未提供可用的浏览器设备 ID，实际路由可能仍走系统默认。`
          )
        } else {
          MessagePlugin.success(`已切换音频输出至: ${currentDeviceLabel.value}`)
        }
      } catch (err: any) {
        console.error('Failed to set audio device:', err)
        error.value = err.message
        MessagePlugin.error('切换音频设备失败')
      }
    }

    const toggleAB = () => {
      if (activeABChannel.value === 'A') {
        if (secondaryDeviceId.value && secondaryDeviceId.value !== primaryDeviceId.value) {
          activeABChannel.value = 'B'
          setDevice(secondaryDeviceId.value)
        } else {
          MessagePlugin.info('请先设置对比设备 (设备 B)')
        }
      } else {
        activeABChannel.value = 'A'
        setDevice(primaryDeviceId.value)
      }
    }

    const handleDeviceChange = () => {
      console.log('Audio devices changed, rescanning...')
      if (devices.value.length > 0) {
        scanDevices()
      }
    }

    // Initialize listener for device changes (hot-plugging)
    const init = () => {
      // Ensure we don't duplicate listeners
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    }

    const playTestSound = (deviceId: string) => {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
        const ctx = new AudioContextClass()

        // Try to route if supported
        if ((ctx as any).setSinkId && deviceId !== 'default') {
          try {
            ;(ctx as any).setSinkId(deviceId)
          } catch (e) {
            console.warn('Test sound routing failed', e)
          }
        }

        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.type = 'sine'
        osc.frequency.setValueAtTime(440, ctx.currentTime)
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1)

        gain.gain.setValueAtTime(0.1, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5)

        osc.start()
        osc.stop(ctx.currentTime + 0.5)

        setTimeout(() => {
          ctx.close()
        }, 600)
      } catch (err: any) {
        console.error('Test sound failed', err)
        MessagePlugin.error('测试音播放失败')
      }
    }

    return {
      devices,
      sortedDevices,
      currentDeviceId,
      isLoading,
      error,
      deviceStats,
      currentDeviceLabel,
      primaryDeviceId,
      secondaryDeviceId,
      activeABChannel,
      scanDevices,
      setDevice,
      toggleAB,
      init,
      playTestSound,
      simulateDevices
    }
  },
  {
    persist: {
      paths: ['currentDeviceId', 'primaryDeviceId', 'secondaryDeviceId']
    } as any
  }
)
