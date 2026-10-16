const RECORDER_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus'
] as const

export type MimeTypeSupport = (mimeType: string) => boolean

export function selectMediaRecorderMimeType(isSupported: MimeTypeSupport): string | undefined {
  return RECORDER_MIME_TYPES.find((mimeType) => {
    try {
      return isSupported(mimeType)
    } catch {
      return false
    }
  })
}
