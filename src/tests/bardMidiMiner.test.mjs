import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { __testing } from '../../scripts/bard-midi-miner.mjs'

const {
  appendLedgerRejections,
  buildAuditStatus,
  buildResolvedSourceKeySets,
  buildTitleCleanupReport,
  buildTitleCleanupRow,
  buildTitleReviewSuggestions,
  classifyDownloadOrValidationError,
  cleanTitleFilename,
  cleanTitlePiece,
  createTitleReviewWebClient,
  looksLikeJunkRecord,
  normalizeSkipReason,
  parseCsv,
  parseTitleReviewFilename,
  preDownloadSkipReasons,
  repairCommonMojibake,
  selectPendingAuditRecords,
  titleReviewCsvRowToRename,
  titleReviewSuggestionsToCsv,
  updateTitleCleanupLedgers,
  validateTitleReviewApplyPlan,
  validateTitleApplyPlan,
} = __testing

describe('Bard MIDI miner audit helpers', () => {
  it('counts accepted, rejected, resolved, and pending catalog records', () => {
    const records = [
      record({ key: 'bmp:1', source: 'bmp' }),
      record({ key: 'bmp:2', source: 'bmp' }),
      record({ key: 'ffxivbard:3', source: 'ffxivbard' }),
    ]
    const ledger = {
      entries: [{ sourceKey: 'bmp:1' }],
      rejections: [{ sourceKey: 'bmp:2', reason: 'too-short' }],
    }

    const status = buildAuditStatus(records, ledger)

    expect(status.acceptedRecords).toBe(1)
    expect(status.rejectedRecords).toBe(1)
    expect(status.resolvedRecords).toBe(2)
    expect(status.pendingRecords).toBe(1)
    expect(status.pendingBySource).toEqual({ ffxivbard: 1 })
  })

  it('selects only unresolved solo records for a source in quality order', () => {
    const records = [
      record({ key: 'bmp:1', source: 'bmp', qualityScore: 10 }),
      record({ key: 'bmp:2', source: 'bmp', qualityScore: 50 }),
      record({ key: 'bmp:3', source: 'bmp', ensemble: 'duo', qualityScore: 100 }),
      record({ key: 'ffxivbard:4', source: 'ffxivbard', qualityScore: 80 }),
    ]
    const ledger = {
      entries: [{ sourceKey: 'bmp:2' }],
      rejections: [],
    }

    const selected = selectPendingAuditRecords(records, ledger, {
      sourceFilter: ['bmp'],
      includeEnsembles: false,
    })

    expect(selected.map((item) => item.key)).toEqual(['bmp:1'])
  })

  it('marks the catalog complete when all source keys are accepted or rejected', () => {
    const records = [record({ key: 'bmp:1' }), record({ key: 'bmp:2' })]
    const ledger = {
      entries: [{ sourceKey: 'bmp:1' }],
      rejections: [{ sourceKey: 'bmp:2', reason: 'title-duplicate' }],
    }

    expect(buildResolvedSourceKeySets(ledger).resolved.size).toBe(2)
    expect(buildAuditStatus(records, ledger).pendingRecords).toBe(0)
  })

  it('keeps pre-download skip reasons concrete', () => {
    const index = existingIndex()
    index.byTitleKey.set('artist song', { file: 'Existing Artist Song.mid' })
    index.byAlbumAuditKey.set('- bard bmp song theme', { file: 'Bard BMP - Theme Song - Solo - Piper Weiss - 14568.mid' })
    index.bySourceMd5.add('abc123')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:1', artist: 'Artist', title: 'Song' }),
      index,
      new Set(),
      90,
      720
    )).toContain('title-duplicate')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:2', md5: 'abc123' }),
      index,
      new Set(),
      90,
      720
    )).toContain('source-md5-duplicate')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:3', durationMs: 89_000 }),
      existingIndex(),
      new Set(),
      90,
      720
    )).toContain('too-short')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:4', durationMs: 721_000 }),
      existingIndex(),
      new Set(),
      90,
      720
    )).toContain('too-long')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:6', artist: null, title: 'Theme Song', arranger: 'Faie Faie', sourceId: 5054 }),
      index,
      new Set(),
      90,
      720
    )).toContain('title-duplicate')

    expect(preDownloadSkipReasons(
      record({ key: 'bmp:5' }),
      existingIndex(),
      new Set(['bmp:5']),
      90,
      720
    )).toContain('already-in-ledger')
  })

  it('rejects obvious FFXIV-Bard placeholder metadata', () => {
    expect(looksLikeJunkRecord(record({
      key: 'ffxivbard:1',
      source: 'ffxivbard',
      title: 'asdasdasdasd',
      artist: '123123',
      arranger: 'asd',
    }))).toBe(true)

    expect(looksLikeJunkRecord(record({
      key: 'ffxivbard:2',
      source: 'ffxivbard',
      title: 'Safe and Sound',
      artist: 'Capital Cities',
      arranger: 'Klaus Lightsbane',
    }))).toBe(false)
  })

  it('preserves all source-key rejections without truncating the audit ledger', () => {
    const ledger = {
      rejections: Array.from({ length: 1005 }, (_, index) => ({
        sourceKey: `bmp:${index}`,
        reason: 'too-short',
      })),
    }

    appendLedgerRejections(ledger, [{ sourceKey: 'bmp:2000', reason: 'too-long' }])

    expect(ledger.rejections).toHaveLength(1006)
    expect(ledger.rejections.some((item) => item.sourceKey === 'bmp:0')).toBe(true)
    expect(ledger.rejections.some((item) => item.sourceKey === 'bmp:2000')).toBe(true)
  })

  it('normalizes validation failures into stable rejection reasons', () => {
    expect(normalizeSkipReason('shorter-than-90-seconds')).toBe('too-short')
    expect(normalizeSkipReason('longer-than-12-minutes')).toBe('too-long')
    expect(classifyDownloadOrValidationError('MIDI has no playable note events.')).toBe('no-note-events')
    expect(classifyDownloadOrValidationError('MIDI note density is too high (80.0 notes/sec).')).toBe('too-dense')
    expect(classifyDownloadOrValidationError('MIDI pitch range is unusually wide (102 semitones).')).toBe('wide-pitch-range')
  })
})

