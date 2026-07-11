import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inspectMidiFiles, listMidiFiles, resolveAlbumDir } from './lib/midi-accuracy.mjs'

const args = parseArgs(process.argv.slice(2))
const albumDir = await resolveAlbumDir(args.albumDir)
const files = await listMidiFiles(albumDir)
const ledgerPath = path.join(albumDir, '.source-ledger.local.json')
const integrityPath = path.join(albumDir, '.album-integrity.local.json')
let existing = { entries: [] }
try {
  existing = JSON.parse(await readFile(ledgerPath, 'utf8'))
} catch {
  // First local reconstruction.
}
const existingByHash = new Map((existing.entries || []).map(entry => [entry.sha256, entry]))
const inspected = await inspectMidiFiles(files, args.concurrency)

const hashes = new Set()
for (const entry of inspected) {
  if (hashes.has(entry.sha256)) throw new Error(`Exact duplicate SHA256: ${entry.filename}`)
  hashes.add(entry.sha256)
}

const entries = inspected.map(entry => {
  const prior = existingByHash.get(entry.sha256) || {}
  return {
    ...entry,
    sourceStatus: prior.sourceStatus || 'legacy-local',
    sourceUrl: prior.sourceUrl || null,
    sourceNote: prior.sourceNote || 'Legacy local MIDI retained without a reconstructable source record.',
    arrangerOrUploader: prior.arrangerOrUploader || null,
    rightsStatus: prior.rightsStatus || 'needs-license',
    popularityEvidence: prior.popularityEvidence || null,
    verifiedAt: prior.verifiedAt || null,
  }
})

const fingerprintGroups = groupDuplicates(entries, 'melodicFingerprint')
const identityGroups = groupDuplicates(entries, 'canonicalIdentity')
const ledger = {
  version: 1,
  localOnly: true,
  albumDir,
  generatedAt: new Date().toISOString(),
  entryCount: entries.length,
  sourcePolicy: {
    popularityWeight: 0.35,
    wwmCompatibilityWeight: 0.30,
    provenanceWeight: 0.20,
    varietyWeight: 0.15,
    legacyRightsStatus: 'needs-license',
  },
  duplicateReview: {
    transpositionInvariantFingerprintGroups: fingerprintGroups,
    canonicalIdentityGroups: identityGroups,
  },
  entries,
}
await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`)

const integrity = {
  version: 1,
  localOnly: true,
  generatedAt: new Date().toISOString(),
  targetCount: entries.length,
  files: entries.map(entry => ({ filename: entry.filename, sha256: entry.sha256, bytes: entry.bytes })),
}
await writeFile(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`)

console.log(JSON.stringify({ albumDir, entries: entries.length, ledgerPath, integrityPath, fingerprintGroups: fingerprintGroups.length, identityGroups: identityGroups.length }, null, 2))

function groupDuplicates(entries, field) {
  const groups = new Map()
  for (const entry of entries) {
    if (!entry[field]) continue
    const group = groups.get(entry[field]) || []
    group.push(entry.filename)
    groups.set(entry[field], group)
  }
  return [...groups.entries()]
    .filter(([, filenames]) => filenames.length > 1)
    .map(([value, filenames]) => ({ [field]: value, filenames }))
}

function parseArgs(argv) {
  const parsed = { concurrency: 8 }
  for (const value of argv) {
    if (value.startsWith('--album-dir=')) parsed.albumDir = value.slice(12)
    if (value.startsWith('--concurrency=')) parsed.concurrency = Math.max(1, Number(value.slice(14)) || 8)
  }
  return parsed
}
