import assert from 'node:assert/strict'
import test from 'node:test'
import { selectMediaRecorderMimeType } from './recorderMime'

test('prefers WebM Opus when the runtime supports it', () => {
  const selected = selectMediaRecorderMimeType((type) => type === 'audio/webm;codecs=opus')
  assert.equal(selected, 'audio/webm;codecs=opus')
})

test('falls back to MP4 when WebM is unavailable', () => {
  const selected = selectMediaRecorderMimeType((type) => type.startsWith('audio/mp4'))
  assert.equal(selected, 'audio/mp4;codecs=mp4a.40.2')
})

test('returns undefined when no recorder MIME type is supported', () => {
  const selected = selectMediaRecorderMimeType(() => false)
  assert.equal(selected, undefined)
})
