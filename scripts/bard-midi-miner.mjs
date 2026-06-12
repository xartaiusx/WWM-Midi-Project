#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMidi } from "midi-file";

const BMP_BASE = "https://bardmusicplayer.com";
const BMP_SEARCH_URL = `${BMP_BASE}/api/midi-search`;
const FFXIV_BARD_BASE = "https://ffxivbard.com";
const FFXIV_BARD_SONG_LIST = `${FFXIV_BARD_BASE}/song/list`;
const DEFAULT_ALBUM_DIR = "src-tauri/target/release/album";
const DEFAULT_CATALOG_FILE = ".local-bard-catalog.json";
const DEFAULT_LEDGER_FILE = ".local-bard-source-ledger.json";
const MAINSTREAM_LEDGER_FILE = ".local-mainstream-midi-ledger.json";
const TITLE_CLEANUP_REPORT_FILE = ".local-title-cleanup-report.json";
const TITLE_CLEANUP_PLAN_FILE = ".local-title-cleanup-plan.csv";
const TITLE_CLEANUP_BACKUP_PREFIX = ".local-title-cleanup-backup";
const TITLE_REVIEW_SUGGESTIONS_CSV_FILE = ".local-title-review-suggestions.csv";
const TITLE_REVIEW_SUGGESTIONS_JSON_FILE = ".local-title-review-suggestions.json";
const TITLE_REVIEW_WEB_CACHE_FILE = ".local-title-review-web-cache.json";
const TITLE_REVIEW_BACKUP_PREFIX = ".local-title-review-backup";
const METADATA_CACHE_FILE = ".metadata_cache.json";
const USER_AGENT = "WWM-Midi-Project local MIDI miner";
const WEB_USER_AGENT = "WWM-Midi-Project/1.1.9 (local title review; https://github.com/xartaiusx/WWM-Midi-Project)";
const MUSICBRAINZ_RECORDING_URL = "https://musicbrainz.org/ws/2/recording";
const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";
const FIT_INSTRUMENTS = new Set(["harp", "lute", "piano"]);
const GENERIC_SINGLE_TOKENS = new Set(["theme", "song", "music", "intro", "ending"]);
const FFXIV_FOCUSED_GENRES = ["36", "37", "1", "2", "35"];
const FFXIV_GENRE_NAMES = {
  "1": "Pop",
  "2": "Rock",
  "35": "Soundtrack",
  "36": "Games",
  "37": "Anime",
};

