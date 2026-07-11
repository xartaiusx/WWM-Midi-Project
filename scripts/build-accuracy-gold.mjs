import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeMidi } from 'midi-file'
import { resolveAlbumDir } from './lib/midi-accuracy.mjs'

const albumArg = process.argv.find(value => value.startsWith('--album-dir='))?.slice(12)
const albumDir = await resolveAlbumDir(albumArg)
const ledgerPath = path.join(albumDir, '.source-ledger.local.json')
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
const entries = ledger.entries || []
if (!entries.length) throw new Error(`No local provenance entries found at ${ledgerPath}`)

const targets = [
  ['reference-solo', 6, entry => /in the end|bee my honey|dragonsong/i.test(entry.filename)],
  ['flute-harp', 6, entry => /flute|harp|xiao|guqin|konghou/i.test(entry.filename)],
  ['variable-tempo', 8, entry => entry.tempoEventCount > 1],
  ['sparse-melody', 8, entry => entry.noteDensity > 0 && entry.noteDensity < 4],
  ['clean-chords', 8, entry => entry.maximumChordSize >= 2 && entry.maximumChordSize <= 3],
  ['fast-passages', 8, entry => entry.peakOnsetsPerSecond >= 9 && entry.peakOnsetsPerSecond <= 15],
  ['broad-range', 6, entry => entry.range && entry.range.max - entry.range.min >= 24],
]

const selected = syntheticGoldFixtures()
const selectedHashes = new Set(selected.map(entry => entry.sha256))
const artistCounts = new Map()
for (const [category, target, predicate] of targets) {
  const candidates = entries
    .filter(predicate)
    .sort((left, right) => right.compatibilityScore - left.compatibilityScore || left.filename.localeCompare(right.filename))
  let count = 0
  for (const entry of candidates) {
    if (count >= target || selected.length >= 50) break
    if (selectedHashes.has(entry.sha256)) continue
    const artistCount = artistCounts.get(entry.artist) || 0
    if (artistCount >= 2) continue
    selected.push(toGoldEntry(entry, category))
    selectedHashes.add(entry.sha256)
    artistCounts.set(entry.artist, artistCount + 1)
    count++
  }
}

for (const entry of [...entries].sort((left, right) => right.compatibilityScore - left.compatibilityScore || left.filename.localeCompare(right.filename))) {
  if (selected.length >= 50) break
  if (selectedHashes.has(entry.sha256)) continue
  const artistCount = artistCounts.get(entry.artist) || 0
  if (artistCount >= 2) continue
  selected.push(toGoldEntry(entry, 'compatibility-fill'))
  selectedHashes.add(entry.sha256)
  artistCounts.set(entry.artist, artistCount + 1)
}

if (selected.length !== 50) throw new Error(`Could only select ${selected.length} unique gold-corpus songs`)
const outputPath = path.join(albumDir, '.accuracy-gold.local.json')
const manifest = {
  version: 1,
  localOnly: true,
  generatedAt: new Date().toISOString(),
  profileId: 'wwm-konghou-36',
  entryCount: selected.length,
  entries: selected,
}
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
const categoryCounts = {}
for (const entry of selected) categoryCounts[entry.category] = (categoryCounts[entry.category] || 0) + 1
console.log(JSON.stringify({ albumDir, outputPath, entries: selected.length, categoryCounts }, null, 2))

function toGoldEntry(entry, category) {
  return {
    filename: entry.filename,
    sha256: entry.sha256,
    melodicFingerprint: entry.melodicFingerprint,
    category,
    compatibilityScore: entry.compatibilityScore,
    noteDensity: entry.noteDensity,
    peakOnsetsPerSecond: entry.peakOnsetsPerSecond,
    maximumChordSize: entry.maximumChordSize,
    tempoEventCount: entry.tempoEventCount,
  }
}

function syntheticGoldFixtures() {
  const definitions = [
    { name: 'Synthetic - Variable Tempo.smf', category: 'variable-tempo', tempos: [{ tick: 0, tempo: 500000 }, { tick: 960, tempo: 400000 }], notes: sequenceNotes([60, 62, 64, 65, 67, 69], 0, 240, 180) },
    { name: 'Synthetic - Sparse Flute Melody.smf', category: 'sparse-melody', tempos: [{ tick: 0, tempo: 600000 }], notes: sequenceNotes([72, 74, 76, 77, 79], 0, 960, 480) },
    { name: 'Synthetic - Three Voice Chords.smf', category: 'clean-chords', tempos: [{ tick: 0, tempo: 500000 }], notes: chordNotes([[60, 64, 67], [62, 65, 69], [64, 67, 71]], 0, 480, 360) },
    { name: 'Synthetic - Fast Chromatic Passage.smf', category: 'fast-passages', tempos: [{ tick: 0, tempo: 500000 }], notes: sequenceNotes(Array.from({ length: 24 }, (_, index) => 60 + index % 12), 0, 80, 60) },
    { name: 'Synthetic - Harp Arpeggio.smf', category: 'flute-harp', tempos: [{ tick: 0, tempo: 500000 }], notes: sequenceNotes([48, 55, 60, 64, 67, 72, 76, 79], 0, 120, 100) },
    { name: 'Synthetic - Full Konghou Range.smf', category: 'broad-range', tempos: [{ tick: 0, tempo: 500000 }], notes: sequenceNotes([48, 52, 55, 60, 64, 67, 72, 76, 79, 83], 0, 240, 180) },
  ]
  return definitions.map(definition => {
    const buffer = buildFixture(definition)
    return {
      filename: definition.name,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      melodicFingerprint: null,
      category: definition.category,
      compatibilityScore: 100,
      noteDensity: null,
      peakOnsetsPerSecond: null,
      maximumChordSize: definition.category === 'clean-chords' ? 3 : 1,
      tempoEventCount: definition.tempos.length,
      syntheticBase64: buffer.toString('base64'),
      sourceStatus: 'generated-test-fixture',
      rightsStatus: 'project-generated',
    }
  })
}

function sequenceNotes(pitches, start, step, duration) {
  return pitches.map((noteNumber, index) => ({ noteNumber, start: start + index * step, end: start + index * step + duration }))
}

function chordNotes(chords, start, step, duration) {
  return chords.flatMap((chord, index) => chord.map(noteNumber => ({ noteNumber, start: start + index * step, end: start + index * step + duration })))
}

function buildFixture(definition) {
  const tempoTrack = []
  let lastTempoTick = 0
  for (const tempo of definition.tempos) {
    tempoTrack.push({ deltaTime: tempo.tick - lastTempoTick, type: 'setTempo', microsecondsPerBeat: tempo.tempo })
    lastTempoTick = tempo.tick
  }
  tempoTrack.push({ deltaTime: 0, type: 'endOfTrack' })

  const events = []
  for (const note of definition.notes) {
    events.push({ tick: note.start, order: 1, event: { type: 'noteOn', channel: 0, noteNumber: note.noteNumber, velocity: 90 } })
    events.push({ tick: note.end, order: 0, event: { type: 'noteOff', channel: 0, noteNumber: note.noteNumber, velocity: 0 } })
  }
  events.sort((left, right) => left.tick - right.tick || left.order - right.order)
  let lastTick = 0
  const noteTrack = events.map(item => {
    const event = { ...item.event, deltaTime: item.tick - lastTick }
    lastTick = item.tick
    return event
  })
  noteTrack.push({ deltaTime: 0, type: 'endOfTrack' })
  return Buffer.from(writeMidi({ header: { format: 1, numTracks: 2, ticksPerBeat: 480 }, tracks: [tempoTrack, noteTrack] }))
}
