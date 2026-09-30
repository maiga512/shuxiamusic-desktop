let shazamInit: Promise<void> | null = null

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

/** Convert signed 16-bit mono PCM to a small WAV container for shazamio-core. */
function pcmToWav(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const dataSize = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}

/** Generate the Android-compatible Shazam binary signature. */
export async function generateShazamSignature(samples: Float32Array) {
  if (!samples.length) return null
  if (!shazamInit) {
    shazamInit = import('shazamio-core/web').then(({ default: init }) =>
      init().then(() => undefined)
    )
  }
  await shazamInit
  const { recognizeBytes } = await import('shazamio-core/web')
  const signatures = recognizeBytes(
    pcmToWav(samples, 16000),
    0,
    Math.min(12, samples.length / 16000)
  )
  const signature = signatures[0]
  if (!signature) return null
  try {
    return { uri: signature.uri, sampleMs: signature.samplems }
  } finally {
    signature.free()
    for (const item of signatures.slice(1)) item.free()
  }
}

export { pcmToWav }