const moduleDir = typeof import.meta.dir === "string" ? import.meta.dir : path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const command = process.argv[2] || "help";
const args = parseArgs(process.argv.slice(3));
const albumDir = path.resolve(repoRoot, args.get("album-dir") || DEFAULT_ALBUM_DIR);
const catalogPath = path.resolve(albumDir, args.get("catalog") || DEFAULT_CATALOG_FILE);
const ledgerPath = path.resolve(albumDir, args.get("ledger") || DEFAULT_LEDGER_FILE);

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    if (args.get("debug") === "true" && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

async function main() {
  switch (command) {
    case "discover-bmp":
      await discoverBmp();
      break;
    case "discover-ffxivbard":
      await discoverFfxivBard();
      break;
    case "download":
      await downloadSelected();
      break;
    case "audit-status":
      await auditStatus();
      break;
    case "audit-batch":
      await auditBatch();
      break;
    case "verify":
      await verifyAlbum();
      break;
    case "title-audit":
      await titleAudit();
      break;
    case "title-apply":
      await titleApply();
      break;
    case "title-review-suggest":
      await titleReviewSuggest();
      break;
    case "title-review-apply":
      await titleReviewApply();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function discoverBmp() {
  await mkdir(albumDir, { recursive: true });

  const dryRun = boolArg("dry-run", false);
  const catalog = readJson(catalogPath, emptyCatalog());
  const existingIndex = buildExistingIndex(albumDir);
  const ensembles = csvArg("ensemble", "solo");
  const sort = args.get("sort") || "-downloads";
  const maxPages = pagesArg("pages", args.get("max-pages"));
  const delayMs = numberArg("delay-ms", 125);
  const startedAt = new Date().toISOString();

  let fetched = 0;
  let added = 0;
  let updated = 0;
  const recordsByKey = catalogMap(catalog);

  for (const ensemble of ensembles) {
    let page = 1;
    let totalPages = 1;
    do {
      const url = new URL(BMP_SEARCH_URL);
      url.searchParams.set("page", String(page));
      url.searchParams.set("sort", sort);
      if (ensemble !== "all") url.searchParams.set("ensemble", ensemble);
      for (const optionalParam of ["search", "editor", "source", "instruments"]) {
        if (args.has(optionalParam)) url.searchParams.set(optionalParam, args.get(optionalParam));
      }

      const data = await fetchJson(url);
      const docs = Array.isArray(data.docs) ? data.docs : [];
      totalPages = Math.max(1, Number(data.totalPages || totalPages || 1));
      fetched += docs.length;

      for (const doc of docs) {
        const record = sanitizeBmpRecord(doc);
        annotateDiscovery(record, existingIndex);
        const previous = recordsByKey.get(record.key);
        recordsByKey.set(record.key, previous ? mergeRecord(previous, record) : record);
        if (previous) updated += 1;
        else added += 1;
      }

      if (page === 1 || page % 10 === 0 || page >= totalPages) {
        console.log(`BMP ${ensemble}: page ${page}/${totalPages}, fetched ${fetched.toLocaleString()} records`);
      }
      page += 1;
      if (page <= totalPages) await delay(delayMs);
    } while (page <= totalPages && (maxPages === "all" || page <= maxPages));
  }

  catalog.records = [...recordsByKey.values()].sort(sortCatalogRecords);
  catalog.generatedAt = new Date().toISOString();
  catalog.lastDiscovery = {
    source: "bmp",
    startedAt,
    completedAt: catalog.generatedAt,
    dryRun,
    fetched,
    added,
    updated,
    args: Object.fromEntries(args),
  };
  catalog.stats = summarizeCatalog(catalog.records);

  printDiscoverySummary("BMP discovery", catalog.records.filter((record) => record.source === "bmp"), {
    fetched,
    added,
    updated,
    dryRun,
  });

  if (!dryRun) {
    await writeJson(catalogPath, catalog);
    console.log(`Catalog written: ${relative(catalogPath)}`);
  } else {
    console.log("Dry run only; catalog was not changed.");
  }
}

async function discoverFfxivBard() {
  await mkdir(albumDir, { recursive: true });

  const dryRun = boolArg("dry-run", false);
  const catalog = readJson(catalogPath, emptyCatalog());
  const existingIndex = buildExistingIndex(albumDir);
  const maxPages = pagesArg("pages", args.get("max-pages"));
  const delayMs = numberArg("delay-ms", 175);
  const queries = buildFfxivBardQueries();
  const startedAt = new Date().toISOString();

  let fetched = 0;
  let added = 0;
  let updated = 0;
  const recordsByKey = catalogMap(catalog);

  for (const query of queries) {
    let page = 1;
    let lastPage = 1;
    do {
      const url = new URL(FFXIV_BARD_SONG_LIST);
      for (const [key, value] of Object.entries(query.params)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
      url.searchParams.set("page", String(page));

      const html = await fetchText(url);
      const pageRecords = parseFfxivBardCards(html, query);
      lastPage = Math.max(lastPage, maxPageFromHtml(html), pageRecords.length > 0 ? page : 1);
      fetched += pageRecords.length;

      for (const record of pageRecords) {
        annotateDiscovery(record, existingIndex);
        const previous = recordsByKey.get(record.key);
        recordsByKey.set(record.key, previous ? mergeRecord(previous, record) : record);
        if (previous) updated += 1;
        else added += 1;
      }

      console.log(
        `FFXIV-Bard ${query.label}: page ${page}/${lastPage}, fetched ${fetched.toLocaleString()} records`
      );

      page += 1;
      if (page <= lastPage) await delay(delayMs);
    } while (page <= lastPage && (maxPages === "all" || page <= maxPages));
  }

  catalog.records = [...recordsByKey.values()].sort(sortCatalogRecords);
  catalog.generatedAt = new Date().toISOString();
  catalog.lastDiscovery = {
    source: "ffxivbard",
    startedAt,
    completedAt: catalog.generatedAt,
    dryRun,
    fetched,
    added,
    updated,
    queryCount: queries.length,
    args: Object.fromEntries(args),
  };
  catalog.stats = summarizeCatalog(catalog.records);

  printDiscoverySummary(
    "FFXIV-Bard discovery",
    catalog.records.filter((record) => record.source === "ffxivbard"),
    { fetched, added, updated, dryRun }
  );

  if (!dryRun) {
    await writeJson(catalogPath, catalog);
    console.log(`Catalog written: ${relative(catalogPath)}`);
  } else {
    console.log("Dry run only; catalog was not changed.");
  }
}

async function downloadSelected() {
  await mkdir(albumDir, { recursive: true });

  const catalog = readJson(catalogPath, null);
  if (!catalog || !Array.isArray(catalog.records)) {
    throw new Error(`No catalog found at ${catalogPath}. Run discover-bmp or discover-ffxivbard first.`);
  }

  const dryRun = boolArg("dry-run", false);
  const sourceFilter = csvArg("source", "bmp").map((value) => value.toLowerCase());
  const includeEnsembles = boolArg("include-ensembles", false);
  const limit = numberArg("limit", 250);
  const minSeconds = numberArg("min-seconds", 90);
  const maxSeconds = numberArg("max-seconds", 720);
  const maxNotesPerSecond = numberArg("max-notes-per-second", 55);
  const delayMs = numberArg("delay-ms", 150);
  const existingIndex = buildExistingIndex(albumDir);
  const ledger = readJson(ledgerPath, emptyLedger());
  const { resolved, accepted } = buildResolvedSourceKeySets(ledger);

  const candidates = catalog.records
    .filter((record) => sourceFilter.includes("all") || sourceFilter.includes(record.source))
    .filter((record) => includeEnsembles || normalizeWord(record.ensemble) === "solo")
    .filter((record) => !resolved.has(record.key))
    .map((record) => ({
      record,
      skipReasons: preDownloadSkipReasons(record, existingIndex, accepted, minSeconds, maxSeconds),
    }))
    .filter((item) => item.skipReasons.length === 0)
    .sort((a, b) => (b.record.qualityScore || 0) - (a.record.qualityScore || 0))
    .slice(0, limit);

  console.log("Download selection");
  console.log(`- Catalog records: ${catalog.records.length.toLocaleString()}`);
  console.log(`- Source filter: ${sourceFilter.join(", ")}`);
  console.log(`- Candidate limit: ${limit.toLocaleString()}`);
  console.log(`- Candidates after duplicate and duration filters: ${candidates.length.toLocaleString()}`);

  if (dryRun) {
    for (const item of candidates.slice(0, Math.min(25, candidates.length))) {
      console.log(`  ${item.record.key}: ${displayTitle(item.record)} (${item.record.downloads || 0} downloads)`);
    }
    console.log("Dry run only; no files were downloaded.");
    return;
  }

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const rejections = [];

  for (const item of candidates) {
    const { record } = item;
    try {
      const buffer = await fetchMidi(record.downloadUrl);
      const validation = validateMidiBuffer(buffer, { minSeconds, maxSeconds, maxNotesPerSecond });
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const exactDuplicate = existingIndex.byHash.get(sha256);
      if (exactDuplicate) {
        skipped += 1;
        rejections.push(rejection(record, "exact-duplicate", `Matches ${path.basename(exactDuplicate.file)}`));
        continue;
      }
      const titleDuplicate = findLikelyTitleDuplicate(record, existingIndex);
      if (titleDuplicate) {
        skipped += 1;
        rejections.push(rejection(record, "title-duplicate", `Looks like ${path.basename(titleDuplicate.file)}`));
        continue;
      }

      const finalName = uniqueAlbumFilename(albumDir, record);
      const finalPath = path.join(albumDir, finalName);
      const tempPath = path.join(albumDir, `.download-${process.pid}-${Date.now()}.mid`);
      await writeFile(tempPath, buffer);
      await rename(tempPath, finalPath);

      const entry = {
        ...ledgerEntryForDownload(record, finalName, sha256, buffer, validation),
        downloadedAt: new Date().toISOString(),
      };

      upsertLedgerEntry(ledger, entry);
      addExistingFile(existingIndex, finalPath, buffer, record, sha256);
      if (record.md5) existingIndex.bySourceMd5.add(record.md5);
      downloaded += 1;
      console.log(`Downloaded ${downloaded.toLocaleString()}: ${finalName}`);
    } catch (error) {
      failed += 1;
      rejections.push(rejection(record, "download-or-validation-failed", error.message));
      console.warn(`::warning::Skipped ${record.key}: ${error.message}`);
    }

    await delay(delayMs);
  }

  ledger.generatedAt = new Date().toISOString();
  ledger.albumDir = relative(albumDir);
  ledger.summary = summarizeLedger(ledger);
  appendLedgerRejections(ledger, rejections);
  await writeJson(ledgerPath, ledger);

  console.log("Download complete");
  console.log(`- Downloaded: ${downloaded.toLocaleString()}`);
  console.log(`- Skipped duplicates: ${skipped.toLocaleString()}`);
  console.log(`- Failed validation/download: ${failed.toLocaleString()}`);
  console.log(`Ledger written: ${relative(ledgerPath)}`);
}

async function auditStatus() {
  const catalog = readJson(catalogPath, null);
  if (!catalog || !Array.isArray(catalog.records)) {
    throw new Error(`No catalog found at ${catalogPath}. Run discover-bmp or discover-ffxivbard first.`);
  }
  const ledger = readJson(ledgerPath, emptyLedger());
  const sourceFilter = csvArg("source", "all").map((value) => value.toLowerCase());
  const status = buildAuditStatus(catalog.records, ledger, { sourceFilter });

  if (boolArg("json", false)) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log("Bard catalog audit status");
  console.log(`- Catalog records: ${status.catalogRecords.toLocaleString()}`);
  console.log(`- Accepted: ${status.acceptedRecords.toLocaleString()}`);
  console.log(`- Rejected: ${status.rejectedRecords.toLocaleString()}`);
  console.log(`- Resolved: ${status.resolvedRecords.toLocaleString()}`);
  console.log(`- Pending: ${status.pendingRecords.toLocaleString()}`);
  console.log(`- Pending by source: ${formatCounts(status.pendingBySource)}`);
  console.log(`- Pending by status: ${formatCounts(status.pendingByDiscoveryStatus)}`);
  console.log(`- Active album MIDI files: ${listMidiFiles(albumDir).length.toLocaleString()}`);
}

async function auditBatch() {
  await mkdir(albumDir, { recursive: true });

  const catalog = readJson(catalogPath, null);
  if (!catalog || !Array.isArray(catalog.records)) {
    throw new Error(`No catalog found at ${catalogPath}. Run discover-bmp or discover-ffxivbard first.`);
  }

  const dryRun = boolArg("dry-run", false);
  const sourceFilter = csvArg("source", "bmp").map((value) => value.toLowerCase());
  const includeEnsembles = boolArg("include-ensembles", false);
  const maxDownloads = numberArg("max-downloads", numberArg("limit", 100));
  const minSeconds = numberArg("min-seconds", 90);
  const maxSeconds = numberArg("max-seconds", 720);
  const maxNotesPerSecond = numberArg("max-notes-per-second", 55);
  const delayMs = numberArg("delay-ms", 150);
  const startedAt = new Date().toISOString();

  let existingIndex = buildExistingIndex(albumDir);
  const ledger = readJson(ledgerPath, emptyLedger());
  const records = selectPendingAuditRecords(catalog.records, ledger, { sourceFilter, includeEnsembles });

  const batch = {
    id: `batch-${startedAt.replace(/[:.]/g, "-")}`,
    command: "audit-batch",
    source: sourceFilter.join(","),
    maxDownloads,
    minSeconds,
    maxSeconds,
    maxNotesPerSecond,
    dryRun,
    startedAt,
    completedAt: null,
    firstKey: records[0]?.key || null,
    lastKey: null,
    scanned: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    verification: { status: dryRun ? "not-run" : "pending" },
  };
  const rejections = [];

  console.log("Bard catalog audit batch");
  console.log(`- Source filter: ${sourceFilter.join(", ")}`);
  console.log(`- Pending records in scope: ${records.length.toLocaleString()}`);
  console.log(`- Max accepted downloads: ${maxDownloads.toLocaleString()}`);

  for (const record of records) {
    if (batch.accepted >= maxDownloads) break;
    batch.scanned += 1;
    batch.lastKey = record.key;

    const { accepted } = buildResolvedSourceKeySets(ledger);
    const skipReasons = preDownloadSkipReasons(record, existingIndex, accepted, minSeconds, maxSeconds);
    if (skipReasons.length > 0) {
      const reason = normalizeSkipReason(skipReasons[0]);
      rejections.push(rejection(record, reason, skipReasons.join(", ")));
      batch.rejected += 1;
      continue;
    }

    if (dryRun) {
      console.log(`Would download ${record.key}: ${displayTitle(record)}`);
      batch.accepted += 1;
      continue;
    }

    try {
      const buffer = await fetchMidi(record.downloadUrl);
      const validation = validateMidiBuffer(buffer, { minSeconds, maxSeconds, maxNotesPerSecond });
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const exactDuplicate = existingIndex.byHash.get(sha256);
      if (exactDuplicate) {
        rejections.push(rejection(record, "exact-duplicate", `Matches ${path.basename(exactDuplicate.file)}`));
        batch.rejected += 1;
        continue;
      }
      const titleDuplicate = findLikelyTitleDuplicate(record, existingIndex);
      if (titleDuplicate) {
        rejections.push(rejection(record, "title-duplicate", `Looks like ${path.basename(titleDuplicate.file)}`));
        batch.rejected += 1;
        continue;
      }

      const finalName = uniqueAlbumFilename(albumDir, record);
      const finalPath = path.join(albumDir, finalName);
      const tempPath = path.join(albumDir, `.download-${process.pid}-${Date.now()}.mid`);
      await writeFile(tempPath, buffer);
      await rename(tempPath, finalPath);

      upsertLedgerEntry(ledger, ledgerEntryForDownload(record, finalName, sha256, buffer, validation));
      addExistingFile(existingIndex, finalPath, buffer, record, sha256);
      if (record.md5) existingIndex.bySourceMd5.add(record.md5);
      batch.accepted += 1;
      console.log(`Accepted ${batch.accepted.toLocaleString()}: ${finalName}`);
    } catch (error) {
      const reason = classifyDownloadOrValidationError(error.message);
      rejections.push(rejection(record, reason, error.message));
      batch.rejected += 1;
      batch.failed += 1;
      console.warn(`::warning::Rejected ${record.key}: ${error.message}`);
    }

    await delay(delayMs);
  }

  batch.completedAt = new Date().toISOString();
  appendLedgerRejections(ledger, rejections);
  ledger.generatedAt = batch.completedAt;
  ledger.albumDir = relative(albumDir);
  ledger.batches = [...(ledger.batches || []), batch];
  ledger.summary = summarizeLedger(ledger);

  if (!dryRun) {
    const verification = verifyActiveAlbumIntegrity({
      minSeconds: 1,
      maxSeconds: 60 * 60,
      maxNotesPerSecond: 120,
    });
    batch.verification = verification.ok
      ? { status: "passed", checkedAt: new Date().toISOString() }
      : { status: "failed", checkedAt: new Date().toISOString(), errors: verification.errors };
  }

  if (!dryRun) {
    await writeJson(ledgerPath, ledger);
  }

  console.log("Audit batch complete");
  console.log(`- Scanned: ${batch.scanned.toLocaleString()}`);
  console.log(`- Accepted: ${batch.accepted.toLocaleString()}`);
  console.log(`- Rejected: ${batch.rejected.toLocaleString()}`);
  console.log(`- Failed download/validation: ${batch.failed.toLocaleString()}`);
  console.log(`- Verification: ${batch.verification.status}`);
  if (!dryRun) console.log(`Ledger written: ${relative(ledgerPath)}`);

  if (batch.verification.status === "failed") {
    for (const error of batch.verification.errors) console.error(`::error::${error}`);
    process.exit(1);
  }
}

async function verifyAlbum() {
  await mkdir(albumDir, { recursive: true });

  const quarantineInvalid = boolArg("quarantine-invalid", false);
  const ledger = readJson(ledgerPath, emptyLedger());
  const files = listMidiFiles(albumDir);
  const rows = [];
  const errors = [];
  const quarantined = [];

  for (const file of files) {
    try {
      const buffer = readFileSync(file);
      const validation = validateMidiBuffer(buffer, {
        minSeconds: numberArg("min-seconds", 1),
        maxSeconds: numberArg("max-seconds", 60 * 60),
        maxNotesPerSecond: numberArg("max-notes-per-second", 120),
      });
      rows.push({
        file,
        relativePath: path.relative(albumDir, file).replaceAll(path.sep, "/"),
        sha256: createHash("sha256").update(buffer).digest("hex"),
        size: buffer.length,
        titleKey: normalizeTitleKey(path.basename(file)),
        validation,
      });
    } catch (error) {
      if (quarantineInvalid) {
        const target = await quarantineFile(file, error.message);
        quarantined.push({ file: path.basename(file), target: relative(target), reason: error.message });
      } else {
        errors.push(`${path.basename(file)}: ${error.message}`);
      }
    }
  }

  const exactDuplicateGroups = groupBy(rows, (row) => row.sha256).filter((group) => group.length > 1);
  const titleDuplicateGroups = groupBy(rows, (row) => row.titleKey).filter((group) => group.length > 1);

  for (const group of exactDuplicateGroups) {
    errors.push(`Exact duplicate ${group[0].sha256}: ${group.map((row) => row.relativePath).join(" | ")}`);
  }
  for (const group of titleDuplicateGroups) {
    errors.push(`Normalized duplicate ${group[0].titleKey}: ${group.map((row) => row.relativePath).join(" | ")}`);
  }

  for (const entry of ledger.entries || []) {
    const row = rows.find((item) => item.relativePath === entry.albumFile || path.basename(item.file) === entry.albumFile);
    if (!row) continue;
    entry.sha256 = row.sha256;
    entry.fileSize = row.size;
    entry.validation = row.validation;
    entry.verifiedAt = new Date().toISOString();
  }
  ledger.generatedAt = new Date().toISOString();
  ledger.albumDir = relative(albumDir);
  ledger.summary = summarizeLedger(ledger);
  if (quarantined.length > 0) {
    appendLedgerRejections(ledger, quarantined.map((item) => ({
        source: "local-album",
        title: item.file,
        reason: "verify-quarantine",
        detail: item.reason,
        target: item.target,
        rejectedAt: new Date().toISOString(),
      })));
  }
  await writeJson(ledgerPath, ledger);

  const noteCounts = rows.map((row) => row.validation.noteCount);
  console.log("Bard MIDI album verification");
  console.log(`- Album dir: ${relative(albumDir)}`);
  console.log(`- MIDI files: ${rows.length.toLocaleString()}`);
  console.log(`- Exact duplicate groups: ${exactDuplicateGroups.length.toLocaleString()}`);
  console.log(`- Normalized duplicate groups: ${titleDuplicateGroups.length.toLocaleString()}`);
  console.log(`- Quarantined invalid files: ${quarantined.length.toLocaleString()}`);
  console.log(`- Note count range: ${noteCounts.length ? `${Math.min(...noteCounts)} - ${Math.max(...noteCounts)}` : "n/a"}`);
  console.log(`Ledger written: ${relative(ledgerPath)}`);

  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`);
    process.exit(1);
  }
}

async function titleAudit() {
  await mkdir(albumDir, { recursive: true });

  const report = buildTitleCleanupReport(albumDir);
  const reportPath = titleCleanupReportPath();
  const planPath = titleCleanupPlanPath();
  await writeJson(reportPath, report);
  await writeFile(planPath, titleCleanupRowsToCsv(report.rows), "utf8");

  printTitleCleanupSummary("Album title cleanup audit", report);
  console.log(`Report written: ${relative(reportPath)}`);
  console.log(`CSV plan written: ${relative(planPath)}`);
}

async function titleApply() {
  await mkdir(albumDir, { recursive: true });

  const dryRun = boolArg("dry-run", false);
  const reportPath = titleCleanupReportPath();
  const report = readJson(reportPath, null);
  if (!report?.rows?.length) {
    throw new Error(`No title cleanup report found. Run "bun run bard:title-audit" first.`);
  }

  const rows = report.rows.filter((row) => row.status === "rename-ready");
  const validation = validateTitleApplyPlan(albumDir, rows);
  if (!validation.ok) {
    for (const error of validation.errors) console.error(`::error::${error}`);
    throw new Error("Title cleanup apply plan is no longer safe. Re-run bard:title-audit.");
  }

  const backup = {
    version: 1,
    generatedAt: new Date().toISOString(),
    albumDir: relative(albumDir),
    reportGeneratedAt: report.generatedAt || null,
    dryRun,
    rows: rows.map((row) => ({
      sourceKey: row.sourceKey || null,
      sha256: row.sha256 || row.hash || null,
      currentFile: row.currentFile,
      proposedFile: row.proposedFile,
      artist: row.artist || null,
      title: row.title || null,
      sourceWork: row.sourceWork || null,
      arranger: row.arranger || null,
    })),
  };
  const backupPath = path.join(albumDir, `${TITLE_CLEANUP_BACKUP_PREFIX}-${timestampForFile()}.json`);
  await writeJson(backupPath, backup);

  if (!dryRun && rows.length > 0) {
    await applyTitleRenameRows(albumDir, rows);
    await updateTitleCleanupLedgers(albumDir, rows);
    await clearMetadataCache(albumDir);
  }

  const refreshedReport = buildTitleCleanupReport(albumDir);
  await writeJson(reportPath, refreshedReport);
  await writeFile(titleCleanupPlanPath(), titleCleanupRowsToCsv(refreshedReport.rows), "utf8");

  printTitleCleanupSummary(dryRun ? "Album title cleanup apply dry run" : "Album title cleanup applied", refreshedReport);
  console.log(`Renames ${dryRun ? "planned" : "applied"}: ${rows.length.toLocaleString()}`);
  console.log(`Backup written: ${relative(backupPath)}`);
  console.log(`Report refreshed: ${relative(reportPath)}`);
}

async function titleReviewSuggest() {
  await mkdir(albumDir, { recursive: true });

  const batchSize = numberArg("batch-size", 50);
  const report = buildTitleCleanupReport(albumDir);
  await writeJson(titleCleanupReportPath(), report);
  await writeFile(titleCleanupPlanPath(), titleCleanupRowsToCsv(report.rows), "utf8");

  const reviewRows = report.rows.filter((row) => row.status === "review-needed" || row.status === "collision-review");
  const cachePath = titleReviewWebCachePath();
  const webCache = readJson(cachePath, emptyTitleReviewWebCache());
  const sources = new Set(csvArg("sources", "local,musicbrainz,wikidata").map((source) => source.toLowerCase()));
  const webClient = createTitleReviewWebClient({
    cache: webCache,
    enabledSources: sources,
    delayMs: numberArg("musicbrainz-delay-ms", 1100),
    fetchImpl: fetch,
    wait: delay,
  });

  const suggestions = await buildTitleReviewSuggestions(reviewRows, {
    batchSize,
    existingRows: report.rows,
    sources,
    webClient,
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) console.log(`Review suggestions: ${done}/${total}`);
    },
  });

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    albumDir: relative(albumDir),
    batchSize,
    totalRows: suggestions.length,
    summary: summarizeTitleReviewSuggestions(suggestions),
    rows: suggestions,
  };

  await writeJson(titleReviewSuggestionsJsonPath(), output);
  await writeFile(titleReviewSuggestionsCsvPath(), titleReviewSuggestionsToCsv(suggestions), "utf8");
  webCache.generatedAt = new Date().toISOString();
  await writeJson(cachePath, webCache);

  console.log("Album title review suggestions");
  console.log(`- Review rows: ${suggestions.length.toLocaleString()}`);
  console.log(`- Batches: ${Math.ceil(suggestions.length / batchSize).toLocaleString()}`);
  console.log(`- High confidence: ${suggestions.filter((row) => row.confidence === "high").length.toLocaleString()}`);
  console.log(`- Medium confidence: ${suggestions.filter((row) => row.confidence === "medium").length.toLocaleString()}`);
  console.log(`- Low confidence: ${suggestions.filter((row) => row.confidence === "low").length.toLocaleString()}`);
  console.log(`- Skipped/collisions: ${suggestions.filter((row) => row.decision === "skip").length.toLocaleString()}`);
  console.log(`CSV written: ${relative(titleReviewSuggestionsCsvPath())}`);
  console.log(`JSON written: ${relative(titleReviewSuggestionsJsonPath())}`);
  console.log(`Web cache written: ${relative(cachePath)}`);
}

async function titleReviewApply() {
  await mkdir(albumDir, { recursive: true });

  const csvPath = titleReviewSuggestionsCsvPath();
  if (!existsSync(csvPath)) {
    throw new Error(`No title review suggestions CSV found. Run "bun run bard:title-review-suggest" first.`);
  }

  const batch = args.has("batch") ? Number(args.get("batch")) : 1;
  if (!Number.isInteger(batch) || batch < 1) throw new Error("--batch must be a positive integer.");

  const csvRows = parseCsv(readFileSync(csvPath, "utf8"));
  const approvedRows = csvRows
    .filter((row) => Number(row.batch) === batch)
    .filter((row) => ["approve", "edit"].includes(String(row.decision || "").trim().toLowerCase()));

  const renameRows = approvedRows.map((row) => titleReviewCsvRowToRename(row));
  const validation = validateTitleReviewApplyPlan(albumDir, renameRows);
  if (!validation.ok) {
    for (const error of validation.errors) console.error(`::error::${error}`);
    throw new Error("Title review apply plan is not safe.");
  }

  if (renameRows.length > 0) {
    const backup = {
      version: 1,
      generatedAt: new Date().toISOString(),
      albumDir: relative(albumDir),
      sourceCsv: relative(csvPath),
      batch,
      rows: renameRows.map((row) => ({
        rowId: row.rowId || null,
        sourceKey: row.sourceKey || null,
        currentFile: row.currentFile,
        proposedFile: row.proposedFile,
        decision: row.decision || null,
      })),
    };
    const backupPath = path.join(albumDir, `${TITLE_REVIEW_BACKUP_PREFIX}-${timestampForFile()}.json`);
    await writeJson(backupPath, backup);
    await applyTitleRenameRows(albumDir, renameRows);
    await updateTitleCleanupLedgers(albumDir, renameRows);
    await clearMetadataCache(albumDir);
    console.log(`Backup written: ${relative(backupPath)}`);
  }

  const refreshedReport = buildTitleCleanupReport(albumDir);
  await writeJson(titleCleanupReportPath(), refreshedReport);
  await writeFile(titleCleanupPlanPath(), titleCleanupRowsToCsv(refreshedReport.rows), "utf8");

  console.log("Album title review apply");
  console.log(`- Batch: ${batch}`);
  console.log(`- Approved/edited rows applied: ${renameRows.length.toLocaleString()}`);
  console.log(`- Remaining review rows: ${(refreshedReport.summary.reviewNeeded + refreshedReport.summary.collisionReview).toLocaleString()}`);
}

function buildTitleCleanupReport(dir, options = {}) {
  const ledgers = options.ledgers || loadTitleCleanupLedgers(dir);
  const rows = [];

  for (const file of listMidiFiles(dir)) {
    const buffer = readFileSync(file);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const currentFile = path.basename(file);
    const metadata = lookupTitleMetadata(currentFile, sha256, ledgers);
    rows.push(buildTitleCleanupRow(currentFile, sha256, metadata));
  }

  markTitleCleanupCollisions(rows);
  const summary = summarizeTitleCleanupRows(rows);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    albumDir: relative(dir),
    format: "Artist - Song.mid",
    policy: "Local-only report. Auto-rename only high-confidence artist/title metadata; review unclear rows manually.",
    summary,
    rows: rows.sort((a, b) => a.currentFile.localeCompare(b.currentFile)),
  };
}

function buildTitleCleanupRow(currentFile, sha256, metadata) {
  const notes = [];
  const reasons = [];
  const rawArtist = metadata?.artist || "";
  const rawTitle = metadata?.title || "";
  const artist = cleanTitlePiece(rawArtist);
  const title = cleanTitlePiece(rawTitle, { isTitle: true });

  if (!metadata) {
    reasons.push("no-ledger-metadata");
    notes.push("No local ledger entry matched this file by filename or hash.");
  } else {
    if (!artist) reasons.push("missing-artist");
    if (!title) reasons.push("missing-title");
    if (looksLikeJunkTitle(title)) reasons.push("junk-title");
    if (looksLikeJunkCredit(artist) || looksLikeNonArtistCredit(artist)) reasons.push("suspect-artist");
    if (artist && title && normalizeTitleKey(artist) === normalizeTitleKey(title)) reasons.push("duplicate-artist-title");
    if (hasUnrepairedMojibake(rawArtist, artist) || hasUnrepairedMojibake(rawTitle, title)) reasons.push("mojibake-review");
    if (looksLikeSwappedMetadata(artist, title)) reasons.push("possible-swapped-artist-title");
  }

  const proposedFile = reasons.length === 0 ? cleanTitleFilename(artist, title) : "";
  let status = "review-needed";
  let reason = reasons[0] || "review-needed";
  if (proposedFile) {
    if (currentFile === proposedFile) {
      status = "clean";
      reason = "already-clean";
    } else {
      status = "rename-ready";
      reason = "safe-ledger-title";
    }
  }

  return {
    currentFile,
    proposedFile,
    status,
    reason,
    sourceKey: metadata?.sourceKey || null,
    source: metadata?.ledgerSource || metadata?.source || null,
    sourceId: metadata?.sourceId ?? null,
    artist: artist || null,
    title: title || null,
    rawArtist: rawArtist || null,
    rawTitle: rawTitle || null,
    sourceWork: metadata?.sourceWork || null,
    arranger: metadata?.arranger || null,
    sha256,
    hash: sha256,
    confidenceNotes: notes.concat(reasons.slice(1)),
  };
}

function markTitleCleanupCollisions(rows) {
  const proposedGroups = groupBy(
    rows.filter((row) => row.proposedFile && (row.status === "rename-ready" || row.status === "clean")),
    (row) => row.proposedFile.toLowerCase()
  );
  for (const group of proposedGroups.filter((items) => items.length > 1)) {
    for (const row of group) {
      row.status = "collision-review";
      row.reason = "target-name-collision";
      row.confidenceNotes = [
        ...(row.confidenceNotes || []),
        `Target collides with: ${group.map((item) => item.currentFile).join(" | ")}`,
      ];
    }
  }

  const currentLower = new Map(rows.map((row) => [row.currentFile.toLowerCase(), row]));
  for (const row of rows) {
    if (!row.proposedFile || row.status !== "rename-ready") continue;
    const existing = currentLower.get(row.proposedFile.toLowerCase());
    if (existing && existing.currentFile.toLowerCase() !== row.currentFile.toLowerCase() && !existing.proposedFile) {
      row.status = "collision-review";
      row.reason = "target-exists-without-clean-metadata";
      row.confidenceNotes = [
        ...(row.confidenceNotes || []),
        `Target exists as unresolved file: ${existing.currentFile}`,
      ];
    }
  }

  const normalizedGroups = groupBy(
    rows
      .map((row) => ({
        row,
        key: normalizeAlbumAuditTitle(row.proposedFile || row.currentFile),
      }))
      .filter((item) => item.key),
    (item) => item.key
  );
  for (const group of normalizedGroups.filter((items) => items.length > 1)) {
    const names = group.map((item) => item.row.proposedFile || item.row.currentFile);
    for (const { row } of group) {
      if (row.status !== "rename-ready" && row.status !== "clean") continue;
      row.status = "collision-review";
      row.reason = "normalized-title-collision";
      row.confidenceNotes = [
        ...(row.confidenceNotes || []),
        `Album audit key collides with: ${names.join(" | ")}`,
      ];
    }
  }
}

function validateTitleApplyPlan(dir, rows) {
  const errors = [];
  const files = listMidiFiles(dir).map((file) => path.basename(file));
  const existing = new Set(files.map((file) => file.toLowerCase()));
  const moving = new Set(rows.map((row) => row.currentFile.toLowerCase()));
  const targets = new Map();

  for (const row of rows) {
    const source = path.join(dir, row.currentFile);
    if (!existsSync(source)) errors.push(`Missing source file: ${row.currentFile}`);
    if (!row.proposedFile || !/\.midi?$/i.test(row.proposedFile)) {
      errors.push(`Invalid target filename for ${row.currentFile}: ${row.proposedFile || "(empty)"}`);
    }

    const targetKey = String(row.proposedFile || "").toLowerCase();
    if (targets.has(targetKey)) {
      errors.push(`Duplicate target in apply plan: ${row.proposedFile}`);
    }
    targets.set(targetKey, row.currentFile);

    if (existing.has(targetKey) && !moving.has(targetKey) && targetKey !== row.currentFile.toLowerCase()) {
      errors.push(`Target already exists and is not part of the rename plan: ${row.proposedFile}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function applyTitleRenameRows(dir, rows) {
  const staged = [];
  const stamp = timestampForFile();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const source = path.join(dir, row.currentFile);
    const temp = path.join(dir, `.title-cleanup-${process.pid}-${stamp}-${index}.tmp`);
    await rename(source, temp);
    staged.push({ row, temp, target: path.join(dir, row.proposedFile) });
  }

  for (const item of staged) {
    await rename(item.temp, item.target);
  }
}

async function updateTitleCleanupLedgers(dir, rows, options = {}) {
  const renameMap = new Map(rows.map((row) => [row.currentFile, row.proposedFile]));
  const ledgerFiles = options.ledgerFiles || [ledgerPath, path.join(dir, MAINSTREAM_LEDGER_FILE)];
  for (const ledgerFile of ledgerFiles) {
    const ledger = readJson(ledgerFile, null);
    if (!ledger) continue;

    let changed = false;
    for (const entry of ledger.entries || []) {
      for (const key of ["albumFile", "localFile", "file", "filename"]) {
        if (entry[key] && renameMap.has(path.basename(entry[key]))) {
          const newName = renameMap.get(path.basename(entry[key]));
          entry[key] = entry[key].includes("/") || entry[key].includes("\\")
            ? path.join(path.dirname(entry[key]), newName).replaceAll(path.sep, "/")
            : newName;
          changed = true;
        }
      }
    }

    if (changed) {
      ledger.generatedAt = new Date().toISOString();
      ledger.titleCleanup = {
        appliedAt: ledger.generatedAt,
        renamedFiles: rows.length,
        format: "Artist - Song.mid",
      };
      if (ledgerFile === ledgerPath) ledger.summary = summarizeLedger(ledger);
      await writeJson(ledgerFile, ledger);
    }
  }
}

async function clearMetadataCache(dir) {
  const cachePath = path.join(dir, METADATA_CACHE_FILE);
  if (!existsSync(cachePath)) return;
  await unlink(cachePath);
}

function loadTitleCleanupLedgers(dir) {
  return {
    bard: indexTitleLedger(readJson(ledgerPath, null), "bard"),
    mainstream: indexTitleLedger(readJson(path.join(dir, MAINSTREAM_LEDGER_FILE), null), "mainstream"),
  };
}

function indexTitleLedger(ledger, ledgerSource) {
  const byFile = new Map();
  const byHash = new Map();
  for (const entry of ledger?.entries || []) {
    const metadata = normalizeTitleLedgerEntry(entry, ledgerSource);
    for (const name of metadata.fileNames) {
      if (name && !byFile.has(name.toLowerCase())) byFile.set(name.toLowerCase(), metadata);
    }
    if (metadata.sha256 && !byHash.has(metadata.sha256)) byHash.set(metadata.sha256, metadata);
  }
  return { byFile, byHash };
}

function normalizeTitleLedgerEntry(entry, ledgerSource) {
  const fileNames = uniqueStrings([
    entry.albumFile,
    entry.localFile,
    entry.file,
    entry.filename,
  ]).map((name) => path.basename(name));
  return {
    ledgerSource,
    fileNames,
    sourceKey: entry.sourceKey || (entry.bmpId ? `mainstream-bmp:${entry.bmpId}` : null),
    source: entry.source || null,
    sourceId: entry.sourceId ?? entry.bmpId ?? null,
    title: entry.title || null,
    artist: entry.artist || null,
    sourceWork: entry.sourceWork || (ledgerSource === "mainstream" ? entry.source : null),
    arranger: entry.arranger || null,
    sha256: entry.sha256 || null,
  };
}

function lookupTitleMetadata(currentFile, sha256, ledgers) {
  const key = currentFile.toLowerCase();
  return (
    ledgers.bard.byFile.get(key) ||
    ledgers.bard.byHash.get(sha256) ||
    ledgers.mainstream.byFile.get(key) ||
    ledgers.mainstream.byHash.get(sha256) ||
    null
  );
}

function cleanTitleFilename(artist, title) {
  const base = `${artist} - ${title}`;
  let value = base
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.)\]])/g, "$1")
    .trim()
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) value = `${value} Song`;
  if (value.length > 180) value = value.slice(0, 180).replace(/[. ]+$/g, "");
  return `${value || "Unknown Artist - Unknown Song"}.mid`;
}

