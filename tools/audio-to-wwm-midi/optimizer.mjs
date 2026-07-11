import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseMidi, writeMidi } from 'midi-file'

const REFERENCE_PPQN = 480
const NATURAL_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11]

const PROFILES = {
  harp: {
    maxPolyphony: 2,
    minDurationReferenceTicks: 120,
    quantizeReferenceTicks: 120,
    arpeggiate: true,
    arpeggioReferenceTicks: 40,
    melodyBias: 'continuity',
    dropPercussion: true,
  },
  balanced: {
    maxPolyphony: 3,
    minDurationReferenceTicks: 90,
    quantizeReferenceTicks: 90,
    arpeggiate: false,
    arpeggioReferenceTicks: 0,
    melodyBias: 'continuity',
    dropPercussion: true,
  },
  debug_raw: {
    maxPolyphony: 8,
    minDurationReferenceTicks: 30,
    quantizeReferenceTicks: 0,
    arpeggiate: false,
    arpeggioReferenceTicks: 0,
    melodyBias: 'velocity',
    dropPercussion: false,
  },
}

export function sanitizeFileName(name) {
  return String(name || 'created-song')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96) || 'created-song'
}

export function playableRangeForKeyMode(keyMode = '36') {
  const mode = String(keyMode).toLowerCase()
  return mode === '21' || mode === 'keys21'
    ? { min: 48, max: 83, naturalOnly: true }
    : { min: 48, max: 83, naturalOnly: false }
}

export function getProfile(profile = 'harp') {
  return PROFILES[profile] ?? PROFILES.harp
}

export async function optimizeMidiFile(inputPath, outputPath, options = {}) {
  const inputBuffer = await readFile(inputPath)
  const { midiBuffer, report } = optimizeMidiBuffer(inputBuffer, {
    ...options,
    sourcePath: inputPath,
    outputPath,
  })

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, midiBuffer)
  return report
}

export function analyzeMidiBuffer(inputBuffer, options = {}) {
  return optimizeMidiBuffer(inputBuffer, { ...options, analysisOnly: true }).report
}

export function optimizeMidiBuffer(inputBuffer, options = {}) {
  const parsed = parseMidi(Buffer.from(inputBuffer))
  validateHeader(parsed)

  const ticksPerBeat = parsed.header.ticksPerBeat
  const profileName = options.profile || 'harp'
  const profile = scaleProfile(getProfile(profileName), ticksPerBeat)
  const keyMode = options.keyMode || '36'
  const range = playableRangeForKeyMode(keyMode)
  const tempoMap = extractTempoMap(parsed)
  const extracted = extractNotes(parsed, { dropPercussion: profile.dropPercussion })
  const recommendedTrack = scoreMelodyTracks(extracted.notes, ticksPerBeat)

  const normalized = extracted.notes
    .map(note => normalizeNoteTiming(note, profile))
    .filter(Boolean)

  const selected = selectVoices(normalized, {
    recommendedTrackId: recommendedTrack?.trackIndex ?? null,
    maxPolyphony: profile.maxPolyphony,
    melodyBias: profile.melodyBias,
  })
  const fittedSelected = deduplicateFittedNotes(
    selected.notes.map(note => fitNoteToRange(note, range)),
  )

  const kept = []
  for (const group of groupNotesByStart(fittedSelected)) {
    group
      .sort((a, b) => a.noteNumber - b.noteNumber)
      .forEach((note, index) => {
        const copy = { ...note }
        if (profile.arpeggiate && index > 0) {
          const shift = index * profile.arpeggioStepTicks
          copy.startTick += shift
          copy.endTick += shift
        }
        kept.push(copy)
      })
  }

  const finalNotes = kept
    .filter(note => note.endTick > note.startTick)
    .sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber)

  const output = buildMidi({
    ticksPerBeat,
    tempoMap,
    notes: finalNotes,
    trackName: options.trackName || `${profileName} WWM Konghou arrangement`,
  })

  const outputBytes = Buffer.from(writeMidi(output))
  const rawRange = noteRange(extracted.notes)
  const finalRange = noteRange(finalNotes)
  const durationTicks = finalNotes.reduce((max, note) => Math.max(max, note.endTick), 0)
  const maximumChordSize = Math.max(0, ...groupNotesByStart(normalized).map(group => group.length))
  const peakOnsetsPerBeat = peakOnsetDensity(normalized, ticksPerBeat)
  const removedNoteCount = Math.max(0, extracted.notes.length - finalNotes.length)

  const report = {
    sourcePath: options.sourcePath || null,
    outputPath: options.outputPath || null,
    profile: profileName,
    keyMode: String(keyMode),
    ticksPerBeat,
    tempoEventCount: tempoMap.length,
    tempoEventsPreserved: tempoMap.length,
    rawNoteCount: extracted.notes.length,
    optimizedNoteCount: finalNotes.length,
    removedNoteCount,
    removedByPolyphony: selected.removedByPolyphony,
    removedByTrackContext: selected.removedByTrackContext,
    percussionNoteCount: extracted.percussionNoteCount,
    recommendedMelodyTrack: recommendedTrack,
    rawRange,
    optimizedRange: finalRange,
    durationTicks,
    maximumChordSize,
    peakOnsetsPerBeat,
    compatibilityScore: compatibilityScore({
      noteCount: extracted.notes.length,
      removedNoteCount,
      percussionNoteCount: extracted.percussionNoteCount,
      maximumChordSize,
      maxPolyphony: profile.maxPolyphony,
      peakOnsetsPerBeat,
    }),
    warnings: buildWarnings(extracted.notes, finalNotes, range, profile, tempoMap),
  }

  return { midiBuffer: outputBytes, report }
}

