#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const VALID_STATUSES = new Set([
  "approved-sourceable",
  "needs-user-source",
  "needs-license",
  "rejected",
]);

const repoRoot = path.resolve(import.meta.dir, "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) {
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    let value = inlineValue;
    if (value === undefined) {
      const next = process.argv[i + 1];
      if (!next || next.startsWith("--")) {
        value = "true";
      } else {
        value = next;
        i += 1;
      }
    }
    args.set(key, value);
  }
}

const manifestPath = path.resolve(repoRoot, args.get("manifest") || "album-manifest.json");
const manifest = readJson(manifestPath, {
  albumDir: "Album",
  allowExactDuplicateHashes: [],
  allowNormalizedDuplicates: [],
  entries: [],
});
const albumDir = path.resolve(repoRoot, args.get("album-dir") || manifest.albumDir || "Album");
const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
const allowExact = new Set(manifest.allowExactDuplicateHashes || []);
const allowNormalized = new Map(
  (manifest.allowNormalizedDuplicates || []).map((item) => [item.duplicateKey, item.reason || "allowlisted"])
);
const allowPatternRules = (manifest.allowNormalizedDuplicates || [])
  .filter((item) => item.duplicateKey && Array.isArray(item.patterns) && item.patterns.length > 0)
  .map((item) => ({
    duplicateKey: item.duplicateKey,
    patterns: item.patterns.map((pattern) => normalizePattern(pattern)),
  }));

const files = listMidiFiles(albumDir);
const fileRows = files.map((file) => {
  const bytes = readFileSync(file);
  const relativePath = path.relative(albumDir, file).replaceAll(path.sep, "/");
  const manifestEntry = entries.find((entry) => entry.file === relativePath || entry.filename === relativePath);
  return {
    file,
    relativePath,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    duplicateKey: manifestEntry?.duplicateKey || allowlistedDuplicateKey(relativePath) || normalizeTitle(relativePath),
    manifestEntry,
  };
});

const errors = [];
const warnings = [];

for (const entry of entries) {
  if (!entry.file && !entry.filename) {
    errors.push("Manifest entry is missing `file`.");
  }
  if (!VALID_STATUSES.has(entry.status)) {
    errors.push(`Manifest entry ${entry.file || entry.filename || "(unknown)"} has invalid status: ${entry.status}`);
  }
  if (entry.status === "approved-sourceable" && !entry.sourceUrl && !entry.sourceNote) {
    errors.push(`Approved manifest entry ${entry.file || entry.filename} needs sourceUrl or sourceNote.`);
  }
  if (entry.sha256) {
    const row = fileRows.find((file) => file.relativePath === (entry.file || entry.filename));
    if (row && row.sha256 !== entry.sha256) {
      errors.push(`Manifest sha256 mismatch for ${row.relativePath}.`);
    }
  }
}

const exactDuplicateGroups = groupBy(fileRows, (row) => row.sha256)
  .filter((group) => group.length > 1 && !allowExact.has(group[0].sha256));
for (const group of exactDuplicateGroups) {
  errors.push(`Exact duplicate MIDI hash ${group[0].sha256}: ${group.map((row) => row.relativePath).join(" | ")}`);
}

const allNormalizedDuplicateGroups = groupBy(fileRows, (row) => row.duplicateKey)
  .filter((group) => group.length > 1);
const unallowedNormalizedDuplicateGroups = allNormalizedDuplicateGroups
  .filter((group) => !allowNormalized.has(group[0].duplicateKey));
for (const group of unallowedNormalizedDuplicateGroups) {
  errors.push(`Normalized duplicate key "${group[0].duplicateKey}": ${group.map((row) => row.relativePath).join(" | ")}`);
}

for (const group of allNormalizedDuplicateGroups.filter((group) => allowNormalized.has(group[0].duplicateKey))) {
  warnings.push(`Allowlisted normalized duplicate "${group[0].duplicateKey}": ${allowNormalized.get(group[0].duplicateKey)}`);
}

const missingManifestRows = fileRows.filter((row) => !row.manifestEntry);
if (missingManifestRows.length > 0) {
  warnings.push(`${missingManifestRows.length} MIDI file(s) are not yet represented in album-manifest.json.`);
}

console.log(`Album audit`);
console.log(`- Album dir: ${path.relative(repoRoot, albumDir) || "."}`);
console.log(`- MIDI files: ${fileRows.length}`);
console.log(`- Manifest entries: ${entries.length}`);
console.log(`- Exact duplicate groups: ${exactDuplicateGroups.length}`);
console.log(`- Normalized duplicate groups: ${allNormalizedDuplicateGroups.length}`);
console.log(`- Unallowed normalized duplicate groups: ${unallowedNormalizedDuplicateGroups.length}`);

for (const warning of warnings) {
  console.warn(`::warning::${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exit(1);
}

console.log("Album audit passed.");

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function listMidiFiles(dir) {
  if (!existsSync(dir)) return [];
  const output = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (/\.midi?$/i.test(name)) {
        output.push(full);
      }
    }
  }
  return output.sort((a, b) => a.localeCompare(b));
}

function normalizeTitle(filename) {
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

function allowlistedDuplicateKey(filename) {
  const normalized = normalizePattern(path.basename(filename).replace(/\.midi?$/i, ""));
  for (const rule of allowPatternRules) {
    if (rule.patterns.every((pattern) => normalized.includes(pattern))) {
      return rule.duplicateKey;
    }
  }
  return "";
}

function normalizePattern(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_+|/\\()[\]{}:;'"!?.,-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