function cleanTitlePiece(value, options = {}) {
  let text = repairCommonMojibake(String(value || ""))
    .normalize("NFC")
    .replace(/\.midi?$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (options.isTitle) {
    text = text
      .replace(/\s*\((?:solo|duet|solo[ _/-]*duet)\)\s*$/i, "")
      .replace(/\s*[-\u2013\u2014]\s*(?:solo|duet)\s*$/i, "")
      .trim();
  }

  return text;
}

function repairCommonMojibake(value) {
  return String(value || "")
    .replace(/\u00e2\u20ac[\u201c\u201d]/g, "-")
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u00e2\u20ac\u0153/g, '"')
    .replace(/\u00e2\u20ac\ufffd/g, '"')
    .replace(/\u00c3\u00a9/g, "\u00e9")
    .replace(/\u00c3\u00a8/g, "\u00e8")
    .replace(/\u00c3\u00a1/g, "\u00e1")
    .replace(/\u00c3\u00a0/g, "\u00e0")
    .replace(/\u00c3\u00ad/g, "\u00ed")
    .replace(/\u00c3\u00b3/g, "\u00f3")
    .replace(/\u00c3\u00ba/g, "\u00fa")
    .replace(/\u00c3\u00b1/g, "\u00f1")
    .replace(/\u00c3\u00b6/g, "\u00f6")
    .replace(/\u00c3\u00bc/g, "\u00fc")
    .replace(/\u00c3\u00a7/g, "\u00e7")
    .replace(/\u00c3\u2026/g, "\u00c5")
    .replace(/\u00c3\u02dc/g, "\u00d8");
}

