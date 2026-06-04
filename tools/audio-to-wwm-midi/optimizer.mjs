import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parseMidi, writeMidi } from 'midi-file'

const NATURAL_PITCH_CLASSES = [0, 2, 4, 5, 7, 9, 11]

const PROFILES = {
  harp: {
    maxPolyphony: 2,
    minDurationTicks: 120,
    quantizeTicks: 120,
    arpeggiate: true,
    arpeggioStepTicks: 40,
    melodyBias: 'high',
    dropPercussion: true,
  },
  balanced: {
    maxPolyphony: 3,
    minDurationTicks: 90,
    quantizeTicks: 90,
    arpeggiate: false,
    arpeggioStepTicks: 0,
    melodyBias: 'velocity',
    dropPercussion: true,
  },
  debug_raw: {
    maxPolyphony: 8,
    minDurationTicks: 30,
    quantizeTicks: 0,
    arpeggiate: false,
    arpeggioStepTicks: 0,
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

export function optimizeMidiBuffer(inputBuffer, options = {}) {
  const parsed = parseMidi(Buffer.from(inputBuffer))
  const ticksPerBeat = parsed.header?.ticksPerBeat || 480
  const profileName = options.profile || 'harp'
  const profile = getProfile(profileName)
  const keyMode = options.keyMode || '36'
  const range = playableRangeForKeyMode(keyMode)
  const tempo = findInitialTempo(parsed) ?? 500000
  const rawNotes = extractNotes(parsed, { dropPercussion: profile.dropPercussion })

  const transformed = rawNotes
    .map((note) => normalizeNote(note, range, profile, ticksPerBeat))
    .filter(Boolean)

  const grouped = groupNotesByStart(transformed)
  const kept = []
  let removedByPolyphony = 0

  for (const group of grouped) {
    const ranked = rankNotes(group, profile.melodyBias)
    const selected = ranked.slice(0, profile.maxPolyphony)
    removedByPolyphony += Math.max(0, ranked.length - selected.length)

    selected
      .sort((a, b) => a.noteNumber - b.noteNumber)
      .forEach((note, index) => {
        if (profile.arpeggiate && index > 0) {
          const shift = index * profile.arpeggioStepTicks
          note.startTick += shift
          note.endTick += shift
        }
        kept.push(note)
      })
  }

  const finalNotes = kept
    .filter((note) => note.endTick > note.startTick)
    .sort((a, b) => a.startTick - b.startTick || a.noteNumber - b.noteNumber)

  const output = buildMidi({
    ticksPerBeat,
    tempo,
    notes: finalNotes,
    trackName: options.trackName || `${profileName} WWM arrangement`,
  })

  const outputBytes = Buffer.from(writeMidi(output))
  const rawRange = noteRange(rawNotes)
  const finalRange = noteRange(finalNotes)

  const report = {
    sourcePath: options.sourcePath || null,
    outputPath: options.outputPath || null,
    profile: profileName,
    keyMode: String(keyMode),
    ticksPerBeat,
    rawNoteCount: rawNotes.length,
    optimizedNoteCount: finalNotes.length,
    removedNoteCount: Math.max(0, rawNotes.length - finalNotes.length),
    removedByPolyphony,
    rawRange,
    optimizedRange: finalRange,
    durationTicks: finalNotes.reduce((max, note) => Math.max(max, note.endTick), 0),
    warnings: buildWarnings(rawNotes, finalNotes, range, profile),
  }

  return { midiBuffer: outputBytes, report }
}

function extractNotes(parsed, options = {}) {
  const notes = []
  const open = new Map()

  for (const [trackIndex, track] of parsed.tracks.entries()) {
    let tick = 0
    for (const event of track) {
      tick += event.deltaTime || 0
      if (event.type !== 'noteOn' && event.type !== 'noteOff') continue

      const channel = event.channel ?? 0
      if (options.dropPercussion && channel === 9) continue

      const key = `${trackIndex}:${channel}:${event.noteNumber}`
      const isNoteOff = event.type === 'noteOff' || event.velocity === 0

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
        notes.push({
          ...started,
          endTick: Math.max(tick, started.startTick + 1),
        })
      }
    }
  }

  return notes
}

function normalizeNote(note, range, profile, ticksPerBeat) {
  let startTick = quantize(note.startTick, profile.quantizeTicks)
  let endTick = quantize(note.endTick, profile.quantizeTicks)

  if (endTick <= startTick) {
    endTick = startTick + profile.minDurationTicks
  }

  const minDuration = profile.minDurationTicks || Math.max(30, Math.round(ticksPerBeat / 16))
  if (endTick - startTick < minDuration) {
    endTick = startTick + minDuration
  }

  let noteNumber = transposeIntoRange(note.noteNumber, range.min, range.max)
  if (range.naturalOnly) {
    noteNumber = snapToNatural(noteNumber, range.min, range.max)
  }

  return {
    ...note,
    noteNumber,
    velocity: clamp(Math.round(note.velocity || 64), 32, 112),
    startTick,
    endTick,
  }
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
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group)
}

