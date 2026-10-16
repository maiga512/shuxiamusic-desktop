export const WELCOME_WORKER_ACTIVE_CLASS = 'shuxia-welcome-worker-active'

export interface WelcomeStarfieldHandle {
  resize: (width: number, height: number, dpr: number) => void
  startFade: (durationMs: number) => void
  destroy: () => void
}

export function mountWelcomeStarfield(canvas: HTMLCanvasElement) {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof canvas.transferControlToOffscreen !== 'function'
  ) {
    return null
  }

  let worker: Worker
  try {
    worker = new Worker(new URL('../../workers/welcomeStarfield.worker.ts', import.meta.url), {
      type: 'module'
    })
  } catch {
    return null
  }

  try {
    const offscreen = canvas.transferControlToOffscreen()
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    worker.postMessage(
      {
        type: 'init',
        canvas: offscreen,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr
      },
      [offscreen]
    )
  } catch {
    worker.terminate()
    return null
  }

  document.documentElement.classList.add(WELCOME_WORKER_ACTIVE_CLASS)
  return {
    resize(width, height, nextDpr) {
      worker.postMessage({ type: 'resize', width, height, dpr: nextDpr })
    },
    startFade(durationMs) {
      worker.postMessage({ type: 'start-fade', durationMs })
    },
    destroy() {
      document.documentElement.classList.remove(WELCOME_WORKER_ACTIVE_CLASS)
      worker.postMessage({ type: 'dispose' })
      worker.terminate()
    }
  } satisfies WelcomeStarfieldHandle
}