function hasUnrepairedMojibake(rawValue, cleanedValue) {
  const raw = String(rawValue || "");
  if (!looksLikeMojibakeText(raw)) return false;
  return looksLikeMojibakeText(cleanedValue);
}

function looksLikeMojibakeText(value) {
  const text = String(value || "");
  if (/[\ufffd\u0080-\u009f\u00c2\u00c3\u00c5\u00e2]/.test(text)) return true;
  if (/[\u0192\u0152\u0160\u017d\u02dc\u201a\u2020\u2021\u2026\u2039\u203a\u20ac\u2122]/.test(text)) return true;
  const latin1Noise = [...text.matchAll(/[\u00a0-\u00bf\u00c0-\u00ff]/g)].length;
  const latin1SymbolNoise = [...text.matchAll(/[\u00a0-\u00bf]/g)].length;
  return latin1Noise >= 2 && latin1SymbolNoise > 0;
}

function looksLikeNonArtistCredit(value) {
  const text = String(value || "").toLowerCase();
  return (
    /random\s+midi|weird\s+.*website|used\s+the\s+tab|original\s+version|unknown|midi\s+file\s+submission/.test(text) ||
    /source\s*:|downloaded\s+from|converted\s+by|uploaded\s+by|\bsupreme\s+midi\b/.test(text)
  );
}

function looksLikeSwappedMetadata(artist, title) {
  const artistText = String(artist || "").toLowerCase();
  const titleTokens = tokenSet(title);
  if (titleTokens.size > 4) return false;
  return /\b(opening|ending|theme|tv size|radio edit|version|wasteland)\b/.test(artistText);
}

function summarizeTitleCleanupRows(rows) {
  return {
    totalFiles: rows.length,
    renameReady: rows.filter((row) => row.status === "rename-ready").length,
    clean: rows.filter((row) => row.status === "clean").length,
    reviewNeeded: rows.filter((row) => row.status === "review-needed").length,
    collisionReview: rows.filter((row) => row.status === "collision-review").length,
    byStatus: countBy(rows, (row) => row.status),
    byReason: countBy(rows, (row) => row.reason),
  };
}

function titleCleanupRowsToCsv(rows) {
  const headers = [
    "status",
    "reason",
    "currentFile",
    "proposedFile",
    "sourceKey",
    "artist",
    "title",
    "sourceWork",
    "arranger",
    "sha256",
    "confidenceNotes",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(Array.isArray(row[header]) ? row[header].join(" | ") : row[header])).join(",")),
  ].join("\n") + "\n";
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function titleCleanupReportPath() {
  return path.resolve(albumDir, args.get("report") || TITLE_CLEANUP_REPORT_FILE);
}

function titleCleanupPlanPath() {
  return path.resolve(albumDir, args.get("plan") || TITLE_CLEANUP_PLAN_FILE);
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function printTitleCleanupSummary(title, report) {
  console.log(title);
  console.log(`- Album dir: ${report.albumDir}`);
  console.log(`- Total MIDI files: ${report.summary.totalFiles.toLocaleString()}`);
  console.log(`- Rename ready: ${report.summary.renameReady.toLocaleString()}`);
  console.log(`- Already clean: ${report.summary.clean.toLocaleString()}`);
  console.log(`- Review needed: ${report.summary.reviewNeeded.toLocaleString()}`);
  console.log(`- Collision review: ${report.summary.collisionReview.toLocaleString()}`);
}

async function buildTitleReviewSuggestions(rows, options = {}) {
  const batchSize = options.batchSize || 50;
  const sources = options.sources || new Set(["local"]);
  const existingRows = options.existingRows || rows;
  const webClient = options.webClient || null;
  const suggestions = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let suggestion = buildLocalTitleReviewSuggestion(row);
    try {
      if (sources.has("musicbrainz") && webClient && shouldUseWebSuggestion(suggestion)) {
        suggestion = chooseBetterTitleSuggestion(suggestion, await webClient.musicbrainz(row, suggestion));
      }
      if (sources.has("wikidata") && webClient && shouldUseWebSuggestion(suggestion)) {
        suggestion = chooseBetterTitleSuggestion(suggestion, await webClient.wikidata(row, suggestion));
      }
    } catch (error) {
      suggestion = {
        ...suggestion,
        notes: [suggestion.notes, `Web lookup failed: ${error.message}`].filter(Boolean).join(" "),
      };
    }

    suggestions.push({
      batch: Math.floor(index / batchSize) + 1,
      rowId: titleReviewRowId(row),
      decision: row.status === "collision-review" ? "skip" : "",
      currentFile: row.currentFile,
      recommendedFile: suggestion.file || "",
      finalArtist: suggestion.artist || "",
      finalTitle: suggestion.title || "",
      finalFile: suggestion.file || "",
      confidence: suggestion.confidence || "none",
      reason: row.reason || "",
      evidenceSource: suggestion.source || "none",
      evidenceUrl: suggestion.url || "",
      query: suggestion.query || "",
      notes: suggestion.notes || "",
      sourceKey: row.sourceKey || "",
      sourceWork: row.sourceWork || "",
      arranger: row.arranger || "",
    });
    if (options.onProgress) options.onProgress(index + 1, rows.length);
  }

  markTitleReviewSuggestionCollisions(suggestions, existingRows);
  return suggestions;
}

