import { describe, expect, it } from 'vitest'
import { parseMidi, writeMidi } from 'midi-file'
import { optimizeMidiBuffer, playableRangeForKeyMode, sanitizeFileName } from '../../tools/audio-to-wwm-midi/optimizer.mjs'

describe('audio-to-WWM MIDI optimizer', () => {
  it('keeps generated notes inside the 36-key playable range', () => {
    const input = makeMidi([
      { noteNumber: 24, start: 0, end: 240, velocity: 80 },
      { noteNumber: 96, start: 0, end: 240, velocity: 90 },
      { noteNumber: 60, start: 480, end: 720, velocity: 70 },
    ])

    const { midiBuffer, report } = optimizeMidiBuffer(input, {
      profile: 'balanced',
      keyMode: '36',
    })

    const notes = extractNoteOns(midiBuffer)
    const range = playableRangeForKeyMode('36')

    expect(report.optimizedNoteCount).toBeGreaterThan(0)
    expect(notes.every((note) => note >= range.min && note <= range.max)).toBe(true)
  })

  it('snaps accidentals to natural notes in 21-key mode', () => {
    const input = makeMidi([
      { noteNumber: 61, start: 0, end: 240, velocity: 90 },
      { noteNumber: 63, start: 240, end: 480, velocity: 90 },
      { noteNumber: 66, start: 480, end: 720, velocity: 90 },
    ])

    const { midiBuffer, report } = optimizeMidiBuffer(input, {
      profile: 'balanced',
      keyMode: '21',
    })

    const naturalPitchClasses = new Set([0, 2, 4, 5, 7, 9, 11])
    const notes = extractNoteOns(midiBuffer)

    expect(report.warnings).toContain('21-key mode snaps accidentals to nearby natural notes.')
    expect(notes.every((note) => naturalPitchClasses.has(note % 12))).toBe(true)
  })

  it('limits same-time polyphony for harp profile', () => {
    const input = makeMidi([
      { noteNumber: 60, start: 0, end: 480, velocity: 80 },
      { noteNumber: 64, start: 0, end: 480, velocity: 80 },
      { noteNumber: 67, start: 0, end: 480, velocity: 80 },
      { noteNumber: 72, start: 0, end: 480, velocity: 80 },
    ])

    const { report } = optimizeMidiBuffer(input, {
      profile: 'harp',
      keyMode: '36',
    })

    expect(report.optimizedNoteCount).toBe(2)
    expect(report.removedByPolyphony).toBe(2)
  })

  it('sanitizes generated file names for Windows paths', () => {
    expect(sanitizeFileName('A:B* C?')).toBe('A_B_ C_')
  })

  it('preserves every tempo event in order', () => {
    const input = makeMidiWithTempoChanges()
    const { midiBuffer, report } = optimizeMidiBuffer(input, { profile: 'balanced', keyMode: '36' })
    const parsed = parseMidi(midiBuffer)
    const tempos = parsed.tracks.flat().filter(event => event.type === 'setTempo')
    expect(report.tempoEventsPreserved).toBe(2)
    expect(tempos.map(event => event.microsecondsPerBeat)).toEqual([500000, 400000])
  })

  it('scales optimizer grids with PPQN', () => {
    const low = optimizeMidiBuffer(makeMidi([
      { noteNumber: 60, start: 113, end: 337, velocity: 90 },
    ], 480), { profile: 'balanced', keyMode: '36' })
    const high = optimizeMidiBuffer(makeMidi([
      { noteNumber: 60, start: 226, end: 674, velocity: 90 },
    ], 960), { profile: 'balanced', keyMode: '36' })
    const lowTick = firstNoteOnTick(low.midiBuffer) / 480
    const highTick = firstNoteOnTick(high.midiBuffer) / 960
    expect(highTick).toBe(lowTick)
  })

  it('excludes General MIDI percussion before ranking', () => {
    const input = makeMidi([
      { noteNumber: 60, start: 0, end: 240, velocity: 90, channel: 0 },
      { noteNumber: 38, start: 0, end: 240, velocity: 100, channel: 9 },
    ])
    const { report, midiBuffer } = optimizeMidiBuffer(input, { profile: 'balanced', keyMode: '36' })
    expect(report.percussionNoteCount).toBe(1)
    expect(extractNoteOns(midiBuffer)).toEqual([60])
  })

  it('measures density with a sliding beat window', () => {
    const input = makeMidi([
      { noteNumber: 60, start: 400, end: 700, velocity: 90 },
      { noteNumber: 62, start: 450, end: 750, velocity: 90 },
      { noteNumber: 64, start: 500, end: 800, velocity: 90 },
      { noteNumber: 65, start: 550, end: 850, velocity: 90 },
    ])
    const { report } = optimizeMidiBuffer(input, { profile: 'balanced', keyMode: '36' })
    expect(report.peakOnsetsPerBeat).toBe(4)
  })

  it('deduplicates notes that octave-fit to the same Konghou key', () => {
    const input = makeMidi([
      { noteNumber: 24, start: 0, end: 240, velocity: 80 },
      { noteNumber: 48, start: 0, end: 240, velocity: 90 },
    ])
    const { report, midiBuffer } = optimizeMidiBuffer(input, { profile: 'balanced', keyMode: '36' })
    expect(report.rawNoteCount).toBe(2)
    expect(report.optimizedNoteCount).toBe(1)
    expect(extractNoteOns(midiBuffer)).toEqual([48])
  })
})