function rankNotes(group, melodyBias) {
  return [...group].sort((a, b) => {
    if (melodyBias === 'high') {
      return b.noteNumber - a.noteNumber || b.velocity - a.velocity
    }
    return b.velocity - a.velocity || b.noteNumber - a.noteNumber
  })
}

function buildMidi({ ticksPerBeat, tempo, notes, trackName }) {
  const noteEvents = []
  for (const note of notes) {
    noteEvents.push({
      absoluteTick: note.startTick,
      order: 1,
      event: {
        deltaTime: 0,
        type: 'noteOn',
        channel: 0,
        noteNumber: note.noteNumber,
        velocity: note.velocity,
      },
    })
    noteEvents.push({
      absoluteTick: note.endTick,
      order: 0,
      event: {
        deltaTime: 0,
        type: 'noteOff',
        channel: 0,
        noteNumber: note.noteNumber,
        velocity: 0,
      },
    })
  }

  noteEvents.sort((a, b) => a.absoluteTick - b.absoluteTick || a.order - b.order)

  let lastTick = 0
  const track = [{ deltaTime: 0, type: 'trackName', text: trackName }]
  for (const item of noteEvents) {
    const deltaTime = Math.max(0, item.absoluteTick - lastTick)
    track.push({ ...item.event, deltaTime })
    lastTick = item.absoluteTick
  }
  track.push({ deltaTime: 0, type: 'endOfTrack' })

  return {
    header: {
      format: 1,
      numTracks: 2,
      ticksPerBeat,
    },
    tracks: [
      [
        { deltaTime: 0, type: 'trackName', text: 'WWM Audio Creator tempo' },
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: tempo },
        { deltaTime: 0, type: 'timeSignature', numerator: 4, denominator: 4, metronome: 24, thirtyseconds: 8 },
        { deltaTime: 0, type: 'endOfTrack' },
      ],
      track,
    ],
  }
}

function findInitialTempo(parsed) {
  for (const track of parsed.tracks) {
    for (const event of track) {
      if (event.type === 'setTempo' && event.microsecondsPerBeat) {
        return event.microsecondsPerBeat
      }
    }
  }
  return null
}

function noteRange(notes) {
  if (!notes.length) return null
  return {
    min: Math.min(...notes.map((note) => note.noteNumber)),
    max: Math.max(...notes.map((note) => note.noteNumber)),
  }
}

function buildWarnings(rawNotes, finalNotes, range, profile) {
  const warnings = []
  if (!rawNotes.length) warnings.push('No MIDI notes were found in the source.')
  if (rawNotes.length && finalNotes.length / rawNotes.length < 0.35) {
    warnings.push('Many notes were removed while simplifying for game playback.')
  }
  if (profile.maxPolyphony <= 2) {
    warnings.push('Harp profile keeps melody-first output and limits dense chords.')
  }
  if (range.naturalOnly) {
    warnings.push('21-key mode snaps accidentals to nearby natural notes.')
  }
  return warnings
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}