function buildLocalTitleReviewSuggestion(row) {
  const parsed = parseTitleReviewFilename(row.currentFile);
  const cleanedArtist = cleanTitlePiece(row.artist || "");
  const cleanedTitle = cleanTitlePiece(row.title || "", { isTitle: true });
  const sourceWork = cleanTitlePiece(row.sourceWork || "");

  if (row.reason === "normalized-title-collision") {
    return titleSuggestion({
      confidence: "none",
      source: "collision-review",
      notes: "Existing clean title collides under album-audit normalization; edit manually or keep skipped.",
    });
  }

  if (row.reason === "possible-swapped-artist-title" && cleanedArtist && cleanedTitle) {
    return titleSuggestion({
      artist: cleanedTitle,
      title: cleanedArtist,
      confidence: "high",
      source: "local-swapped-metadata",
      notes: "Artist/title looked reversed in source metadata.",
    });
  }

  if (row.reason === "missing-artist" && sourceWork && cleanedTitle) {
    return titleSuggestion({
      artist: sourceWork,
      title: cleanedTitle,
      confidence: "low",
      source: "local-source-work",
      notes: "Missing artist; source work is used as the best local browsing label.",
    });
  }

  if (parsed?.artist && parsed?.title) {
    const parsedSuggestion = titleSuggestion({
      artist: parsed.artist,
      title: parsed.title,
      confidence: parsed.confidence || "medium",
      source: parsed.source,
      notes: parsed.notes,
    });
    if (row.reason === "no-ledger-metadata" || row.reason === "suspect-artist") return parsedSuggestion;
    if (!cleanedArtist || looksLikeNonArtistCredit(cleanedArtist)) return parsedSuggestion;
  }

  if (row.reason === "duplicate-artist-title" && sourceWork && cleanedTitle) {
    return titleSuggestion({
      artist: sourceWork,
      title: cleanedTitle,
      confidence: "medium",
      source: "local-source-work",
      notes: "Source metadata used the same value for artist and title; source work is the best local artist/search field.",
    });
  }

  if (cleanedArtist && cleanedTitle && !looksLikeNonArtistCredit(cleanedArtist) && !hasUnrepairedMojibake(row.rawArtist, cleanedArtist)) {
    return titleSuggestion({
      artist: cleanedArtist,
      title: cleanedTitle,
      confidence: row.reason === "mojibake-review" ? "low" : "medium",
      source: "local-ledger",
      notes: "Uses existing local ledger fields.",
    });
  }

  if (sourceWork && cleanedTitle) {
    return titleSuggestion({
      artist: sourceWork,
      title: cleanedTitle,
      confidence: "low",
      source: "local-source-work",
      notes: "Missing artist; source work is used as the best local browsing label.",
    });
  }

  if (parsed?.title) {
    return titleSuggestion({
      artist: parsed.artist || sourceWork || "",
      title: parsed.title,
      confidence: parsed.artist ? "medium" : "low",
      source: parsed.source,
      notes: parsed.notes || "Parsed from filename.",
    });
  }

  return titleSuggestion({
    confidence: "none",
    source: "none",
    notes: "No reliable local artist/title candidate found.",
  });
}

function parseTitleReviewFilename(filename) {
  const stem = path.basename(filename).replace(/\.midi?$/i, "");
  const cleanStem = repairCommonMojibake(stem).replace(/\s+/g, " ").trim();
  const stripSoloSuffix = (value) => cleanTitlePiece(value, { isTitle: true }).replace(/\s*-\s*solo\s*$/i, "").trim();

  let match = cleanStem.match(/^BMP Top Harp\s*-\s*\d+\s*-\s*(.+?)\s*-\s*Solo\s*-\s*.+$/i);
  if (match) {
    const pair = splitArtistTitlePair(match[1]);
    if (pair) return { ...pair, source: "filename-bmp-top-harp", confidence: "medium", notes: "Parsed from BMP Top Harp filename." };
  }

  match = cleanStem.match(/^Local BMP\s*-\s*\d+\s*-\s*(.+?)\s*-\s*(.+?)\s*-\s*Solo\s*-\s*.+$/i);
  if (match) {
    return {
      artist: cleanTitlePiece(match[1]),
      title: stripSoloSuffix(match[2]),
      source: "filename-local-bmp",
      confidence: "medium",
      notes: "Parsed from Local BMP filename.",
    };
  }

  match = cleanStem.match(/^Bard BMP\s*-\s*(.+?)\s*-\s*(.+?)\s*-\s*Solo\s*-\s*.+?\s*-\s*\d+$/i);
  if (match) {
    return {
      artist: cleanTitlePiece(match[1]),
      title: stripSoloSuffix(match[2]),
      source: "filename-bard-bmp",
      confidence: "medium",
      notes: "Parsed from Bard BMP filename.",
    };
  }

  match = cleanStem.match(/^WWM Reddit\s*-\s*(.+?)\s*-\s*(.+)$/i);
  if (match) {
    return {
      artist: cleanTitlePiece(match[1]),
      title: stripSoloSuffix(match[2]),
      source: "filename-wwm-reddit",
      confidence: "medium",
      notes: "Parsed from WWM Reddit filename.",
    };
  }

  const pair = splitArtistTitlePair(cleanStem);
  if (pair) return { ...pair, source: "filename-generic", confidence: "low", notes: "Parsed from generic Artist - Title filename." };
  return null;
}

function splitArtistTitlePair(value) {
  const text = cleanTitlePiece(value);
  const dashPair = text.match(/^(.+?)\s+-\s+(.+)$/);
  if (dashPair) {
    return { artist: cleanTitlePiece(dashPair[1]), title: cleanTitlePiece(dashPair[2], { isTitle: true }) };
  }
  const hyphenPair = text.match(/^([^-]{2,80})-(.+)$/);
  if (hyphenPair) {
    return { artist: cleanTitlePiece(hyphenPair[1]), title: cleanTitlePiece(hyphenPair[2], { isTitle: true }) };
  }
  return null;
}

function titleSuggestion({ artist = "", title = "", confidence = "none", source = "none", url = "", query = "", notes = "" } = {}) {
  const cleanArtist = cleanTitlePiece(artist);
  const cleanTitle = cleanTitlePiece(title, { isTitle: true });
  const file = cleanArtist && cleanTitle ? cleanTitleFilename(cleanArtist, cleanTitle) : "";
  return { artist: cleanArtist, title: cleanTitle, file, confidence, source, url, query, notes };
}

function chooseBetterTitleSuggestion(current, candidate) {
  if (!candidate?.file) return current;
  if (!current?.file) return candidate;
  return confidenceRank(candidate.confidence) > confidenceRank(current.confidence) ? candidate : current;
}

function confidenceRank(confidence) {
  return { none: 0, low: 1, medium: 2, high: 3 }[confidence] || 0;
}

function shouldUseWebSuggestion(suggestion) {
  return confidenceRank(suggestion?.confidence) < 3;
}

function markTitleReviewSuggestionCollisions(suggestions, existingRows) {
  const existingKeys = new Map();
  for (const row of existingRows || []) {
    const name = row.proposedFile || row.currentFile;
    if (!name) continue;
    const key = normalizeAlbumAuditTitle(name);
    if (key) existingKeys.set(key, row.currentFile);
  }

  const suggestionGroups = groupBy(suggestions.filter((row) => row.recommendedFile), (row) =>
    normalizeAlbumAuditTitle(row.finalFile || row.recommendedFile)
  );
  const collidingSuggestionKeys = new Set(
    suggestionGroups.filter((group) => group.length > 1).map((group) => normalizeAlbumAuditTitle(group[0].recommendedFile))
  );

  for (const row of suggestions) {
    if (!row.recommendedFile) continue;
    const key = normalizeAlbumAuditTitle(row.finalFile || row.recommendedFile);
    const existing = existingKeys.get(key);
    const currentKey = normalizeAlbumAuditTitle(row.currentFile);
    const collidesWithExisting = existing && key !== currentKey && existing !== row.currentFile;
    const collidesWithSuggestion = collidingSuggestionKeys.has(key);
    if (collidesWithExisting || collidesWithSuggestion) {
      row.decision = "skip";
      row.confidence = row.confidence === "high" ? "medium" : row.confidence;
      row.notes = [
        row.notes,
        collidesWithExisting ? `Collision with existing album title: ${existing}` : "",
        collidesWithSuggestion ? "Collision with another review suggestion." : "",
      ].filter(Boolean).join(" ");
    }
  }
}