function validateHeader(parsed) {
  if (![0, 1].includes(parsed.header?.format)) {
    throw new Error('SMF format 2 is not supported. Convert independent sequences to format 0 or 1.')
  }
  if (!Number.isFinite(parsed.header?.ticksPerBeat) || parsed.header.ticksPerBeat <= 0) {
    throw new Error('SMPTE-timed MIDI is not supported. Convert it to metrical PPQN timing.')
  }
}

function scaleProfile(profile, ticksPerBeat) {
  const scale = ticksPerBeat / REFERENCE_PPQN
  return {
    ...profile,
    minDurationTicks: Math.max(1, Math.round(profile.minDurationReferenceTicks * scale)),
    quantizeTicks: Math.max(0, Math.round(profile.quantizeReferenceTicks * scale)),
    arpeggioStepTicks: Math.max(0, Math.round(profile.arpeggioReferenceTicks * scale)),
  }
}

function extractTempoMap(parsed) {
  const tempos = []
  for (const [trackIndex, track] of parsed.tracks.entries()) {
    let tick = 0
    for (const [eventIndex, event] of track.entries()) {
      tick += event.deltaTime || 0
      if (event.type === 'setTempo' && event.microsecondsPerBeat) {
        tempos.push({
          tick,
          microsecondsPerBeat: event.microsecondsPerBeat,
          trackIndex,
          eventIndex,
        })
      }
    }
  }

  tempos.sort((a, b) => a.tick - b.tick || a.trackIndex - b.trackIndex || a.eventIndex - b.eventIndex)
  if (!tempos.some(tempo => tempo.tick === 0)) {
    tempos.unshift({ tick: 0, microsecondsPerBeat: 500000, trackIndex: -1, eventIndex: -1 })
  }

  const byTick = new Map()
  for (const tempo of tempos) byTick.set(tempo.tick, tempo)
  return [...byTick.values()].sort((a, b) => a.tick - b.tick)
}

function extractNotes(parsed, options = {}) {
  const notes = []
  const open = new Map()
  let percussionNoteCount = 0

  for (const [trackIndex, track] of parsed.tracks.entries()) {
    let tick = 0
    for (const event of track) {
      tick += event.deltaTime || 0
      if (event.type !== 'noteOn' && event.type !== 'noteOff') continue

      const channel = event.channel ?? 0
      const isNoteOff = event.type === 'noteOff' || event.velocity === 0
      if (channel === 9 && !isNoteOff) percussionNoteCount++
      if (options.dropPercussion && channel === 9) continue

      const key = `${trackIndex}:${channel}:${event.noteNumber}`
      if (!isNoteOff) {
        const stack = open.get(key) ?? []
        stack.push({
          trackIndex,
          channel,
          noteNumber: event.noteNumber,
          velocity: event.velocity || 64,
          startTick: tick,
        })
        open.set(key, stack)
      } else {
        const stack = open.get(key)
        const started = stack?.shift()
        if (!started) continue
        if (stack.length === 0) open.delete(key)
        notes.push({ ...started, endTick: Math.max(tick, started.startTick + 1) })
      }
    }

    for (const [key, stack] of [...open.entries()]) {
      if (!key.startsWith(`${trackIndex}:`)) continue
      for (const started of stack) {
        notes.push({ ...started, endTick: Math.max(tick, started.startTick + 1) })
      }
      open.delete(key)
    }
  }

  return { notes, percussionNoteCount }
}

