<script setup lang="ts">
defineOptions({ name: 'recognize' })
import { ref, onUnmounted } from 'vue'
import { ControlAudioStore } from '@renderer/store/ControlAudio'
import { MessagePlugin } from 'tdesign-vue-next'
import { MicrophoneIcon } from 'tdesign-icons-vue-next'
import { searchValue } from '@renderer/store/search'
import { useRouter } from 'vue-router'
import { generateShazamSignature } from '@renderer/utils/shazam'
import { selectMediaRecorderMimeType } from '@renderer/utils/audio/recorderMime'

const audioStore = ControlAudioStore()
const searchStore = searchValue()
const router = useRouter()

const MAX_DURATION = 20
const MIN_MATCH_DURATION = 5
const SLICE_DURATION = 5000 // 与安卓版一致：每 5 秒尝试一次识别

const running = ref(false)
const status = ref('') // 'recording' | 'processing' | 'uploading' | 'success' | 'failed'
const currentDuration = ref(0)
const recognizedSongs = ref<any[]>([])
const wasPlaying = ref(false)

let recorder: MediaRecorder | null = null
let chunks: Blob[] = []
let stream: MediaStream | null = null
let timer: any = null
let recognitionInFlight = false

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src.startsWith('/') ? src : `/${src}`
    s.onload = () => resolve()
    s.onerror = (e) => reject(e)
    document.head.appendChild(s)
  })
}

async function ensureAFP() {
  const g = window as any
  if (typeof g.GenerateFP === 'function') return
  if (!g.__afp_wasm_loaded__) {
    await loadScript('/afp.wasm.js')
    g.__afp_wasm_loaded__ = true
  }
  if (!g.__afp_runtime_loaded__) {
    await loadScript('/afp.js')
    g.__afp_runtime_loaded__ = true
  }
  if (typeof g.GenerateFP !== 'function') {
    throw new Error('听歌识曲指纹模块加载失败，请重启应用后重试')
  }
}

async function resampleToMono(audioBuffer: AudioBuffer, sampleRate: number): Promise<Float32Array> {
  const ctx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(
    1,
    Math.floor(audioBuffer.duration * sampleRate),
    sampleRate
  )

  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(ctx.destination)
  source.start()

  const renderedBuffer = await ctx.startRendering()
  return renderedBuffer.getChannelData(0)
}

async function resampleTo8kMono(audioBuffer: AudioBuffer): Promise<Float32Array> {
  return resampleToMono(audioBuffer, 8000)
}

async function start() {
  if (running.value || status.value === 'initializing') return

  try {
    status.value = 'initializing'
    await ensureAFP()

    const microphoneGranted = await window.api.permissions.requestMicrophone()
    if (!microphoneGranted) {
      MessagePlugin.warning('麦克风权限未开启，请在系统设置中允许树夏Music使用麦克风')
      await window.api.permissions.showGuide('microphone')
      reset()
      return
    }

    // 只授权这一次麦克风采集，不申请录屏或系统录音权限。
    const capturePrepared = await window.api.permissions.prepareMediaCapture('microphone')
    if (!capturePrepared) {
      MessagePlugin.error('麦克风采集请求未获授权，请重新点击开始识别')
      reset()
      return
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })

    if (!stream.getAudioTracks().length) {
      throw new Error('麦克风没有返回音频轨道')
    }

    // 权限与采集流都准备完成后才暂停播放，避免拒绝权限后播放被无谓打断。
    if (audioStore.Audio.isPlay) {
      wasPlaying.value = true
      await audioStore.stop()
    } else {
      wasPlaying.value = false
    }

    const audioStream = new MediaStream(stream.getAudioTracks())
    const mimeType = selectMediaRecorderMimeType((type) => MediaRecorder.isTypeSupported(type))
    recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined)

    chunks = []
    running.value = true
    status.value = 'recording'
    currentDuration.value = 0
    recognizedSongs.value = []

    recorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data)

        // Try recognition with accumulated data
        const blob = new Blob(chunks, { type: mimeType })
        await tryRecognize(blob)
      }
    }

    // Start recording with time slices
    recorder.start(SLICE_DURATION)

    // Timer for UI update and max duration check
    const startTime = Date.now()
    timer = setInterval(() => {
      const elapsed = (Date.now() - startTime) / 1000
      currentDuration.value = Math.floor(elapsed)

      if (elapsed >= MAX_DURATION) {
        void stopRecording(false) // Stop without success (timeout)
        MessagePlugin.warning('20 秒内未识别到歌曲，请靠近音源后重试')
      }
    }, 1000)
  } catch (err: any) {
    console.error('启动录音失败', err)
    if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
      MessagePlugin.error('麦克风权限被拒绝，请在系统设置中开启后重试')
      await window.api.permissions.showGuide('microphone')
    } else if (
      err?.name === 'NotReadableError' ||
      err?.name === 'DevicesNotFoundError' ||
      err?.name === 'TrackStartError'
    ) {
      MessagePlugin.error('麦克风设备被占用或不可用，请检查输入设备后重试')
    } else {
      const suffix = err?.name ? `（${err.name}）` : ''
      MessagePlugin.error(`${err?.message || '启动麦克风采集失败'}${suffix}`)
    }
    reset()
  }
}