function createTitleReviewWebClient({ cache, enabledSources, delayMs, fetchImpl, wait }) {
  let lastMusicBrainzRequestAt = 0;
  return {
    async musicbrainz(row, baseSuggestion) {
      if (!enabledSources.has("musicbrainz")) return null;
      const query = musicBrainzQuery(row, baseSuggestion);
      if (!query) return null;
      const cacheKey = `musicbrainz:${query}`;
      const cached = cache.entries?.[cacheKey];
      if (cached) return cached.suggestion || null;

      const elapsed = Date.now() - lastMusicBrainzRequestAt;
      if (lastMusicBrainzRequestAt && elapsed < delayMs) await wait(delayMs - elapsed);
      lastMusicBrainzRequestAt = Date.now();

      const url = new URL(MUSICBRAINZ_RECORDING_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("fmt", "json");
      url.searchParams.set("limit", "5");
      const data = await fetchJsonWithUserAgent(url, fetchImpl);
      const suggestion = musicBrainzSuggestionFromResponse(data, query);
      cache.entries[cacheKey] = { fetchedAt: new Date().toISOString(), query, suggestion };
      return suggestion;
    },

    async wikidata(row, baseSuggestion) {
      if (!enabledSources.has("wikidata")) return null;
      const query = wikidataQuery(row, baseSuggestion);
      if (!query) return null;
      const cacheKey = `wikidata:${createHash("sha1").update(query).digest("hex")}`;
      const cached = cache.entries?.[cacheKey];
      if (cached) return cached.suggestion || null;

      const url = new URL(WIKIDATA_SPARQL_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("format", "json");
      const data = await fetchJsonWithUserAgent(url, fetchImpl);
      const suggestion = wikidataSuggestionFromResponse(data, query);
      cache.entries[cacheKey] = { fetchedAt: new Date().toISOString(), query, suggestion };
      return suggestion;
    },
  };
}

function musicBrainzQuery(row, baseSuggestion) {
  const title = baseSuggestion?.title || cleanTitlePiece(row.title || parseTitleReviewFilename(row.currentFile)?.title || "", { isTitle: true });
  const artist = baseSuggestion?.artist || cleanTitlePiece(row.artist || parseTitleReviewFilename(row.currentFile)?.artist || "");
  if (!title) return "";
  const parts = [`recording:"${escapeLucene(title)}"`];
  if (artist && !looksLikeNonArtistCredit(artist)) parts.push(`artist:"${escapeLucene(artist)}"`);
  return parts.join(" AND ");
}

function musicBrainzSuggestionFromResponse(data, query) {
  const recordings = Array.isArray(data?.recordings) ? data.recordings : [];
  for (const recording of recordings) {
    const title = cleanTitlePiece(recording.title || "", { isTitle: true });
    const artist = cleanTitlePiece(recording["artist-credit"]?.map((credit) => credit.name).filter(Boolean).join(" & ") || "");
    if (!title || !artist) continue;
    const score = Number(recording.score || 0);
    return titleSuggestion({
      artist,
      title,
      confidence: score >= 90 ? "high" : score >= 70 ? "medium" : "low",
      source: "musicbrainz",
      url: recording.id ? `https://musicbrainz.org/recording/${recording.id}` : "",
      query,
      notes: `MusicBrainz score ${score || "n/a"}.`,
    });
  }
  return null;
}

function wikidataQuery(row, baseSuggestion) {
  const title = baseSuggestion?.title || cleanTitlePiece(row.title || parseTitleReviewFilename(row.currentFile)?.title || "", { isTitle: true });
  if (!title) return "";
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `
SELECT ?work ?workLabel ?artistLabel WHERE {
  ?work rdfs:label "${escapedTitle}"@en.
  OPTIONAL { ?work wdt:P175 ?performer. }
  OPTIONAL { ?work wdt:P86 ?composer. }
  BIND(COALESCE(?performer, ?composer) AS ?artist)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT 5`;
}

function wikidataSuggestionFromResponse(data, query) {
  const bindings = data?.results?.bindings || [];
  for (const binding of bindings) {
    const title = cleanTitlePiece(binding.workLabel?.value || "", { isTitle: true });
    const artist = cleanTitlePiece(binding.artistLabel?.value || "");
    if (!title || !artist || /^Q\d+$/.test(artist)) continue;
    return titleSuggestion({
      artist,
      title,
      confidence: "medium",
      source: "wikidata",
      url: binding.work?.value || "",
      query,
      notes: "Wikidata work match.",
    });
  }
  return null;
}

async function fetchJsonWithUserAgent(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      "user-agent": WEB_USER_AGENT,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return response.json();
}

function escapeLucene(value) {
  return String(value || "").replace(/(["\\])/g, "\\$1");
}

function summarizeTitleReviewSuggestions(rows) {
  return {
    rows: rows.length,
    byBatch: countBy(rows, (row) => String(row.batch)),
    byDecision: countBy(rows, (row) => row.decision || "blank"),
    byConfidence: countBy(rows, (row) => row.confidence || "none"),
    byEvidenceSource: countBy(rows, (row) => row.evidenceSource || "none"),
  };
}

function titleReviewSuggestionsToCsv(rows) {
  const headers = [
    "batch",
    "rowId",
    "decision",
    "currentFile",
    "recommendedFile",
    "finalArtist",
    "finalTitle",
    "finalFile",
    "confidence",
    "reason",
    "evidenceSource",
    "evidenceUrl",
    "query",
    "notes",
  ];
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
  ].join("\n") + "\n";
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  const pushValue = () => {
    row.push(value);
    value = "";
  };
  const pushRow = () => {
    if (row.length > 0 || value) {
      pushValue();
      rows.push(row);
      row = [];
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushValue();
    } else if (char === "\n") {
      pushRow();
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value || row.length > 0) pushRow();
  if (rows.length === 0) return [];
  const headers = rows.shift();
  return rows
    .filter((items) => items.some((item) => item !== ""))
    .map((items) => Object.fromEntries(headers.map((header, index) => [header, items[index] || ""])));
}

function titleReviewCsvRowToRename(row) {
  const decision = String(row.decision || "").trim().toLowerCase();
  const artist = cleanTitlePiece(row.finalArtist || "");
  const title = cleanTitlePiece(row.finalTitle || "", { isTitle: true });
  if (!cleanTitlePiece(row.finalFile || "") && (!artist || !title)) {
    throw new Error(`Approved row ${row.rowId || row.currentFile} needs finalArtist/finalTitle or finalFile.`);
  }
  const proposedFile = cleanTitlePiece(row.finalFile || "") ? sanitizeReviewFinalFile(row.finalFile) : cleanTitleFilename(artist, title);
  return {
    rowId: row.rowId,
    sourceKey: row.sourceKey || "",
    currentFile: row.currentFile,
    proposedFile,
    decision,
  };
}

function sanitizeReviewFinalFile(value) {
  const stem = cleanTitlePiece(String(value || "").replace(/\.midi?$/i, ""));
  if (!stem || !stem.includes(" - ")) throw new Error(`Final file must use Artist - Song format: ${value}`);
  return `${stem}.mid`;
}

function validateTitleReviewApplyPlan(dir, rows) {
  const baseValidation = validateTitleApplyPlan(dir, rows);
  const errors = [...baseValidation.errors];
  const existingRows = listMidiFiles(dir).map((file) => ({
    currentFile: path.basename(file),
    key: normalizeAlbumAuditTitle(path.basename(file)),
  }));
  const moving = new Set(rows.map((row) => row.currentFile.toLowerCase()));
  const targetKeys = new Map();

  for (const row of rows) {
    const key = normalizeAlbumAuditTitle(row.proposedFile);
    if (!key) errors.push(`Invalid normalized target for ${row.currentFile}`);
    if (targetKeys.has(key)) errors.push(`Duplicate normalized target in apply plan: ${row.proposedFile}`);
    targetKeys.set(key, row.currentFile);

    for (const existing of existingRows) {
      if (existing.key !== key) continue;
      if (existing.currentFile.toLowerCase() === row.currentFile.toLowerCase()) continue;
      if (moving.has(existing.currentFile.toLowerCase())) continue;
      errors.push(`Target would collide under album audit normalization: ${row.proposedFile} with ${existing.currentFile}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function titleReviewSuggestionsCsvPath() {
  return path.resolve(albumDir, args.get("review-csv") || TITLE_REVIEW_SUGGESTIONS_CSV_FILE);
}

function titleReviewSuggestionsJsonPath() {
  return path.resolve(albumDir, args.get("review-json") || TITLE_REVIEW_SUGGESTIONS_JSON_FILE);
}

function titleReviewWebCachePath() {
  return path.resolve(albumDir, args.get("web-cache") || TITLE_REVIEW_WEB_CACHE_FILE);
}

function titleReviewRowId(row) {
  const base = row.sourceKey || row.sha256 || row.currentFile;
  return createHash("sha1").update(String(base)).digest("hex").slice(0, 12);
}

function emptyTitleReviewWebCache() {
  return {
    version: 1,
    generatedAt: null,
    entries: {},
  };
}

async function quarantineFile(file, reason) {
  const quarantineRoot = path.resolve(path.dirname(albumDir), "album-quarantine");
  await mkdir(quarantineRoot, { recursive: true });
  const base = sanitizeFileName(path.basename(file).replace(/\.midi?$/i, ""));
  let target = path.join(quarantineRoot, `${base}.mid`);
  let counter = 2;
  while (existsSync(target)) {
    target = path.join(quarantineRoot, `${base} (${counter}).mid`);
    counter += 1;
  }
  await rename(file, target);
  console.warn(`::warning::Quarantined ${path.basename(file)}: ${reason}`);
  return target;
}

function buildFfxivBardQueries() {
  const queries = [];
  const ensembleSize = args.get("ensemble-size") ?? args.get("ensembleSize") ?? "0";
  const instrument = args.get("instrument");
  const focusedGenres = boolArg("focused-genres", false);
  const sorts = csvArg("sort", focusedGenres ? "downloads_high,rating_high" : "downloads_high");
  const genres = focusedGenres ? FFXIV_FOCUSED_GENRES : csvArg("genre", args.get("genre") || "-1");

  for (const sort of sorts) {
    const params = { ensembleSize, sort };
    if (instrument) params.instrument = instrument;
    queries.push({
      label: `ensemble=${ensembleSize}, sort=${sort}`,
      params,
    });
  }

  for (const genre of genres) {
    if (!genre || genre === "-1") continue;
    for (const sort of sorts) {
      const params = { ensembleSize, sort, genre };
      if (instrument) params.instrument = instrument;
      queries.push({
        label: `${FFXIV_GENRE_NAMES[genre] || `genre ${genre}`}, sort=${sort}`,
        params,
      });
    }
  }

  const seen = new Set();
  return queries.filter((query) => {
    const key = JSON.stringify(query.params);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseFfxivBardCards(html, query) {
  const records = [];
  const cardPattern = /<a\b(?=[^>]*class="[^"]*\bsong-card\b)[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of html.matchAll(cardPattern)) {
    const card = match[0];
    const href = attr(card, "href") || "";
    const id = href.match(/\/song\/(\d+)/)?.[1];
    if (!id) continue;

    const title = htmlDecode(
      attr(card.match(/<h2\b[\s\S]*?<\/h2>/i)?.[0] || "", "title") ||
        stripTags(card.match(/<h2\b[\s\S]*?<\/h2>/i)?.[0] || "")
    );
    const subtitle = htmlDecode(
      attr(card.match(/song-card__subtitle[\s\S]*?<\/p>/i)?.[0] || "", "title") ||
        stripTags(card.match(/song-card__subtitle[\s\S]*?<\/p>/i)?.[0] || "")
    ).replace(/^Arranged by\s+/i, "");
    const ensemble = htmlDecode(
      stripTags(card.match(/<span\b[^>]*class="[^"]*\bensemble-badge\b[^"]*"[^>]*>[\s\S]*?<\/span>/i)?.[0] || "")
    );
    const genre = cardMeta(card, "Genre");
    const instrumentText = cardMeta(card, "Instruments");
    const instruments = instrumentText === "N/A" ? [] : splitList(instrumentText);
    const rating = numberFromText(stripTags(card.match(/rating-chip[\s\S]*?<\/span>/i)?.[0] || ""));
    const downloads = numberFromText(
      stripTags(card.match(/fa-arrow-circle-down[\s\S]*?<\/span>/i)?.[0] || "")
    );
    const comments = numberFromText(stripTags(card.match(/fa-comment[\s\S]*?<\/span>/i)?.[0] || ""));
    const arrangerParts = parseFfxivSubtitle(subtitle);

    const record = {
      key: `ffxivbard:${id}`,
      source: "ffxivbard",
      sourceName: "FFXIV-Bard",
      sourceId: Number(id),
      title: title.trim(),
      artist: arrangerParts.artist,
      arranger: arrangerParts.arranger,
      sourceWork: genre || null,
      ensemble: ensemble || null,
      instruments,
      trackCount: null,
      durationMs: null,
      durationText: null,
      downloads,
      rating,
      comments,
      detailUrl: absoluteUrl(href, FFXIV_BARD_BASE),
      downloadUrl: `${FFXIV_BARD_BASE}/song/download/${id}?disposition=attachment`,
      originalSourceUrl: null,
      filename: null,
      notes: null,
      discoveryTags: ["ffxivbard", query.label],
      discoveredAt: new Date().toISOString(),
    };
    record.qualityScore = qualityScore(record);
    records.push(record);
  }
  return records;
}

function parseFfxivSubtitle(subtitle) {
  const trimmed = String(subtitle || "").trim();
  const paren = trimmed.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (paren) {
    return {
      artist: cleanOptional(paren[1]),
      arranger: cleanOptional(paren[2]),
    };
  }
  return {
    artist: null,
    arranger: cleanOptional(trimmed),
  };
}

function sanitizeBmpRecord(doc) {
  const instruments = uniqueStrings([
    ...(Array.isArray(doc.instruments) ? doc.instruments.map((item) => item?.name) : []),
    ...(Array.isArray(doc.tracks) ? doc.tracks.map((item) => item?.instrument || item?.name) : []),
  ]);
  const durationMs = Number(doc.songDurationMs || 0) || parseDurationToMs(doc.duration);
  const record = {
    key: `bmp:${doc.id}`,
    source: "bmp",
    sourceName: "Bard Music Player",
    sourceId: Number(doc.id),
    title: cleanOptional(doc.title),
    artist: cleanOptional(doc.artist),
    arranger: cleanOptional(doc.arranger),
    sourceWork: cleanOptional(doc.source),
    ensemble: cleanOptional(doc.ensembleSize),
    instruments,
    trackCount: Number.isFinite(Number(doc.trackCount)) ? Number(doc.trackCount) : null,
    durationMs,
    durationText: doc.duration || (durationMs ? formatDurationMs(durationMs) : null),
    downloads: Number.isFinite(Number(doc.downloads)) ? Number(doc.downloads) : null,
    rating: null,
    detailUrl: `${BMP_BASE}/api/midis/${doc.id}?depth=1`,
    downloadUrl: absoluteUrl(doc.url, BMP_BASE),
    originalSourceUrl: cleanOptional(doc.originalSourceUrl),
    importedFrom: cleanOptional(doc.importedFrom),
    md5: cleanOptional(doc.md5),
    filename: cleanOptional(doc.filename),
    fileSize: Number.isFinite(Number(doc.filesize)) ? Number(doc.filesize) : null,
    notes: truncate(cleanOptional(doc.notes), 800),
    discoveryTags: ["bmp"],
    discoveredAt: new Date().toISOString(),
  };
  record.qualityScore = qualityScore(record);
  return record;
}

function annotateDiscovery(record, existingIndex) {
  const reasons = [];
  if (!record.downloadUrl) reasons.push("missing-download-url");
  if (looksLikeJunkRecord(record)) reasons.push("junk-metadata");
  if (record.durationMs && record.durationMs < 90_000) reasons.push("shorter-than-90-seconds");
  if (record.durationMs && record.durationMs > 720_000) reasons.push("longer-than-12-minutes");
  if (findLikelyTitleDuplicate(record, existingIndex)) reasons.push("probable-title-duplicate");
  if (record.source === "bmp" && record.md5 && existingIndex.bySourceMd5.has(record.md5)) {
    reasons.push("known-source-md5-duplicate");
  }
  record.discoveryStatus = reasons.length === 0 ? "candidate" : "skipped";
  record.discoveryReasons = reasons;
  record.qualityScore = qualityScore(record);
}

function preDownloadSkipReasons(record, existingIndex, ledgerKeySet, minSeconds, maxSeconds) {
  const reasons = [];
  if (!record.downloadUrl) reasons.push("missing-download-url");
  if (looksLikeJunkRecord(record)) reasons.push("junk-metadata");
  if (ledgerKeySet.has(record.key)) reasons.push("already-in-ledger");
  if (record.durationMs && record.durationMs < minSeconds * 1000) reasons.push("too-short");
  if (record.durationMs && record.durationMs > maxSeconds * 1000) reasons.push("too-long");
  if (findLikelyTitleDuplicate(record, existingIndex)) reasons.push("title-duplicate");
  if (record.source === "bmp" && record.md5 && existingIndex.bySourceMd5.has(record.md5)) {
    reasons.push("source-md5-duplicate");
  }
  return reasons;
}

function normalizeSkipReason(reason) {
  if (reason === "shorter-than-90-seconds") return "too-short";
  if (reason === "longer-than-12-minutes") return "too-long";
  if (reason === "known-source-md5-duplicate") return "source-md5-duplicate";
  if (reason === "probable-title-duplicate") return "title-duplicate";
  return reason;
}

function classifyDownloadOrValidationError(message) {
  const value = String(message || "").toLowerCase();
  if (value.includes("standard midi")) return "invalid-midi";
  if (value.includes("no playable note")) return "no-note-events";
  if (value.includes("too short")) return "too-short";
  if (value.includes("too long")) return "too-long";
  if (value.includes("note density")) return "too-dense";
  if (value.includes("pitch range")) return "wide-pitch-range";
  return "download-failed";
}

function verifyActiveAlbumIntegrity(options) {
  const rows = [];
  const errors = [];
  for (const file of listMidiFiles(albumDir)) {
    try {
      const buffer = readFileSync(file);
      const validation = validateMidiBuffer(buffer, options);
      rows.push({
        file,
        relativePath: path.relative(albumDir, file).replaceAll(path.sep, "/"),
        sha256: createHash("sha256").update(buffer).digest("hex"),
        titleKey: normalizeTitleKey(path.basename(file)),
        validation,
      });
    } catch (error) {
      errors.push(`${path.basename(file)}: ${error.message}`);
    }
  }

  const exactDuplicateGroups = groupBy(rows, (row) => row.sha256).filter((group) => group.length > 1);
  const titleDuplicateGroups = groupBy(rows, (row) => row.titleKey).filter((group) => group.length > 1);
  for (const group of exactDuplicateGroups) {
    errors.push(`Exact duplicate ${group[0].sha256}: ${group.map((row) => row.relativePath).join(" | ")}`);
  }
  for (const group of titleDuplicateGroups) {
    errors.push(`Normalized duplicate ${group[0].titleKey}: ${group.map((row) => row.relativePath).join(" | ")}`);
  }
  return { ok: errors.length === 0, errors, rows };
}

function validateMidiBuffer(buffer, options) {
  if (buffer.length < 14 || buffer.slice(0, 4).toString("ascii") !== "MThd") {
    throw new Error("Downloaded file is not a Standard MIDI file.");
  }

  const parsed = parseMidi(Buffer.from(buffer));
  const ticksPerBeat = parsed.header?.ticksPerBeat || 480;
  const analysis = analyzeMidi(parsed, ticksPerBeat);
  const durationSeconds = Math.max(0.001, analysis.durationSeconds);
  const notesPerSecond = analysis.noteCount / durationSeconds;
  const pitchRange = analysis.maxNote === null ? 0 : analysis.maxNote - analysis.minNote;

  if (analysis.noteCount <= 0) throw new Error("MIDI has no playable note events.");
  if (durationSeconds < options.minSeconds) {
    throw new Error(`MIDI is too short (${formatDurationMs(durationSeconds * 1000)}).`);
  }
  if (durationSeconds > options.maxSeconds) {
    throw new Error(`MIDI is too long (${formatDurationMs(durationSeconds * 1000)}).`);
  }
  if (notesPerSecond > options.maxNotesPerSecond) {
    throw new Error(`MIDI note density is too high (${notesPerSecond.toFixed(1)} notes/sec).`);
  }
  if (pitchRange > 96) {
    throw new Error(`MIDI pitch range is unusually wide (${pitchRange} semitones).`);
  }

  return {
    ok: true,
    format: parsed.header?.format ?? null,
    trackCount: parsed.tracks?.length ?? 0,
    ticksPerBeat,
    durationTicks: analysis.durationTicks,
    durationMs: Math.round(durationSeconds * 1000),
    noteCount: analysis.noteCount,
    notesPerSecond: Number(notesPerSecond.toFixed(2)),
    minNote: analysis.minNote,
    maxNote: analysis.maxNote,
    pitchRange,
    playableTrackCount: analysis.playableTrackCount,
    bestTrack: analysis.bestTrack,
  };
}

function analyzeMidi(parsed, ticksPerBeat) {
  let tempo = 500000;
  let maxSeconds = 0;
  let maxTick = 0;
  let noteCount = 0;
  let minNote = null;
  let maxNote = null;
  const trackSummaries = [];

  for (const [trackIndex, track] of parsed.tracks.entries()) {
    let tick = 0;
    let seconds = 0;
    let trackNotes = 0;
    let trackMin = null;
    let trackMax = null;

    for (const event of track) {
      const delta = event.deltaTime || 0;
      seconds += ticksToSeconds(delta, ticksPerBeat, tempo);
      tick += delta;
      if (event.type === "setTempo" && event.microsecondsPerBeat) {
        tempo = event.microsecondsPerBeat;
      }
      if (event.type === "noteOn" && (event.velocity ?? 0) > 0) {
        noteCount += 1;
        trackNotes += 1;
        minNote = minNote === null ? event.noteNumber : Math.min(minNote, event.noteNumber);
        maxNote = maxNote === null ? event.noteNumber : Math.max(maxNote, event.noteNumber);
        trackMin = trackMin === null ? event.noteNumber : Math.min(trackMin, event.noteNumber);
        trackMax = trackMax === null ? event.noteNumber : Math.max(trackMax, event.noteNumber);
      }
    }

    maxSeconds = Math.max(maxSeconds, seconds);
    maxTick = Math.max(maxTick, tick);
    if (trackNotes > 0) {
      trackSummaries.push({
        trackIndex,
        noteCount: trackNotes,
        minNote: trackMin,
        maxNote: trackMax,
        pitchRange: trackMax - trackMin,
      });
    }
  }

  const bestTrack = trackSummaries.sort((a, b) => b.noteCount - a.noteCount)[0] || null;
  return {
    durationSeconds: maxSeconds,
    durationTicks: maxTick,
    noteCount,
    minNote,
    maxNote,
    playableTrackCount: trackSummaries.length,
    bestTrack,
  };
}

function ticksToSeconds(ticks, ticksPerBeat, microsecondsPerBeat) {
  return (ticks / ticksPerBeat) * (microsecondsPerBeat / 1_000_000);
}

function buildExistingIndex(dir) {
  const index = {
    byHash: new Map(),
    byTitleKey: new Map(),
    byAlbumAuditKey: new Map(),
    tokenRows: [],
    bySourceMd5: new Set(),
  };
  for (const file of listMidiFiles(dir)) {
    const buffer = readFileSync(file);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    addExistingFile(index, file, buffer, null, sha256);
  }
  for (const ledgerName of [DEFAULT_LEDGER_FILE, ".local-mainstream-midi-ledger.json"]) {
    const ledger = readJson(path.join(dir, ledgerName), null);
    for (const entry of ledger?.entries || []) {
      if (entry.md5) index.bySourceMd5.add(entry.md5);
      if (entry.sourceMd5) index.bySourceMd5.add(entry.sourceMd5);
    }
  }
  return index;
}

function addExistingFile(index, file, buffer, record, sha256) {
  const name = path.basename(file);
  const titleKey = normalizeTitleKey(record ? `${record.artist || ""} ${record.title || ""}` : name);
  const filenameKey = normalizeTitleKey(name);
  const albumAuditKey = normalizeAlbumAuditTitle(record ? baseAlbumFilename(record) : name);
  const tokens = tokenSet(record ? `${record.artist || ""} ${record.title || ""}` : name);
  const filenameTokens = tokenSet(name);
  const row = { file, titleKey, filenameKey, albumAuditKey, tokens, filenameTokens };
  index.byHash.set(sha256 || createHash("sha256").update(buffer).digest("hex"), row);
  if (!index.byTitleKey.has(titleKey)) index.byTitleKey.set(titleKey, row);
  if (!index.byTitleKey.has(filenameKey)) index.byTitleKey.set(filenameKey, row);
  if (albumAuditKey && !index.byAlbumAuditKey.has(albumAuditKey)) index.byAlbumAuditKey.set(albumAuditKey, row);
  index.tokenRows.push(row);
}

function findLikelyTitleDuplicate(record, existingIndex) {
  const titleKey = normalizeTitleKey(`${record.artist || ""} ${record.title || ""}`);
  const bareTitleKey = normalizeTitleKey(record.title || "");
  const albumAuditKey = normalizeAlbumAuditTitle(baseAlbumFilename(record));
  if (albumAuditKey && existingIndex.byAlbumAuditKey?.has(albumAuditKey)) {
    return existingIndex.byAlbumAuditKey.get(albumAuditKey);
  }
  if (titleKey && existingIndex.byTitleKey.has(titleKey)) return existingIndex.byTitleKey.get(titleKey);
  if (bareTitleKey && existingIndex.byTitleKey.has(bareTitleKey)) return existingIndex.byTitleKey.get(bareTitleKey);

  const recordTokens = tokenSet(`${record.artist || ""} ${record.title || ""}`);
  const titleTokens = tokenSet(record.title || "");
  for (const row of existingIndex.tokenRows) {
    if (isMeaningfulSubset(recordTokens, row.filenameTokens)) return row;
    if (isMeaningfulSubset(titleTokens, row.filenameTokens)) return row;
  }
  return null;
}

function isMeaningfulSubset(candidateTokens, filenameTokens) {
  const tokens = [...candidateTokens].filter((token) => !GENERIC_SINGLE_TOKENS.has(token));
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0].length < 5) return false;
  return tokens.every((token) => filenameTokens.has(token));
}

function normalizeTitleKey(value) {
  return [...tokenSet(value)].sort().join(" ");
}

function normalizeAlbumAuditTitle(filename) {
  let value = path.basename(filename).replace(/\.midi?$/i, "");
  value = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  value = value
    .replace(/^(wwm reddit|planned pd-cc|free pd-cc0|user test)\s*-\s*/i, "")
    .replace(/^bmp top harp\s*-\s*\d+\s*-\s*/i, "")
    .replace(/\s*-\s*solo\s*-\s*.*$/i, "")
    .replace(/\s*\(solo\)\s*$/i, "")
    .replace(/\b(main theme|opening|op|ost|piano|midi|mid|solo|lofi|original|download)\b/g, " ")
    .replace(/[_+|/\\()[\]{}:;'"!?.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = value.split(" ").filter(Boolean);
  const stopWords = new Set(["the", "a", "an", "and", "of", "to", "from"]);
  return [...new Set(tokens.filter((token) => !stopWords.has(token)))].sort().join(" ");
}

function tokenSet(value) {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "and",
    "of",
    "to",
    "from",
    "in",
    "for",
    "with",
    "solo",
    "midi",
    "mid",
    "download",
    "original",
    "ost",
    "op",
    "main",
    "theme",
    "bmp",
    "bard",
    "local",
    "ffxiv",
    "ffxivbard",
    "harp",
    "lute",
    "piano",
  ]);
  return new Set(
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\.midi?$/i, "")
      .replace(/\[[^\]]*]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token && !stopWords.has(token))
  );
}

function qualityScore(record) {
  let score = 0;
  if (normalizeWord(record.ensemble) === "solo") score += 200;
  if (record.trackCount === 1) score += 80;
  if (record.durationMs && record.durationMs >= 90_000 && record.durationMs <= 720_000) score += 80;
  if (instrumentFit(record)) score += 120;
  if (record.downloads) score += Math.log10(record.downloads + 1) * 35;
  if (record.rating) score += record.rating * 18;
  if (record.source === "bmp") score += 40;
  if (record.source === "ffxivbard") score += 20;
  return Number(score.toFixed(2));
}

function instrumentFit(record) {
  const text = [
    ...(record.instruments || []),
    record.notes || "",
    record.filename || "",
    record.title || "",
  ]
    .join(" ")
    .toLowerCase();
  return [...FIT_INSTRUMENTS].some((instrument) => text.includes(instrument));
}

function looksLikeJunkTitle(title) {
  const text = String(title || "").trim().toLowerCase();
  if (!text) return true;
  if (/^(asd|asdf|test|testing|untitled|unknown|123+|qwe|qwer|song)$/i.test(text)) return true;
  if (/^(asd|qwe|zxc){2,}$/i.test(text.replace(/\s+/g, ""))) return true;
  const letters = [...text.matchAll(/\p{L}/gu)].length;
  const digits = [...text.matchAll(/\p{N}/gu)].length;
  if (letters < 3) return true;
  return digits > 0 && digits >= letters * 2;
}

function looksLikeJunkRecord(record) {
  if (looksLikeJunkTitle(record.title)) return true;
  if (record.source !== "ffxivbard") return false;
  return [record.artist, record.arranger].some((value) => looksLikeJunkCredit(value));
}

function looksLikeJunkCredit(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || /^-+$/.test(text)) return false;
  if (/^(asd|asdf|test|testing|untitled|unknown|123+|qwe|qwer|nie wiem|niewiem)$/i.test(text)) return true;
  if (/^(asd|qwe|zxc){2,}$/i.test(text.replace(/\s+/g, ""))) return true;
  const letters = [...text.matchAll(/\p{L}/gu)].length;
  const digits = [...text.matchAll(/\p{N}/gu)].length;
  return letters < 3 || (digits > 0 && digits >= letters * 2);
}

function uniqueAlbumFilename(dir, record) {
  const base = sanitizeFileName(baseAlbumFilename(record).replace(/\.mid$/i, ""));
  let name = `${base}.mid`;
  let counter = 2;
  while (existsSync(path.join(dir, name))) {
    name = `${base} (${counter}).mid`;
    counter += 1;
  }
  return name;
}

function baseAlbumFilename(record) {
  const prefix = record.source === "bmp" ? "Bard BMP" : "Bard FFXIV";
  const pieces = [
    prefix,
    record.artist,
    record.title,
    titleCase(record.ensemble || "solo"),
    record.arranger,
    String(record.sourceId),
  ].filter(Boolean);
  return `${pieces.join(" - ")}.mid`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  return response.text();
}

async function fetchMidi(url) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "audio/midi,application/octet-stream,*/*" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`MIDI download failed with ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function listMidiFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (/\.midi?$/i.test(name)) files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function emptyCatalog() {
  return {
    version: 1,
    generatedAt: null,
    notes: "Local-only catalog for Bard Music Player and FFXIV-Bard discovery. Do not commit downloaded MIDI files.",
    records: [],
    stats: {},
  };
}

function emptyLedger() {
  return {
    version: 1,
    generatedAt: null,
    albumDir: relative(albumDir),
    notes: "Local-only source ledger for ignored runtime MIDI files.",
    entries: [],
    rejections: [],
    summary: {},
  };
}

function catalogMap(catalog) {
  const map = new Map();
  for (const record of catalog.records || []) {
    if (record?.key) map.set(record.key, record);
  }
  return map;
}

function mergeRecord(previous, next) {
  return {
    ...previous,
    ...next,
    discoveryTags: uniqueStrings([...(previous.discoveryTags || []), ...(next.discoveryTags || [])]),
    firstDiscoveredAt: previous.firstDiscoveredAt || previous.discoveredAt || next.discoveredAt,
    discoveredAt: next.discoveredAt,
  };
}

function sortCatalogRecords(a, b) {
  return (b.qualityScore || 0) - (a.qualityScore || 0) || String(a.key).localeCompare(String(b.key));
}

function summarizeCatalog(records) {
  return {
    total: records.length,
    bySource: countBy(records, (record) => record.source),
    byEnsemble: countBy(records, (record) => normalizeWord(record.ensemble) || "unknown"),
    byDiscoveryStatus: countBy(records, (record) => record.discoveryStatus || "unknown"),
    topInstruments: topCounts(records.flatMap((record) => record.instruments || []), 20),
  };
}

function summarizeLedger(ledger) {
  const { accepted, rejected, resolved } = buildResolvedSourceKeySets(ledger);
  return {
    entries: (ledger.entries || []).length,
    rejections: (ledger.rejections || []).length,
    acceptedSourceKeys: accepted.size,
    rejectedSourceKeys: rejected.size,
    resolvedSourceKeys: resolved.size,
    bySource: countBy(ledger.entries || [], (entry) => entry.source),
    byEnsemble: countBy(ledger.entries || [], (entry) => normalizeWord(entry.ensemble) || "unknown"),
    batches: (ledger.batches || []).length,
  };
}

function buildResolvedSourceKeySets(ledger) {
  const accepted = new Set((ledger.entries || []).map((entry) => entry.sourceKey).filter(Boolean));
  const rejected = new Set((ledger.rejections || []).map((entry) => entry.sourceKey).filter(Boolean));
  return {
    accepted,
    rejected,
    resolved: new Set([...accepted, ...rejected]),
  };
}

function buildAuditStatus(records, ledger, options = {}) {
  const sourceFilter = (options.sourceFilter || ["all"]).map((value) => String(value).toLowerCase());
  const scopedRecords = (records || []).filter(
    (record) => sourceFilter.includes("all") || sourceFilter.includes(String(record.source).toLowerCase())
  );
  const { accepted, rejected, resolved } = buildResolvedSourceKeySets(ledger);
  const pending = scopedRecords.filter((record) => !resolved.has(record.key));
  return {
    catalogRecords: scopedRecords.length,
    acceptedRecords: scopedRecords.filter((record) => accepted.has(record.key)).length,
    rejectedRecords: scopedRecords.filter((record) => rejected.has(record.key)).length,
    resolvedRecords: scopedRecords.filter((record) => resolved.has(record.key)).length,
    pendingRecords: pending.length,
    pendingBySource: countBy(pending, (record) => record.source),
    pendingByDiscoveryStatus: countBy(pending, (record) => record.discoveryStatus || "unknown"),
    acceptedBySource: countBy(scopedRecords.filter((record) => accepted.has(record.key)), (record) => record.source),
    rejectedBySource: countBy(scopedRecords.filter((record) => rejected.has(record.key)), (record) => record.source),
  };
}

function selectPendingAuditRecords(records, ledger, options = {}) {
  const sourceFilter = (options.sourceFilter || ["bmp"]).map((value) => String(value).toLowerCase());
  const includeEnsembles = Boolean(options.includeEnsembles);
  const { resolved } = buildResolvedSourceKeySets(ledger);
  return (records || [])
    .filter((record) => sourceFilter.includes("all") || sourceFilter.includes(String(record.source).toLowerCase()))
    .filter((record) => includeEnsembles || normalizeWord(record.ensemble) === "solo")
    .filter((record) => !resolved.has(record.key))
    .sort(sortCatalogRecords);
}

function printDiscoverySummary(title, records, extra) {
  const stats = summarizeCatalog(records);
  console.log(title);
  console.log(`- Fetched this run: ${extra.fetched.toLocaleString()}`);
  console.log(`- Added/updated: ${extra.added.toLocaleString()} / ${extra.updated.toLocaleString()}`);
  console.log(`- Catalog records for source: ${records.length.toLocaleString()}`);
  console.log(`- By ensemble: ${formatCounts(stats.byEnsemble)}`);
  console.log(`- By status: ${formatCounts(stats.byDiscoveryStatus)}`);
  console.log(`- Top instruments: ${stats.topInstruments.map(([key, count]) => `${key}=${count}`).join(", ") || "n/a"}`);
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function topCounts(values, limit) {
  return Object.entries(countBy(values.filter(Boolean), (value) => value))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ") || "n/a";
}

function upsertLedgerEntry(ledger, entry) {
  const entries = ledger.entries || [];
  const index = entries.findIndex((item) => item.sourceKey === entry.sourceKey || item.sha256 === entry.sha256);
  if (index >= 0) entries[index] = { ...entries[index], ...entry };
  else entries.push(entry);
  ledger.entries = entries.sort((a, b) => String(a.albumFile).localeCompare(String(b.albumFile)));
}

function ledgerEntryForDownload(record, albumFile, sha256, buffer, validation) {
  return {
    sourceKey: record.key,
    source: record.source,
    sourceId: record.sourceId,
    title: record.title,
    artist: record.artist || null,
    arranger: record.arranger || null,
    sourceWork: record.sourceWork || null,
    ensemble: record.ensemble || null,
    instruments: record.instruments || [],
    durationMs: validation.durationMs,
    durationText: formatDurationMs(validation.durationMs),
    downloads: record.downloads ?? null,
    rating: record.rating ?? null,
    detailUrl: record.detailUrl,
    downloadUrl: record.downloadUrl,
    originalSourceUrl: record.originalSourceUrl || null,
    sourceMd5: record.md5 || null,
    albumFile,
    sha256,
    fileSize: buffer.length,
    validation,
    downloadedAt: new Date().toISOString(),
  };
}

function appendLedgerRejections(ledger, rejections) {
  const existing = ledger.rejections || [];
  const byKey = new Map();
  for (const item of existing) {
    byKey.set(rejectionIdentity(item), item);
  }
  for (const item of rejections.filter(Boolean)) {
    byKey.set(rejectionIdentity(item), { ...byKey.get(rejectionIdentity(item)), ...item });
  }
  ledger.rejections = [...byKey.values()].sort((a, b) => {
    const aKey = a.sourceKey || `${a.source || ""}:${a.title || ""}:${a.reason || ""}`;
    const bKey = b.sourceKey || `${b.source || ""}:${b.title || ""}:${b.reason || ""}`;
    return aKey.localeCompare(bKey);
  });
}

function rejectionIdentity(item) {
  if (item.sourceKey) return `source:${item.sourceKey}`;
  return `local:${item.source || ""}:${item.title || ""}:${item.reason || ""}:${item.detail || ""}`;
}

function rejection(record, reason, detail) {
  return {
    sourceKey: record.key,
    source: record.source,
    sourceId: record.sourceId,
    title: record.title,
    artist: record.artist || null,
    reason,
    detail,
    rejectedAt: new Date().toISOString(),
  };
}

function displayTitle(record) {
  return [record.artist, record.title].filter(Boolean).join(" - ") || record.key;
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        value = "true";
      } else {
        value = next;
        i += 1;
      }
    }
    parsed.set(rawKey, value);
  }
  return parsed;
}

function boolArg(name, fallback) {
  if (!args.has(name)) return fallback;
  return /^(1|true|yes|on)$/i.test(args.get(name));
}

function numberArg(name, fallback) {
  if (!args.has(name)) return fallback;
  const value = Number(args.get(name));
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
  return value;
}

function csvArg(name, fallback) {
  const value = args.get(name) || fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pagesArg(name, fallbackValue) {
  const raw = args.get(name) ?? fallbackValue ?? "all";
  if (String(raw).toLowerCase() === "all") return "all";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer or "all".`);
  return value;
}

function parseDurationToMs(value) {
  if (!value) return null;
  const parts = String(value).trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.round(seconds * 1000);
}

function formatDurationMs(ms) {
  if (!Number.isFinite(Number(ms))) return null;
  const totalSeconds = Math.round(Number(ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sanitizeFileName(name) {
  return String(name || "bard-midi")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || "bard-midi";
}

function titleCase(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;
}

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanOptional(value) {
  const text = String(value ?? "").trim();
  return text && text !== "N/A" && !/^-+$/.test(text) ? text : null;
}

function truncate(value, length) {
  if (!value) return null;
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function splitList(value) {
  return String(value || "")
    .split(/[,/|]+/)
    .map((item) => htmlDecode(item).trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanOptional(value)).filter(Boolean))];
}

function absoluteUrl(url, base) {
  if (!url) return null;
  return new URL(url, base).toString();
}

function relative(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/") || ".";
}

function attr(html, name) {
  return html.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1] || null;
}

function cardMeta(card, label) {
  const pattern = new RegExp(
    `<span[^>]*class="[^"]*card-meta-label[^"]*"[^>]*>\\s*${escapeRegExp(label)}:\\s*<\\/span>\\s*<span[^>]*(?:title="([^"]*)")?[^>]*>([\\s\\S]*?)<\\/span>`,
    "i"
  );
  const match = card.match(pattern);
  return htmlDecode((match?.[1] || stripTags(match?.[2] || "")).trim());
}

function stripTags(html) {
  return htmlDecode(String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberFromText(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function maxPageFromHtml(html) {
  let max = 1;
  for (const match of html.matchAll(/[?&]page=(\d+)/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`Bard MIDI miner

Commands:
  discover-bmp        Crawl Bard Music Player API records into the local catalog.
  discover-ffxivbard  Crawl FFXIV-Bard song list pages into the local catalog.
  download            Download selected catalog candidates into the ignored runtime album.
  audit-status        Print accepted, rejected, resolved, and pending catalog counts.
  audit-batch         Resolve the next small pending batch into accepted files or concrete rejections.
  verify              Parse/hash all runtime album MIDI files and refresh the local ledger.
  title-audit         Report safe Artist - Song title cleanup renames without changing files.
  title-apply         Apply the latest safe title cleanup plan and update local ledgers.
  title-review-suggest Generate CSV-first recommendations for review-only title rows.
  title-review-apply   Apply approved/edited rows from the review CSV by batch.

Examples:
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs discover-bmp --ensemble solo --pages all
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs discover-ffxivbard --focused-genres --pages all
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs download --source bmp --limit 250
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs audit-status
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs audit-batch --source bmp --max-downloads 100
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs verify
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs verify --quarantine-invalid
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs title-audit
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs title-apply
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs title-review-suggest
  .\\scripts\\dev.cmd bun scripts/bard-midi-miner.mjs title-review-apply --batch 1

Local outputs:
  ${relative(catalogPath)}
  ${relative(ledgerPath)}
`);
}

export const __testing = {
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
};