function scoreMelodyTracks(notes, ticksPerBeat) {
  const tracks = new Map()
  for (const note of notes) {
    const list = tracks.get(note.trackIndex) ?? []
    list.push(note)
    tracks.set(note.trackIndex, list)
  }

  const scored = [...tracks.entries()].map(([trackIndex, trackNotes]) => {
    trackNotes.sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber)
    const uniqueOnsets = new Set(trackNotes.map(note => note.startTick)).size
    const monophony = uniqueOnsets / Math.max(1, trackNotes.length)
    const averagePitch = average(trackNotes.map(note => note.noteNumber))
    const intervals = trackNotes.slice(1).map((note, index) => Math.abs(note.noteNumber - trackNotes[index].noteNumber))
    const continuity = 1 / (1 + average(intervals) / 12)
    const durationBeats = Math.max(1, Math.max(...trackNotes.map(note => note.endTick)) / ticksPerBeat)
    const density = trackNotes.length / durationBeats
    const densityScore = density <= 12 ? 1 : Math.max(0, 12 / density)
    const pitchScore = clamp((averagePitch - 36) / 60, 0, 1)
    const score = monophony * 40 + continuity * 25 + pitchScore * 15 + densityScore * 10 + clamp(trackNotes.length / 500, 0, 1) * 10
    return { trackIndex, score: round(score, 3), noteCount: trackNotes.length }
  })

  return scored.sort((a, b) => b.score - a.score || a.trackIndex - b.trackIndex)[0] ?? null
}

function normalizeNoteTiming(note, profile) {
  let startTick = quantize(note.startTick, profile.quantizeTicks)
  let endTick = quantize(note.endTick, profile.quantizeTicks)
  if (endTick <= startTick || endTick - startTick < profile.minDurationTicks) {
    endTick = startTick + profile.minDurationTicks
  }

  return {
    ...note,
    velocity: clamp(Math.round(note.velocity || 64), 32, 112),
    startTick,
    endTick,
  }
}

function fitNoteToRange(note, range) {
  let noteNumber = transposeIntoRange(note.noteNumber, range.min, range.max)
  if (range.naturalOnly) noteNumber = snapToNatural(noteNumber, range.min, range.max)
  return { ...note, noteNumber }
}

function deduplicateFittedNotes(notes) {
  const unique = new Map()
  for (const note of notes) {
    const key = `${note.startTick}:${note.noteNumber}`
    const current = unique.get(key)
    if (!current || note.velocity > current.velocity) {
      unique.set(key, { ...note, endTick: Math.max(note.endTick, current?.endTick || 0) })
    } else if (note.endTick > current.endTick) {
      current.endTick = note.endTick
    }
  }
  return [...unique.values()]
}

function selectVoices(notes, options) {
  const trackCount = new Set(notes.map(note => note.trackIndex)).size
  const selected = []
  let previousMelody = null
  let removedByPolyphony = 0
  let removedByTrackContext = 0

  for (const group of groupNotesByStart(notes)) {
    const hasRecommended = group.some(note => note.trackIndex === options.recommendedTrackId)
    if (trackCount > 1 && options.recommendedTrackId !== null && !hasRecommended) {
      removedByTrackContext += group.length
      continue
    }

    const unique = [...new Map(group.map(note => [note.noteNumber, note])).values()]
    const preferred = unique.filter(note => note.trackIndex === options.recommendedTrackId)
    const melodyPool = preferred.length ? preferred : unique
    const melody = chooseMelody(melodyPool, previousMelody, options.melodyBias)
    if (melody) previousMelody = melody.noteNumber

    const chosen = melody ? [melody] : []
    if (chosen.length < options.maxPolyphony) {
      const bass = unique
        .filter(note => !chosen.some(item => item.noteNumber === note.noteNumber))
        .sort((a, b) => a.noteNumber - b.noteNumber)[0]
      if (bass) chosen.push(bass)
    }
    while (chosen.length < options.maxPolyphony) {
      const melodyPitch = chosen[0]?.noteNumber ?? 60
      const inner = unique
        .filter(note => !chosen.some(item => item.noteNumber === note.noteNumber))
        .sort((a, b) => Math.abs(a.noteNumber - melodyPitch) - Math.abs(b.noteNumber - melodyPitch) || b.velocity - a.velocity)[0]
      if (!inner) break
      chosen.push(inner)
    }

    removedByPolyphony += Math.max(0, unique.length - chosen.length)
    selected.push(...chosen)
  }

  return { notes: selected, removedByPolyphony, removedByTrackContext }
}

function chooseMelody(notes, previousPitch, bias) {
  return [...notes].sort((a, b) => {
    if (bias === 'velocity' || previousPitch === null) {
      return b.velocity - a.velocity || b.noteNumber - a.noteNumber
    }
    return Math.abs(a.noteNumber - previousPitch) - Math.abs(b.noteNumber - previousPitch)
      || b.velocity - a.velocity
      || b.noteNumber - a.noteNumber
  })[0] ?? null
}

