import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseMidi } from 'midi-file'
import { inspectMidiFiles, listMidiFiles, resolveAlbumDir } from './lib/midi-accuracy.mjs'

const args = parseArgs(process.argv.slice(2))
const albumDir = await resolveAlbumDir(args.albumDir)
const files = await listMidiFiles(albumDir)
const failures = []
const warnings = []
const integrity = await readJson(path.join(albumDir, '.album-integrity.local.json'), failures, 'integrity baseline')
const ledger = await readJson(path.join(albumDir, '.source-ledger.local.json'), failures, 'source ledger')
const gold = await readJson(path.join(albumDir, '.accuracy-gold.local.json'), failures, '50-song gold corpus')
const inspected = await inspectMidiFiles(files, args.concurrency)

const targetCount = integrity?.targetCount ?? 3000
if (files.length !== targetCount) failures.push(`Album contains ${files.length} .mid files; expected ${targetCount}.`)
const hashSet = new Set(inspected.map(entry => entry.sha256))
if (hashSet.size !== inspected.length) failures.push('Album contains duplicate SHA256 hashes.')

if (integrity) {
  const expected = new Map(integrity.files.map(entry => [entry.filename, entry.sha256]))
  for (const entry of inspected) {
    if (expected.get(entry.filename) !== entry.sha256) failures.push(`Integrity mismatch: ${entry.filename}`)
  }
}

if (ledger) {
  const ledgerByHash = new Map(ledger.entries.map(entry => [entry.sha256, entry]))
  for (const entry of inspected) {
    const source = ledgerByHash.get(entry.sha256)
    if (!source) failures.push(`Missing provenance entry: ${entry.filename}`)
    else if (!source.sourceNote && !source.sourceUrl) failures.push(`Missing source evidence: ${entry.filename}`)
  }
}

if (gold) {
  if (gold.entries?.length !== 50) failures.push(`Gold corpus has ${gold.entries?.length || 0} entries; expected 50.`)
  const albumHashes = new Set(inspected.map(entry => entry.sha256))
  for (const entry of gold.entries || []) {
    if (entry.syntheticBase64) {
      try {
        const bytes = Buffer.from(entry.syntheticBase64, 'base64')
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('hash mismatch')
        const parsed = parseMidi(bytes)
        if (![0, 1].includes(parsed.header?.format) || !parsed.header?.ticksPerBeat) throw new Error('unsupported MIDI header')
      } catch (error) {
        failures.push(`Synthetic gold fixture is invalid: ${entry.filename} (${error.message})`)
      }
    } else if (!albumHashes.has(entry.sha256)) {
      failures.push(`Gold corpus file is missing or changed: ${entry.filename}`)
    }
  }
}

const calibrationFiles = [
  '.konghou-calibration-pitch-sweep.local.json',
  '.konghou-calibration-timing-stress.local.json',
  '.konghou-calibration-drift.local.json',
]
const calibration = []
for (const filename of calibrationFiles) {
  try {
    const report = JSON.parse(await readFile(path.join(albumDir, filename), 'utf8'))
    calibration.push({ filename, passed: report.passed })
    if (!report.passed) failures.push(`Calibration stage did not pass: ${filename}`)
  } catch {
    const message = `Calibration stage has not been run: ${filename}`
    if (args.requireCalibration) failures.push(message)
    else warnings.push(message)
  }
}

const result = {
  ok: failures.length === 0,
  albumDir,
  profileId: 'wwm-konghou-36',
  midiFiles: files.length,
  uniqueHashes: hashSet.size,
  ledgerEntries: ledger?.entries?.length || 0,
  goldEntries: gold?.entries?.length || 0,
  calibration,
  failures,
  warnings,
}
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

async function readJson(filePath, failures, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    failures.push(`Missing or invalid ${label}: ${filePath} (${error.message})`)
    return null
  }
}

function parseArgs(argv) {
  const parsed = { concurrency: 8, requireCalibration: false }
  for (const value of argv) {
    if (value.startsWith('--album-dir=')) parsed.albumDir = value.slice(12)
    if (value.startsWith('--concurrency=')) parsed.concurrency = Math.max(1, Number(value.slice(14)) || 8)
    if (value === '--require-calibration') parsed.requireCalibration = true
  }
  return parsed
}