describe('Bard MIDI title cleanup helpers', () => {
  it('generates clean Artist - Song filenames', () => {
    expect(cleanTitleFilename('Linkin Park', 'In the End')).toBe('Linkin Park - In the End.mid')
    expect(cleanTitleFilename('Artist: Name', 'Song / Name?')).toBe('Artist Name - Song Name.mid')
  })

  it('removes arrangement markers from title fields without using filename prefixes', () => {
    const row = buildTitleCleanupRow(
      'Bard BMP - Linkin Park - In the End - Solo - Meriadoc Took - 774.mid',
      'abc',
      titleMetadata({ artist: 'Linkin Park', title: 'In the End', sourceKey: 'bmp:774' })
    )

    expect(row.status).toBe('rename-ready')
    expect(row.proposedFile).toBe('Linkin Park - In the End.mid')
    expect(cleanTitlePiece('Teeth (Solo/Duet)', { isTitle: true })).toBe('Teeth')
  })

  it('repairs common mojibake before proposing title cleanup', () => {
    expect(repairCommonMojibake('Beyonc\u00c3\u00a9 - Final Fantasy VII \u00e2\u20ac\u201c Theme')).toBe(
      'Beyonc\u00e9 - Final Fantasy VII - Theme'
    )

    const row = buildTitleCleanupRow(
      'Bard BMP - Beyonce - Crazy in Love - Solo - Arranger - 1.mid',
      'abc',
      titleMetadata({ artist: 'Beyonc\u00c3\u00a9', title: 'Crazy in Love' })
    )

    expect(row.status).toBe('rename-ready')
    expect(row.proposedFile).toBe('Beyonc\u00e9 - Crazy in Love.mid')

    const broadMojibake = buildTitleCleanupRow(
      'BTS (bangtan) - Butter.mid',
      'abc',
      titleMetadata({ artist: 'BTS (\u00eb\u00b0\u00a9\u00ed\u0192\u201e)', title: 'Butter' })
    )
    expect(broadMojibake.status).toBe('review-needed')
    expect(broadMojibake.reason).toBe('mojibake-review')

    const symbolMojibake = buildTitleCleanupRow(
      'Kamen Rider 555 - Justis.mid',
      'abc',
      titleMetadata({ artist: 'Kamen Rider 555', title: "Justi\u00cf\u2020's" })
    )
    expect(symbolMojibake.status).toBe('review-needed')
    expect(symbolMojibake.reason).toBe('mojibake-review')

    const validAccents = buildTitleCleanupRow(
      'Bard BMP - Chopin - Winter Winds - Solo - Arranger - 1.mid',
      'abc',
      titleMetadata({ artist: 'Fr\u00e9d\u00e9ric Chopin', title: 'Winter Winds' })
    )
    expect(validAccents.status).toBe('rename-ready')
    expect(validAccents.proposedFile).toBe('Fr\u00e9d\u00e9ric Chopin - Winter Winds.mid')
  })

  it('keeps unclear or suspicious metadata in review-only status', () => {
    expect(buildTitleCleanupRow('Loose File.mid', 'abc', null).status).toBe('review-needed')

    const sourceNoteArtist = buildTitleCleanupRow(
      'Bard BMP - A random Midi I found on reddit. - Gott Mit Uns - Solo - 1.mid',
      'abc',
      titleMetadata({ artist: 'A random Midi I found on reddit.', title: 'Gott Mit Uns' })
    )
    expect(sourceNoteArtist.status).toBe('review-needed')
    expect(sourceNoteArtist.reason).toBe('suspect-artist')

    const sourceCreditArtist = buildTitleCleanupRow(
      'Supreme MIDI - Britney Spears - Baby One More Time.mid',
      'abc',
      titleMetadata({ artist: 'Supreme MIDI', title: 'Britney Spears - Baby One More Time' })
    )
    expect(sourceCreditArtist.status).toBe('review-needed')
    expect(sourceCreditArtist.reason).toBe('suspect-artist')

    const swapped = buildTitleCleanupRow(
      'Bard BMP - Baba ORiley - The Who - Solo - 1.mid',
      'abc',
      titleMetadata({ artist: "Baba O'Riley (Teenage Wasteland)", title: 'The Who' })
    )
    expect(swapped.status).toBe('review-needed')
    expect(swapped.reason).toBe('possible-swapped-artist-title')
  })

  it('marks clean-name collisions for review instead of automatic rename', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wwm-title-audit-'))
    try {
      writeFileSync(path.join(dir, 'A.mid'), 'a')
      writeFileSync(path.join(dir, 'B.mid'), 'b')
      const report = buildTitleCleanupReport(dir, {
        ledgers: {
          bard: {
            byFile: new Map([
              ['a.mid', titleMetadata({ artist: 'Artist', title: 'Useful Song' })],
              ['b.mid', titleMetadata({ artist: 'Artist', title: 'Useful Song' })],
            ]),
            byHash: new Map(),
          },
          mainstream: { byFile: new Map(), byHash: new Map() },
        },
      })

      expect(report.summary.collisionReview).toBe(2)
      expect(report.rows.every((row) => row.status === 'collision-review')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('blocks renames that would collide under album-audit normalization', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wwm-title-normalized-'))
    try {
      writeFileSync(path.join(dir, 'Bard BMP - Artist - Useful Song - Solo - Arranger - 1.mid'), 'a')
      writeFileSync(path.join(dir, 'WWM Reddit - Artist - Useful Song.mid'), 'b')
      const report = buildTitleCleanupReport(dir, {
        ledgers: {
          bard: {
            byFile: new Map([
              [
                'bard bmp - artist - useful song - solo - arranger - 1.mid',
                titleMetadata({ artist: 'Artist', title: 'Useful Song' }),
              ],
            ]),
            byHash: new Map(),
          },
          mainstream: { byFile: new Map(), byHash: new Map() },
        },
      })

      const targetRow = report.rows.find((row) => row.currentFile.startsWith('Bard BMP'))
      expect(targetRow.status).toBe('collision-review')
      expect(targetRow.reason).toBe('normalized-title-collision')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects unsafe apply plans with duplicate targets', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wwm-title-apply-'))
    try {
      writeFileSync(path.join(dir, 'A.mid'), 'a')
      writeFileSync(path.join(dir, 'B.mid'), 'b')

      const validation = validateTitleApplyPlan(dir, [
        { currentFile: 'A.mid', proposedFile: 'Artist - Song.mid' },
        { currentFile: 'B.mid', proposedFile: 'Artist - Song.mid' },
      ])

      expect(validation.ok).toBe(false)
      expect(validation.errors.join('\n')).toContain('Duplicate target')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updates local ledger album filenames after an apply plan', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wwm-title-ledger-'))
    const ledgerPath = path.join(dir, '.local-bard-source-ledger.json')
    try {
      writeFileSync(ledgerPath, JSON.stringify({
        version: 1,
        entries: [
          { sourceKey: 'bmp:1', albumFile: 'Old Name.mid', sha256: 'abc' },
          { sourceKey: 'bmp:2', albumFile: 'Keep Name.mid', sha256: 'def' },
        ],
        rejections: [],
      }))

      await updateTitleCleanupLedgers(dir, [
        { currentFile: 'Old Name.mid', proposedFile: 'Artist - Song.mid' },
      ], { ledgerFiles: [ledgerPath] })

      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
      expect(ledger.entries[0].albumFile).toBe('Artist - Song.mid')
      expect(ledger.entries[1].albumFile).toBe('Keep Name.mid')
      expect(ledger.titleCleanup.renamedFiles).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Bard MIDI title review suggestion helpers', () => {
  it('parses known local filename patterns into Artist - Song candidates', () => {
    expect(parseTitleReviewFilename('BMP Top Harp - 01 - Linkin Park-In the End-Solo-Meriadoc Took.mid')).toMatchObject({
      artist: 'Linkin Park',
      title: 'In the End',
      source: 'filename-bmp-top-harp',
    })

    expect(parseTitleReviewFilename("Bard BMP - Baba O'Riley (Teenage Wasteland) - The Who - Solo - Editor - 6196.mid")).toMatchObject({
      artist: "Baba O'Riley (Teenage Wasteland)",
      title: 'The Who',
      source: 'filename-bard-bmp',
    })
  })

  it('generates CSV-first recommendations for common review reasons', async () => {
    const rows = [
      reviewRow({
        currentFile: 'Bard BMP - 24-Hour Cinderella - Solo - Editor - 1.mid',
        reason: 'missing-artist',
        title: '24-Hour Cinderella',
        sourceWork: 'Yakuza 0',
      }),
      reviewRow({
        currentFile: 'BMP Top Harp - 01 - Linkin Park-In the End-Solo-Meriadoc Took.mid',
        reason: 'no-ledger-metadata',
      }),
      reviewRow({
        currentFile: "Bard BMP - Baba O'Riley (Teenage Wasteland) - The Who - Solo - Editor - 2.mid",
        reason: 'possible-swapped-artist-title',
        artist: "Baba O'Riley (Teenage Wasteland)",
        title: 'The Who',
      }),
      reviewRow({
        currentFile: 'Bard BMP - A random Midi I found on reddit. - Gott Mit Uns - Solo - Editor - 3.mid',
        reason: 'suspect-artist',
        artist: 'A random Midi I found on reddit.',
        title: 'Gott Mit Uns',
      }),
      reviewRow({
        currentFile: 'Bard BMP - K_DA - MORE - Solo - Editor - 4.mid',
        reason: 'normalized-title-collision',
        artist: 'KDA',
        title: 'MORE',
        status: 'collision-review',
      }),
    ]

    const suggestions = await buildTitleReviewSuggestions(rows, {
      batchSize: 2,
      existingRows: [
        ...rows,
        { currentFile: 'WWM Reddit - KDA - MORE.mid', proposedFile: '', status: 'review-needed' },
      ],
      sources: new Set(['local']),
    })

    expect(suggestions).toHaveLength(5)
    expect(suggestions[0]).toMatchObject({
      batch: 1,
      recommendedFile: 'Yakuza 0 - 24-Hour Cinderella.mid',
      evidenceSource: 'local-source-work',
    })
    expect(suggestions[1].recommendedFile).toBe('Linkin Park - In the End.mid')
    expect(suggestions[2].recommendedFile).toBe("The Who - Baba O'Riley (Teenage Wasteland).mid")
    expect(suggestions[3].recommendedFile).toBe('A random Midi I found on reddit. - Gott Mit Uns.mid')
    expect(suggestions[4]).toMatchObject({ decision: 'skip', reason: 'normalized-title-collision' })
  })

  it('writes and parses review CSV rows without approving suggestions by default', async () => {
    const suggestions = await buildTitleReviewSuggestions([
      reviewRow({ currentFile: 'BMP Top Harp - 01 - Artist-Song-Solo-Editor.mid', reason: 'no-ledger-metadata' }),
    ], {
      batchSize: 50,
      sources: new Set(['local']),
      existingRows: [],
    })

    const csv = titleReviewSuggestionsToCsv(suggestions)
    const parsed = parseCsv(csv)

    expect(parsed[0].decision).toBe('')
    expect(parsed[0].recommendedFile).toBe('Artist - Song.mid')
    expect(parsed[0].finalFile).toBe('Artist - Song.mid')
  })

  it('uses mocked MusicBrainz and cache for higher-confidence web suggestions', async () => {
    const cache = { version: 1, entries: {} }
    let calls = 0
    const client = createTitleReviewWebClient({
      cache,
      enabledSources: new Set(['musicbrainz']),
      delayMs: 100,
      wait: async () => {},
      fetchImpl: async () => {
        calls += 1
        return {
          ok: true,
          json: async () => ({
            recordings: [{
              id: 'recording-id',
              title: 'Correct Song',
              score: 99,
              'artist-credit': [{ name: 'Correct Artist' }],
            }],
          }),
        }
      },
    })

    const rows = [reviewRow({
      currentFile: 'Unknown - Correct Song.mid',
      reason: 'missing-artist',
      title: 'Correct Song',
    })]

    const first = await buildTitleReviewSuggestions(rows, {
      batchSize: 50,
      sources: new Set(['musicbrainz']),
      webClient: client,
      existingRows: rows,
    })
    const second = await buildTitleReviewSuggestions(rows, {
      batchSize: 50,
      sources: new Set(['musicbrainz']),
      webClient: client,
      existingRows: rows,
    })

    expect(first[0]).toMatchObject({
      recommendedFile: 'Correct Artist - Correct Song.mid',
      confidence: 'high',
      evidenceSource: 'musicbrainz',
    })
    expect(second[0].recommendedFile).toBe('Correct Artist - Correct Song.mid')
    expect(calls).toBe(1)
  })

  it('uses mocked Wikidata when MusicBrainz is unavailable', async () => {
    const cache = { version: 1, entries: {} }
    const client = createTitleReviewWebClient({
      cache,
      enabledSources: new Set(['wikidata']),
      delayMs: 0,
      wait: async () => {},
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          results: {
            bindings: [{
              work: { value: 'https://www.wikidata.org/entity/Q1' },
              workLabel: { value: 'Game Theme' },
              artistLabel: { value: 'Game Composer' },
            }],
          },
        }),
      }),
    })

    const suggestions = await buildTitleReviewSuggestions([
      reviewRow({ currentFile: 'Game Theme.mid', reason: 'missing-artist', title: 'Game Theme' }),
    ], {
      sources: new Set(['wikidata']),
      webClient: client,
      existingRows: [],
    })

    expect(suggestions[0]).toMatchObject({
      recommendedFile: 'Game Composer - Game Theme.mid',
      confidence: 'medium',
      evidenceSource: 'wikidata',
    })
  })

  it('converts approved CSV rows to rename rows and blocks normalized collisions', () => {
    expect(titleReviewCsvRowToRename({
      rowId: 'row-1',
      decision: 'approve',
      currentFile: 'Old.mid',
      finalArtist: 'Artist',
      finalTitle: 'Song',
      finalFile: '',
    })).toMatchObject({
      currentFile: 'Old.mid',
      proposedFile: 'Artist - Song.mid',
    })

    const dir = mkdtempSync(path.join(tmpdir(), 'wwm-title-review-apply-'))
    try {
      writeFileSync(path.join(dir, 'Old.mid'), 'old')
      writeFileSync(path.join(dir, 'WWM Reddit - Artist - Song.mid'), 'existing')
      const validation = validateTitleReviewApplyPlan(dir, [{
        currentFile: 'Old.mid',
        proposedFile: 'Artist - Song.mid',
      }])

      expect(validation.ok).toBe(false)
      expect(validation.errors.join('\n')).toContain('album audit normalization')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function record(overrides = {}) {
  return {
    key: 'bmp:test',
    source: 'bmp',
    sourceId: 1,
    title: 'Useful Song',
    artist: 'Artist',
    arranger: 'Arranger',
    ensemble: 'solo',
    durationMs: 180_000,
    downloadUrl: 'https://example.test/song.mid',
    qualityScore: 10,
    ...overrides,
  }
}

function existingIndex() {
  return {
    byHash: new Map(),
    byTitleKey: new Map(),
    byAlbumAuditKey: new Map(),
    tokenRows: [],
    bySourceMd5: new Set(),
  }
}

function titleMetadata(overrides = {}) {
  return {
    ledgerSource: 'bard',
    fileNames: [],
    sourceKey: 'bmp:test',
    source: 'bmp',
    sourceId: 1,
    title: 'Song',
    artist: 'Artist',
    sourceWork: null,
    arranger: 'Arranger',
    sha256: 'abc',
    ...overrides,
  }
}

function reviewRow(overrides = {}) {
  return {
    currentFile: 'Review.mid',
    proposedFile: '',
    status: 'review-needed',
    reason: 'missing-artist',
    sourceKey: 'bmp:review',
    source: 'bard',
    sourceId: 1,
    artist: null,
    title: 'Review',
    rawArtist: null,
    rawTitle: 'Review',
    sourceWork: null,
    arranger: 'Arranger',
    sha256: 'abc',
    hash: 'abc',
    confidenceNotes: [],
    ...overrides,
  }
}