async function tryRecognize(blob: Blob) {
  if (!running.value || recognitionInFlight || chunks.length < 1) return
  // 安卓端至少积累 5 秒音频后才发起匹配，避免短片段必然失败。
  if (currentDuration.value < MIN_MATCH_DURATION && chunks.length === 1) return
  recognitionInFlight = true

  try {
    const arrayBuffer = await blob.arrayBuffer()
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()

    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

      // Basic silence check
      const channelData = audioBuffer.getChannelData(0)
      let hasSound = false
      for (let i = 0; i < channelData.length; i += 100) {
        if (Math.abs(channelData[i]) > 0.01) {
          hasSound = true
          break
        }
      }

      if (!hasSound) {
        console.warn('Silent audio detected')
        return
      }

      const pcm16k = await resampleToMono(audioBuffer, 16000)
      const shazamSamples = pcm16k.subarray(0, MAX_DURATION * 16000)
      let shazamSignature
      try {
        shazamSignature = await generateShazamSignature(shazamSamples)
      } catch (error) {
        console.warn('[AudioRecognize] Shazam signature failed, using Netease fallback', error)
      }

      const pcm8k = await resampleTo8kMono(audioBuffer)
      const slice = pcm8k.subarray(0, MAX_DURATION * 8000)
      const gen = (window as any).GenerateFP
      const fp = typeof gen === 'function' ? await gen(slice) : undefined
      const result = await window.api.music.requestSdk('recognize', {
        source: 'wy',
        fp,
        shazamSignature,
        duration: slice.length / 8000
      })
      console.log('[AudioRecognize] Recognition result:', result)
      if (result && result.length > 0) {
        recognizedSongs.value = result
        status.value = 'success'
        await stopRecording(true)
        const first = result[0]
        setTimeout(() => handleSearchResult(first), 450)
      }
    } finally {
      ctx.close()
    }
  } catch (e) {
    console.error('Recognition attempt failed', e)
  } finally {
    recognitionInFlight = false
  }
}

async function stopRecording(success: boolean = false) {
  if (!running.value) return

  if (recorder && recorder.state !== 'inactive') {
    recorder.stop()
  }

  if (timer) {
    clearInterval(timer)
    timer = null
  }

  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
    stream = null
  }

  running.value = false

  if (!success) {
    status.value = 'failed'
  }

  // Resume music if it was playing and we didn't just find a new song (optional)
  // Requirement: "Resume playback after recording finishes"
  if (wasPlaying.value) {
    setTimeout(() => {
      audioStore.start()
    }, 500)
    wasPlaying.value = false
  }
}

function reset() {
  running.value = false
  status.value = ''
  currentDuration.value = 0
  chunks = []
  recognitionInFlight = false
  if (stream) {
    stream.getTracks().forEach((t) => t.stop())
    stream = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function handleSearchResult(song: any) {
  if (!song) return
  const query = [song.name, song.singer].filter(Boolean).join(' ').trim()
  if (!query) return
  searchStore.setValue(query)
  searchStore.addHistory(query)
  router.push({ name: 'search' })
}

onUnmounted(() => {
  reset()
})
</script>

<template>
  <div class="recognize-page">
    <div class="recognize-container">
      <div class="header">
        <h2>听歌识曲</h2>
        <p class="subtitle">点击麦克风，识别周围正在播放的声音</p>
      </div>

      <button
        class="microphone-button"
        :class="{ 'is-active': running }"
        type="button"
        aria-label="开始听歌识曲"
        :disabled="status === 'initializing'"
        @click="running ? stopRecording(false) : start()"
      >
        <div class="circle-waves">
          <div class="wave"></div>
          <div class="wave"></div>
          <div class="wave"></div>
          <div class="icon-container">
            <MicrophoneIcon size="88px" />
          </div>
        </div>
      </button>

      <div class="status-slot" aria-live="polite">
        <template v-if="running">
          <p class="status-text">正在识别中... {{ currentDuration }}s / {{ MAX_DURATION }}s</p>
          <t-progress
            :percentage="(currentDuration / MAX_DURATION) * 100"
            size="small"
            :label="false"
          />
        </template>
        <p v-else-if="status === 'initializing'" class="status-text">正在准备麦克风...</p>
        <p v-else-if="status === 'success'" class="status-text success">识别成功，正在搜索...</p>
        <p v-else-if="status === 'failed'" class="status-text error">没听出来，点麦克风再试一次</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recognize-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  /* background: var(--td-bg-color-container); */
  border-radius: 8px;
  overflow: hidden;
}

.recognize-container {
  width: 100%;
  height: 100%;
  text-align: center;
  display: flex;
  flex-direction: column;
  transition: all 0.3s ease;
  overflow: hidden;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 32px;
}

.header h2 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
  color: var(--td-text-color-primary);
  letter-spacing: -0.5px;
}