function makeMidi(notes, ticksPerBeat = 480) {
  const events = []
  for (const note of notes) {
    events.push({
      absoluteTick: note.start,
      order: 1,
      event: { deltaTime: 0, type: 'noteOn', channel: note.channel ?? 0, noteNumber: note.noteNumber, velocity: note.velocity },
    })
    events.push({
      absoluteTick: note.end,
      order: 0,
      event: { deltaTime: 0, type: 'noteOff', channel: note.channel ?? 0, noteNumber: note.noteNumber, velocity: 0 },
    })
  }

  events.sort((a, b) => a.absoluteTick - b.absoluteTick || a.order - b.order)

  let lastTick = 0
  const track = [
    { deltaTime: 0, type: 'trackName', text: 'test' },
    { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
  ]

  for (const item of events) {
    const deltaTime = item.absoluteTick - lastTick
    track.push({ ...item.event, deltaTime })
    lastTick = item.absoluteTick
  }
  track.push({ deltaTime: 0, type: 'endOfTrack' })

  return Buffer.from(writeMidi({
    header: { format: 1, numTracks: 1, ticksPerBeat },
    tracks: [track],
  }))
}

function makeMidiWithTempoChanges() {
  return Buffer.from(writeMidi({
    header: { format: 1, numTracks: 2, ticksPerBeat: 480 },
    tracks: [
      [
        { deltaTime: 0, type: 'setTempo', microsecondsPerBeat: 500000 },
        { deltaTime: 960, type: 'setTempo', microsecondsPerBeat: 400000 },
        { deltaTime: 0, type: 'endOfTrack' },
      ],
      [
        { deltaTime: 0, type: 'noteOn', channel: 0, noteNumber: 60, velocity: 90 },
        { deltaTime: 1440, type: 'noteOff', channel: 0, noteNumber: 60, velocity: 0 },
        { deltaTime: 0, type: 'endOfTrack' },
      ],
    ],
  }))
}

function firstNoteOnTick(buffer) {
  const parsed = parseMidi(Buffer.from(buffer))
  for (const track of parsed.tracks) {
    let tick = 0
    for (const event of track) {
      tick += event.deltaTime || 0
      if (event.type === 'noteOn' && event.velocity > 0) return tick
    }
  }
  return -1
}

function extractNoteOns(buffer) {
  const parsed = parseMidi(Buffer.from(buffer))
  const notes = []
  for (const track of parsed.tracks) {
    for (const event of track) {
      if (event.type === 'noteOn' && event.velocity > 0) {
        notes.push(event.noteNumber)
      }
    }
  }
  return notes
}
