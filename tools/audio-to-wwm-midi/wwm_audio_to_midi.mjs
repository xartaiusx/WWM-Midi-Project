#!/usr/bin/env node
import { access, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { optimizeMidiFile, sanitizeFileName } from './optimizer.mjs'

const toolDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(toolDir, '..', '..')
const tempRoot = path.join(repoRoot, '.temp', 'audio-to-wwm-midi')
const defaultAlbumPath = path.join(repoRoot, 'src-tauri', 'target', 'release', 'album')

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'])
const MIDI_EXTENSIONS = new Set(['.mid', '.midi'])
let jsonOutput = false

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  jsonOutput = Boolean(args.json)

  try {
    if (command === 'status') {
      await printResult(await getStatus(), args)
    } else if (command === 'optimize') {
      await printResult(await optimizeCommand(args), args)
    } else if (command === 'transcribe') {
      await printResult(await transcribeCommand(args), args)
    } else if (command === 'record') {
      await printResult(await recordCommand(args), args)
    } else if (command === 'create') {
      await printResult(await createCommand(args), args)
    } else {
      printHelp()
      process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 1)
    }
  } catch (error) {
    const payload = {
      ok: false,
      error: error?.message || String(error),
    }
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      console.error(payload.error)
    }
    process.exit(1)
  }
}

async function createCommand(args) {
  const input = args.input || args.i
  const seconds = Number(args.record || args.seconds || 0)
  let sourcePath = input ? path.resolve(input) : null
  let recordedPath = null
  let rawMidiPath = null

  if (!sourcePath && seconds > 0) {
    const recordName = `${sanitizeFileName(args.name || 'recording')}-${Date.now()}.wav`
    recordedPath = path.join(tempRoot, recordName)
    await recordLoopback(seconds, recordedPath)
    sourcePath = recordedPath
  }

  if (!sourcePath) {
    throw new Error('Provide --input <audio-or-midi-file> or --record <seconds>.')
  }

  await assertReadable(sourcePath)
  const ext = path.extname(sourcePath).toLowerCase()

  if (MIDI_EXTENSIONS.has(ext)) {
    rawMidiPath = sourcePath
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    rawMidiPath = await runBasicPitch(sourcePath)
  } else {
    throw new Error(`Unsupported source extension: ${ext || '(none)'}. Use audio or .mid/.midi files.`)
  }

  const albumPath = path.resolve(args.album || defaultAlbumPath)
  const baseName = sanitizeFileName(args.name || path.basename(sourcePath, ext))
  const outputPath = path.resolve(args.output || path.join(albumPath, `${baseName}.wwm.mid`))
  const reportPath = path.resolve(args.report || outputPath.replace(/\.mid$/i, '.report.json'))
  const profile = args.profile || 'harp'
  const keyMode = args['key-mode'] || args.keyMode || '36'

  const report = await optimizeMidiFile(rawMidiPath, outputPath, {
    profile,
    keyMode,
    trackName: `${baseName} WWM ${profile}`,
  })
  await writeFile(reportPath, JSON.stringify({
    ...report,
    recordedPath,
    rawMidiPath,
    sourcePath,
  }, null, 2), 'utf8')

  if (args['keep-raw'] && rawMidiPath !== sourcePath) {
    const rawDest = outputPath.replace(/\.mid$/i, '.raw.mid')
    await cp(rawMidiPath, rawDest)
  }

  return {
    ok: true,
    command: 'create',
    outputPath,
    reportPath,
    sourcePath,
    recordedPath,
    rawMidiPath,
    report,
  }
}

async function optimizeCommand(args) {
  const input = args.input || args.i
  if (!input) throw new Error('Missing --input <midi-file>.')
  const inputPath = path.resolve(input)
  await assertReadable(inputPath)

  const ext = path.extname(inputPath).toLowerCase()
  if (!MIDI_EXTENSIONS.has(ext)) {
    throw new Error('The optimize command expects a .mid or .midi source file.')
  }

  const albumPath = path.resolve(args.album || defaultAlbumPath)
  const baseName = sanitizeFileName(args.name || path.basename(inputPath, ext))
  const outputPath = path.resolve(args.output || path.join(albumPath, `${baseName}.wwm.mid`))
  const reportPath = path.resolve(args.report || outputPath.replace(/\.mid$/i, '.report.json'))
  const profile = args.profile || 'harp'
  const keyMode = args['key-mode'] || args.keyMode || '36'
  const report = await optimizeMidiFile(inputPath, outputPath, {
    profile,
    keyMode,
    trackName: `${baseName} WWM ${profile}`,
  })
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

  return {
    ok: true,
    command: 'optimize',
    outputPath,
    reportPath,
    report,
  }
}

async function transcribeCommand(args) {
  const input = args.input || args.i
  if (!input) throw new Error('Missing --input <audio-file>.')
  const inputPath = path.resolve(input)
  await assertReadable(inputPath)
  const midiPath = await runBasicPitch(inputPath)

  return {
    ok: true,
    command: 'transcribe',
    midiPath,
  }
}

async function recordCommand(args) {
  const seconds = Number(args.record || args.seconds || 30)
  const outputPath = path.resolve(args.output || path.join(tempRoot, `recording-${Date.now()}.wav`))
  await recordLoopback(seconds, outputPath)

  return {
    ok: true,
    command: 'record',
    outputPath,
    seconds,
  }
}

