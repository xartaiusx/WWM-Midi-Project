import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseMidi } from 'midi-file'

export async function resolveAlbumDir(explicitPath) {
  const candidates = [
    explicitPath,
    path.resolve('Album'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return path.resolve(candidate)
    } catch {
      // Try the next local-only album location.
    }
  }
  throw new Error(`Local album not found. Checked: ${candidates.join(', ')}`)
}

export async function listMidiFiles(albumDir) {
  return (await readdir(albumDir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && path.extname(entry.name) === '.mid')
    .map(entry => ({ name: entry.name, path: path.join(albumDir, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function inspectMidiFile(file) {
  const bytes = await readFile(file.path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const parsed = parseMidi(Buffer.from(bytes))
  if (![0, 1].includes(parsed.header?.format)) {
    throw new Error(`${file.name}: unsupported SMF format ${parsed.header?.format}`)
  }
  const ticksPerBeat = parsed.header?.ticksPerBeat
  if (!Number.isFinite(ticksPerBeat) || ticksPerBeat <= 0) {
    throw new Error(`${file.name}: SMPTE or invalid timing is not compatible`)
  }

  const tempoEvents = []
  const pitchedByTrack = new Map()
  let percussionNoteCount = 0
  let maximumTick = 0
  for (const [trackIndex, track] of parsed.tracks.entries()) {
    let tick = 0
    for (const event of track) {
      tick += event.deltaTime || 0
      maximumTick = Math.max(maximumTick, tick)
      if (event.type === 'setTempo' && event.microsecondsPerBeat) {
        tempoEvents.push({ tick, microsecondsPerBeat: event.microsecondsPerBeat })
      }
      if (event.type !== 'noteOn' || !event.velocity) continue
      if ((event.channel ?? 0) === 9) {
        percussionNoteCount++
        continue
      }
      const notes = pitchedByTrack.get(trackIndex) ?? []
      notes.push({ tick, note: event.noteNumber, velocity: event.velocity || 64 })
      pitchedByTrack.set(trackIndex, notes)
    }
  }

  const melodyTrack = selectMelodyTrack(pitchedByTrack, ticksPerBeat)
  const melody = pitchedByTrack.get(melodyTrack) ?? []
  const allNotes = [...pitchedByTrack.values()].flat().sort((a, b) => a.tick - b.tick || a.note - b.note)
  const onsetCounts = new Map()
  for (const note of allNotes) onsetCounts.set(note.tick, (onsetCounts.get(note.tick) || 0) + 1)
  const maximumChordSize = Math.max(0, ...onsetCounts.values())
  const durationSeconds = ticksToSeconds(maximumTick, ticksPerBeat, tempoEvents)
  const noteDensity = durationSeconds > 0 ? allNotes.length / durationSeconds : 0
  const peakOnsetsPerSecond = peakDensity(allNotes, ticksPerBeat, tempoEvents)
  const range = allNotes.length
    ? { min: Math.min(...allNotes.map(note => note.note)), max: Math.max(...allNotes.map(note => note.note)) }
    : null

  return {
    filename: file.name,
    sha256,
    bytes: bytes.length,
    smfFormat: parsed.header.format,
    ticksPerBeat,
    tempoEventCount: tempoEvents.length,
    noteCount: allNotes.length,
    percussionNoteCount,
    durationSeconds: round(durationSeconds, 3),
    noteDensity: round(noteDensity, 3),
    peakOnsetsPerSecond,
    maximumChordSize,
    range,
    melodyTrack,
    melodicFingerprint: fingerprintMelody(melody, ticksPerBeat),
    canonicalIdentity: canonicalIdentity(file.name),
    artist: splitArtistTitle(file.name).artist,
    title: splitArtistTitle(file.name).title,
    compatibilityScore: compatibilityScore({
      noteCount: allNotes.length,
      percussionNoteCount,
      maximumChordSize,
      peakOnsetsPerSecond,
      range,
    }),
  }
}

export async function inspectMidiFiles(files, concurrency = 8) {
  const results = new Array(files.length)
  let next = 0
  async function worker() {
    while (next < files.length) {
      const index = next++
      results[index] = await inspectMidiFile(files[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  return results
}

export function splitArtistTitle(filename) {
  const stem = filename.replace(/\.mid$/i, '')
  const separator = stem.indexOf(' - ')
  if (separator < 0) return { artist: 'Unknown Artist', title: stem.trim() }
  return {
    artist: stem.slice(0, separator).trim() || 'Unknown Artist',
    title: stem.slice(separator + 3).trim() || stem.trim(),
  }
}

export function canonicalIdentity(filename) {
  const { artist, title } = splitArtistTitle(filename)
  const stopWords = new Set([
    'midi', 'ost', 'theme', 'bard', 'performance', 'solo', 'piano', 'lofi', 'live',
    'remaster', 'remastered', 'arrangement', 'version', 'download', 'edit', 'octet',
  ])
  const tokens = `${artist} ${title}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ffxiv|final fantasy xiv|ff14/g, 'finalfantasy14')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(token => token && !stopWords.has(token))
    .sort()
  return tokens.join(' ')
}

function selectMelodyTrack(tracks, ticksPerBeat) {
  const scored = [...tracks.entries()].map(([trackIndex, notes]) => {
    notes.sort((a, b) => a.tick - b.tick || a.note - b.note)
    const monophony = new Set(notes.map(note => note.tick)).size / Math.max(1, notes.length)
    const averagePitch = average(notes.map(note => note.note))
    const intervals = notes.slice(1).map((note, index) => Math.abs(note.note - notes[index].note))
    const continuity = 1 / (1 + average(intervals) / 12)
    const durationBeats = Math.max(1, Math.max(0, ...notes.map(note => note.tick)) / ticksPerBeat)
    const density = notes.length / durationBeats
    const score = monophony * 45 + continuity * 30 + clamp((averagePitch - 36) / 60, 0, 1) * 15 + clamp(12 / Math.max(12, density), 0, 1) * 10
    return { trackIndex, score }
  })
  return scored.sort((a, b) => b.score - a.score || a.trackIndex - b.trackIndex)[0]?.trackIndex ?? 0
}

function fingerprintMelody(notes, ticksPerBeat) {
  if (!notes.length) return null
  const ordered = [...notes].sort((a, b) => a.tick - b.tick || a.note - b.note).slice(0, 384)
  const signature = ordered.slice(1).map((note, index) => {
    const previous = ordered[index]
    return [
      clamp(note.note - previous.note, -24, 24),
      Math.round((note.tick - previous.tick) / ticksPerBeat * 96),
    ]
  })
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex')
}

function ticksToSeconds(maximumTick, ticksPerBeat, tempoEvents) {
  const tempos = [...tempoEvents].sort((a, b) => a.tick - b.tick)
  if (!tempos.some(tempo => tempo.tick === 0)) {
    tempos.unshift({ tick: 0, microsecondsPerBeat: 500000 })
  }
  let currentTick = 0
  let currentTempo = 500000
  let microseconds = 0
  for (const tempo of tempos) {
    if (tempo.tick > maximumTick) break
    microseconds += (tempo.tick - currentTick) / ticksPerBeat * currentTempo
    currentTick = tempo.tick
    currentTempo = tempo.microsecondsPerBeat
  }
  microseconds += (maximumTick - currentTick) / ticksPerBeat * currentTempo
  return microseconds / 1_000_000
}

function peakDensity(notes, ticksPerBeat, tempoEvents) {
  const tempos = [...tempoEvents].sort((a, b) => a.tick - b.tick)
  const buckets = new Map()
  for (const note of notes) {
    const second = Math.floor(ticksToSeconds(note.tick, ticksPerBeat, tempos))
    buckets.set(second, (buckets.get(second) || 0) + 1)
  }
  return Math.max(0, ...buckets.values())
}

function compatibilityScore(metrics) {
  const count = Math.max(1, metrics.noteCount)
  const percussionPenalty = Math.min(15, metrics.percussionNoteCount / count * 15)
  const chordPenalty = Math.min(20, Math.max(0, metrics.maximumChordSize - 3) * 3)
  const densityPenalty = Math.min(25, Math.max(0, metrics.peakOnsetsPerSecond - 12) * 1.5)
  const rangePenalty = metrics.range && (metrics.range.min < 48 || metrics.range.max > 83) ? 5 : 0
  return Math.round(clamp(100 - percussionPenalty - chordPenalty - densityPenalty - rangePenalty, 0, 100))
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round(value, precision) {
  const scale = 10 ** precision
  return Math.round(value * scale) / scale
}