function quantize(value, grid) {
  if (!grid || grid <= 0) return Math.round(value)
  return Math.round(value / grid) * grid
}

function transposeIntoRange(noteNumber, min, max) {
  let note = noteNumber
  while (note < min) note += 12
  while (note > max) note -= 12
  return clamp(note, min, max)
}

function snapToNatural(noteNumber, min, max) {
  if (NATURAL_PITCH_CLASSES.includes(noteNumber % 12)) return noteNumber
  for (let distance = 1; distance <= 6; distance++) {
    const down = noteNumber - distance
    const up = noteNumber + distance
    if (down >= min && NATURAL_PITCH_CLASSES.includes(down % 12)) return down
    if (up <= max && NATURAL_PITCH_CLASSES.includes(up % 12)) return up
  }
  return clamp(noteNumber, min, max)
}

function groupNotesByStart(notes) {
  const groups = new Map()
  for (const note of notes) {
    const group = groups.get(note.startTick) ?? []
    group.push(note)
    groups.set(note.startTick, group)
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group)
}

function buildMidi({ ticksPerBeat, tempoMap, notes, trackName }) {
  const noteEvents = []
  for (const note of notes) {
    noteEvents.push({
      absoluteTick: note.startTick,
      order: 1,
      event: { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: note.velocity },
    })
    noteEvents.push({
      absoluteTick: note.endTick,
      order: 0,
      event: { deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 },
    })
  }
  noteEvents.sort((a, b) => a.absoluteTick - b.absoluteTick || a.order - b.order)

  let lastTick = 0
  const noteTrack = [{ deltaTime: 0, type: 'trackName', text: trackName }]
  for (const item of noteEvents) {
    noteTrack.push({ ...item.event, deltaTime: Math.max(0, item.absoluteTick - lastTick) })
    lastTick = item.absoluteTick
  }
  noteTrack.push({ deltaTime: 0, type: 'endOfTrack' })

  let tempoTick = 0
  const tempoTrack = [{ deltaTime: 0, type: 'trackName', text: 'WWM canonical tempo map' }]
  for (const tempo of tempoMap) {
    tempoTrack.push({
      deltaTime: Math.max(0, tempo.tick - tempoTick),
      type: 'setTempo',
      microsecondsPerBeat: tempo.microsecondsPerBeat,
    })
    tempoTick = tempo.tick
  }
  tempoTrack.push({ deltaTime: 0, type: 'endOfTrack' })

  return {
    header: { format: 1, numTracks: 2, ticksPerBeat },
    tracks: [tempoTrack, noteTrack],
  }
}

function noteRange(notes) {
  if (!notes.length) return null
  return {
    min: Math.min(...notes.map(note => note.noteNumber)),
    max: Math.max(...notes.map(note => note.noteNumber)),
  }
}

function peakOnsetDensity(notes, ticksPerBeat) {
  const times = notes.map(note => note.startTick).sort((a, b) => a - b)
  let left = 0
  let peak = 0
  for (let right = 0; right < times.length; right++) {
    while (left < right && times[right] - times[left] >= ticksPerBeat) left++
    peak = Math.max(peak, right - left + 1)
  }
  return peak
}

function compatibilityScore(metrics) {
  const count = Math.max(1, metrics.noteCount)
  const removalPenalty = Math.min(40, metrics.removedNoteCount / count * 40)
  const percussionPenalty = Math.min(15, metrics.percussionNoteCount / count * 15)
  const chordPenalty = Math.min(15, Math.max(0, metrics.maximumChordSize - metrics.maxPolyphony) * 3)
  const densityPenalty = Math.min(20, Math.max(0, metrics.peakOnsetsPerBeat - 12))
  return Math.round(clamp(100 - removalPenalty - percussionPenalty - chordPenalty - densityPenalty, 0, 100))
}

function buildWarnings(rawNotes, finalNotes, range, profile, tempoMap) {
  const warnings = []
  if (!rawNotes.length) warnings.push('No MIDI notes were found in the source.')
  if (rawNotes.length && finalNotes.length / rawNotes.length < 0.35) {
    warnings.push('Many notes were removed by deterministic melody and harmony selection.')
  }
  if (profile.maxPolyphony <= 2) {
    warnings.push('Harp profile preserves melody first and limits dense chords.')
  }
  if (range.naturalOnly) {
    warnings.push('21-key mode snaps accidentals to nearby natural notes.')
  }
  if (tempoMap.length > 1) {
    warnings.push(`All ${tempoMap.length} tempo events were preserved.`)
  }
  return warnings
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function round(value, precision) {
  const scale = 10 ** precision
  return Math.round(value * scale) / scale
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
