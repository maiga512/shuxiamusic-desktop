import type { SongList } from '@renderer/types/audio'
import { parseInterval, strSim } from './audioHelpers'

export type CandidateIdentitySnapshot = {
  score: number
  trusted: boolean
  original: {
    source: string
    songmid: string
    hash: string
    name: string
    singer: string
    albumName: string
    interval: string
  }
  candidate: {
    source: string
    songmid: string
    hash: string
    name: string
    singer: string
    albumName: string
    interval: string
  }
}

const normalizeText = (...items: unknown[]) =>
  items
    .map((item) => String(item || '').toLowerCase())
    .join(' ')
    .replace(/[\s\-_/()（）【】\[\]《》<>·•・]+/g, ' ')
    .replace(/\b(live|remix|cover|dj|伴奏|翻唱|片段|铃声)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const splitArtists = (input: unknown) =>
  String(input || '')
    .toLowerCase()
    .split(/[、,，/&|｜;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)

const hasArtistOverlap = (candidate: SongList, original: SongList) => {
  const candidateArtists = splitArtists(candidate.singer || (candidate as any).artist)
  const originalArtists = splitArtists(original.singer || (original as any).artist)
  if (!candidateArtists.length || !originalArtists.length) return true
  return originalArtists.some((expected) =>
    candidateArtists.some(
      (actual) => actual === expected || actual.includes(expected) || expected.includes(actual)
    )
  )
}

const scoreCandidate = (candidate: SongList, original: SongList) => {
  const nameScore = strSim(
    normalizeText(candidate.name, (candidate as any).title),
    normalizeText(original.name, (original as any).title)
  )
  const singerScore = strSim(
    normalizeText(candidate.singer, (candidate as any).artist),
    normalizeText(original.singer, (original as any).artist)
  )
  const albumScore = original.albumName
    ? strSim(normalizeText(candidate.albumName), normalizeText(original.albumName))
    : 0
  let score = nameScore * 0.65 + singerScore * 0.35 + albumScore * 0.05

  const originalDuration = parseInterval(original.interval)
  const candidateDuration = parseInterval(candidate.interval)
  if (originalDuration > 0 && candidateDuration > 0) {
    const diff = Math.abs(originalDuration - candidateDuration)
    if (diff <= 5) score += 0.15
    else if (diff > Math.max(12, originalDuration * 0.15)) score -= 0.25
  }

  if (!hasArtistOverlap(candidate, original)) score -= 0.35
  return score
}

export const isSameSongCandidate = (candidate: SongList, original: SongList) => {
  const nameScore = strSim(
    normalizeText(candidate.name, (candidate as any).title),
    normalizeText(original.name, (original as any).title)
  )
  const singerScore = strSim(
    normalizeText(candidate.singer, (candidate as any).artist),
    normalizeText(original.singer, (original as any).artist)
  )
  if (nameScore < 0.86 || singerScore < 0.72 || !hasArtistOverlap(candidate, original)) return false
  return scoreCandidate(candidate, original) >= 0.78
}

const snapshotSong = (song: SongList): CandidateIdentitySnapshot['original'] => ({
  source: String((song as any).source || ''),
  songmid: String((song as any).songmid || ''),
  hash: String((song as any).hash || ''),
  name: String((song as any).name || ''),
  singer: String((song as any).singer || (song as any).artist || ''),
  albumName: String((song as any).albumName || ''),
  interval: String((song as any).interval || '')
})

export const getCandidateIdentitySnapshot = (
  candidate: SongList,
  original: SongList
): CandidateIdentitySnapshot | null => {
  if (!isSameSongCandidate(candidate, original)) return null
  return {
    score: Number(scoreCandidate(candidate, original).toFixed(3)),
    trusted: true,
    original: snapshotSong(original),
    candidate: snapshotSong(candidate)
  }
}