.subtitle {
  font-size: 14px;
  color: var(--td-text-color-secondary);
}

.visualizer-section {
  display: flex;
  justify-content: center;
  padding: 10px 0;
  flex-shrink: 0;
}

.microphone-button {
  width: 240px;
  height: 240px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  display: grid;
  place-items: center;
  cursor: pointer;
  outline: none;
}

.microphone-button:not(:disabled):hover .icon-container {
  transform: scale(1.08);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
}

.microphone-button:not(:disabled):active .icon-container {
  transform: scale(0.96);
}

.microphone-button:focus-visible {
  outline: 3px solid var(--td-brand-color);
  outline-offset: 8px;
}

.microphone-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.circle-waves {
  position: relative;
  width: 240px;
  height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-container {
  z-index: 10;
  width: 156px;
  height: 156px;
  background: var(--td-brand-color);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
  transition:
    transform 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275),
    box-shadow 0.35s ease;
  overflow: hidden;
}

.is-active .icon-container {
  transform: scale(1.1);
  box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.2);
}

.wave {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--td-brand-color);
  opacity: 0;
  z-index: 0;
}

.is-active .wave {
  animation: wave 2s infinite;
}

.is-active .wave:nth-child(2) {
  animation-delay: 0.6s;
}

.is-active .wave:nth-child(3) {
  animation-delay: 1.2s;
}

@keyframes wave {
  0% {
    width: 100%;
    height: 100%;
    opacity: 0.4;
  }
  100% {
    width: 250%;
    height: 250%;
    opacity: 0;
  }
}

.status-slot {
  width: 100%;
  max-width: 520px;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.status-display {
  width: 100%;
  max-width: 600px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  flex: 1;
  overflow-y: auto;
  padding: 0 4px; /* Add some padding for scrollbar */
}

.status-display::-webkit-scrollbar {
  width: 6px;
}

.status-display::-webkit-scrollbar-thumb {
  background-color: var(--td-scrollbar-color);
  border-radius: 3px;
}

.status-display::-webkit-scrollbar-track {
  background: transparent;
}

.status-text {
  font-size: 15px;
  color: var(--td-text-color-secondary);
}

.status-text.error {
  color: var(--td-error-color);
}

.status-text.success {
  color: var(--td-success-color);
}

/* Result List Styles */
.result-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: slideUp 0.5s ease-out;
}

.result-item {
  display: flex;
  align-items: center;
  background: var(--td-bg-color-secondary);
  padding: 12px;
  border-radius: 12px;
  gap: 16px;
  transition: all 0.2s ease;
}

.result-item:hover {
  background: var(--td-bg-color-component-hover);
  transform: translateY(-2px);
}

.result-cover-wrapper {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.result-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.result-content {
  flex: 1;
  text-align: left;
  min-width: 0; /* Prevent text overflow issues */
}

.result-content h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--td-text-color-primary);
  margin: 0 0 4px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-content p {
  font-size: 14px;
  color: var(--td-text-color-secondary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--td-brand-color);
  background: var(--td-brand-color-light);
  display: inline-block;
  padding: 2px 6px;
  border-radius: 4px;
}

.result-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  margin-top: auto; /* Push to bottom if space permits */
  padding-bottom: 20px;
}

.main-btn {
  width: 72px;
  height: 72px;
  font-size: 36px;
  transition: transform 0.2s;
}

.main-btn:active {
  transform: scale(0.95);
}

.sub-actions {
  display: flex;
  gap: 16px;
}

.result-footer {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}
</style>