async function getStatus() {
  const pythonPath = await findAudioPython()
  const basicPitchPath = await findBasicPitchExecutable()
  const nodePath = process.execPath
  const basicPitch = pythonPath
    ? await probePythonModule(pythonPath, 'basic_pitch')
    : { ok: false, error: 'Python audio environment is not installed.' }
  const recorder = pythonPath
    ? await probePythonModule(pythonPath, 'pyaudiowpatch')
    : { ok: false, error: 'Python audio environment is not installed.' }

  return {
    ok: true,
    repoRoot,
    toolDir,
    defaultAlbumPath,
    nodePath,
    pythonPath,
    basicPitchPath,
    basicPitchReady: basicPitch.ok,
    recorderReady: recorder.ok,
    basicPitchError: basicPitch.error || null,
    recorderError: recorder.error || null,
    setupScript: path.join(repoRoot, 'scripts', 'setup-audio-midi.cmd'),
  }
}

async function runBasicPitch(audioPath) {
  await requireAudioPython()
  const basicPitchPath = await findBasicPitchExecutable()
  if (!basicPitchPath) {
    throw new Error('Basic Pitch executable is not installed. Run scripts\\setup-audio-midi.cmd first.')
  }
  const outputDir = path.join(tempRoot, `basic-pitch-${Date.now()}`)
  await mkdir(outputDir, { recursive: true })

  const before = Date.now()
  await runProcess(basicPitchPath, ['--save-midi', outputDir, audioPath], {
    cwd: repoRoot,
    label: 'Basic Pitch transcription',
  })

  const midiFiles = await findFiles(outputDir, (file) => MIDI_EXTENSIONS.has(path.extname(file).toLowerCase()))
  if (!midiFiles.length) {
    throw new Error('Basic Pitch finished but did not create a MIDI file.')
  }

  const withStats = await Promise.all(midiFiles.map(async (file) => ({
    file,
    stats: await stat(file),
  })))
  withStats.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)

  const newest = withStats[0]
  if (newest.stats.mtimeMs < before - 1000) {
    throw new Error('Basic Pitch did not create a fresh MIDI file.')
  }
  return newest.file
}

async function recordLoopback(seconds, outputPath) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error('Recording duration must be between 1 and 600 seconds.')
  }
  const pythonPath = await requireAudioPython()
  await mkdir(path.dirname(outputPath), { recursive: true })
  await runProcess(pythonPath, [
    path.join(toolDir, 'record_loopback.py'),
    '--seconds',
    String(seconds),
    '--output',
    outputPath,
  ], {
    cwd: repoRoot,
    label: 'WASAPI loopback recording',
  })
}

async function requireAudioPython() {
  const pythonPath = await findAudioPython()
  if (!pythonPath) {
    throw new Error('Audio-to-MIDI Python environment is not installed. Run scripts\\setup-audio-midi.cmd first.')
  }
  return pythonPath
}

async function findAudioPython() {
  const candidates = [
    process.env.WWM_AUDIO_MIDI_PYTHON,
    path.join(repoRoot, '.dev-tools', 'audio-midi-venv', 'Scripts', 'python.exe'),
    path.join(repoRoot, '.dev-tools', 'python311', 'python.exe'),
    path.join(process.env.LocalAppData || '', 'Programs', 'Python', 'Python311', 'python.exe'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

async function findBasicPitchExecutable() {
  const candidates = [
    path.join(repoRoot, '.dev-tools', 'audio-midi-venv', 'Scripts', 'basic-pitch.exe'),
    process.env.WWM_BASIC_PITCH,
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

async function probePythonModule(pythonPath, moduleName) {
  try {
    await runProcess(pythonPath, ['-c', `import ${moduleName}`], {
      cwd: repoRoot,
      label: `Probe ${moduleName}`,
      silent: true,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      if (!options.silent && !jsonOutput) process.stdout.write(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (!options.silent && !jsonOutput) process.stderr.write(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        reject(new Error(`${options.label || command} failed with code ${code}${detail ? `:\n${detail}` : ''}`))
      }
    })
  })
}

async function findFiles(root, predicate) {
  const results = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      results.push(...await findFiles(fullPath, predicate))
    } else if (predicate(fullPath)) {
      results.push(fullPath)
    }
  }
  return results
}

async function assertReadable(filePath) {
  try {
    await access(filePath, fsConstants.R_OK)
  } catch {
    throw new Error(`File is not readable: ${filePath}`)
  }
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i]
    if (!part.startsWith('--')) {
      if (!args.input) args.input = part
      continue
    }
    const key = part.slice(2)
    if (key === 'json' || key === 'keep-raw') {
      args[key] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    i++
  }
  return args
}

async function printResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (result.command === 'create' || result.command === 'optimize') {
    console.log(`Saved WWM MIDI: ${result.outputPath}`)
    console.log(`Report: ${result.reportPath}`)
    console.log(`Notes: ${result.report.optimizedNoteCount}/${result.report.rawNoteCount} kept`)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}

function printHelp() {
  console.log(`
WWM Audio-to-MIDI Creator

Commands:
  status --json
  optimize --input song.mid --name "Song" --profile harp --key-mode 36
  create --input audio.wav --name "Song" --profile harp --key-mode 36
  create --record 30 --name "Live Clip" --profile harp --key-mode 36
  record --seconds 30 --output .temp/clip.wav
  transcribe --input audio.wav

Profiles:
  harp       Melody-first, low polyphony, arpeggiated harmony
  balanced   Moderate chords and timing cleanup
  debug_raw  Minimal simplification for diagnostics
`)
}

main()
