<script>
  import { onMount } from "svelte";
  import Icon from "@iconify/svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { invoke } from "../tauri/core-proxy.js";
  import { loadMidiFiles } from "../stores/player.js";

  const profiles = [
    { id: "harp", label: "Harp", description: "Melody-first with light arpeggios" },
    { id: "balanced", label: "Balanced", description: "Keeps a little more harmony" },
    { id: "debug_raw", label: "Debug", description: "Minimal cleanup for comparison" },
  ];

  let status = null;
  let statusError = "";
  let selectedPath = "";
  let outputName = "";
  let profile = "harp";
  let keyMode = "36";
  let recordSeconds = 30;
  let useRecording = false;
  let isConverting = false;
  let isSettingUp = false;
  let result = null;
  let error = "";

  onMount(refreshStatus);

  async function refreshStatus() {
    statusError = "";
    try {
      status = await invoke("get_audio_midi_status");
    } catch (e) {
      statusError = e?.toString?.() || String(e);
    }
  }

  async function pickSource() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Audio or MIDI", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac", "mid", "midi"] },
        { name: "Audio", extensions: ["wav", "mp3", "flac", "ogg", "m4a", "aac"] },
        { name: "MIDI", extensions: ["mid", "midi"] },
      ],
    });

    if (typeof picked === "string") {
      selectedPath = picked;
      if (!outputName) {
        outputName = picked.split(/[\\/]/).pop()?.replace(/\.(wav|mp3|flac|ogg|m4a|aac|mid|midi)$/i, "") || "";
      }
    }
  }

  async function setupTools() {
    isSettingUp = true;
    error = "";
    result = null;
    try {
      const setupResult = await invoke("setup_audio_midi_tools");
      if (!setupResult.ok) {
        throw new Error([setupResult.stderr, setupResult.stdout].filter(Boolean).join("\n") || "Setup failed");
      }
      await refreshStatus();
      result = { setup: true, outputPath: null, report: { warnings: ["Audio-to-MIDI tools are ready."] } };
    } catch (e) {
      error = e?.toString?.() || String(e);
    } finally {
      isSettingUp = false;
    }
  }

  async function convert() {
    isConverting = true;
    error = "";
    result = null;

    try {
      const response = await invoke("create_audio_midi", {
        inputPath: useRecording ? null : selectedPath,
        outputName: outputName || "created-song",
        profile,
        keyMode,
        recordSeconds: useRecording ? Number(recordSeconds) : null,
      });
      result = response;
      await loadMidiFiles();
    } catch (e) {
      error = e?.toString?.() || String(e);
    } finally {
      isConverting = false;
    }
  }

  $: selectedFileName = selectedPath ? selectedPath.split(/[\\/]/).pop() : "No source selected";
  $: canConvert = useRecording || selectedPath;
  $: needsAudioSetup = useRecording || selectedPath.match(/\.(wav|mp3|flac|ogg|m4a|aac)$/i);
</script>

<div class="h-full overflow-y-auto pr-2">
  <div class="max-w-4xl mx-auto space-y-4">
    <div class="flex items-center justify-between gap-4">
      <div>
        <h2 class="text-2xl font-bold text-white flex items-center gap-2">
          <Icon icon="mdi:waveform" class="w-7 h-7 text-[#1db954]" />
          Create MIDI
        </h2>
        <p class="text-sm text-white/50 mt-1">Turn local audio or MIDI into a WWM-friendly library song.</p>
      </div>
      <button
        class="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm text-white/80 transition-colors flex items-center gap-2"
        onclick={refreshStatus}
        title="Refresh tool status"
      >
        <Icon icon="mdi:refresh" class="w-4 h-4" />
        Status
      </button>
    </div>

    <section class="rounded-lg bg-white/5 border border-white/10 p-4">
      <div class="flex flex-wrap items-center gap-3">
        <span class="text-sm text-white/70">Transcriber</span>
        <span class="px-2 py-1 rounded text-xs {status?.basicPitchReady ? 'bg-[#1db954]/20 text-[#1db954]' : 'bg-orange-500/20 text-orange-300'}">
          {status?.basicPitchReady ? "Basic Pitch ready" : "Setup needed for audio"}
        </span>
        <span class="px-2 py-1 rounded text-xs {status?.recorderReady ? 'bg-[#1db954]/20 text-[#1db954]' : 'bg-white/10 text-white/50'}">
          {status?.recorderReady ? "Loopback ready" : "Loopback not ready"}
        </span>
      </div>
      {#if statusError}
        <p class="text-sm text-red-300 mt-3 whitespace-pre-wrap">{statusError}</p>
      {/if}
      {#if !status?.basicPitchReady || !status?.recorderReady}
        <button
          class="mt-3 px-4 py-2 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-sm font-medium text-white transition-colors disabled:opacity-50 flex items-center gap-2"
          onclick={setupTools}
          disabled={isSettingUp}
        >
          <Icon icon={isSettingUp ? "mdi:loading" : "mdi:download"} class="w-4 h-4 {isSettingUp ? 'animate-spin' : ''}" />
          {isSettingUp ? "Installing..." : "Install Audio Tools"}
        </button>
      {/if}
    </section>

    <section class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="rounded-lg bg-white/5 border border-white/10 p-4 space-y-4">
        <div class="flex gap-2">
          <button
            class="flex-1 py-2 rounded-lg text-sm transition-colors {useRecording ? 'bg-white/10 text-white' : 'bg-[#1db954] text-white'}"
            onclick={() => useRecording = false}
          >
            File
          </button>
          <button
            class="flex-1 py-2 rounded-lg text-sm transition-colors {useRecording ? 'bg-[#1db954] text-white' : 'bg-white/10 text-white'}"
            onclick={() => useRecording = true}
          >
            Record
          </button>
        </div>

        {#if useRecording}
          <label class="block">
            <span class="text-xs text-white/50">Seconds</span>
            <input
              class="mt-1 w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white"
              type="number"
              min="1"
              max="600"
              bind:value={recordSeconds}
            />
          </label>
        {:else}
          <button
            class="w-full min-h-24 rounded-lg border border-dashed border-white/20 hover:border-[#1db954]/60 bg-black/20 text-white/70 hover:text-white transition-colors flex flex-col items-center justify-center gap-2"
            onclick={pickSource}
          >
            <Icon icon="mdi:file-music" class="w-8 h-8 text-[#1db954]" />
            <span class="text-sm">{selectedFileName}</span>
          </button>
        {/if}

        <label class="block">
          <span class="text-xs text-white/50">Output name</span>
          <input
            class="mt-1 w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white"
            placeholder="created-song"
            bind:value={outputName}
          />
        </label>
      </div>

      <div class="rounded-lg bg-white/5 border border-white/10 p-4 space-y-4">
        <div>
          <span class="text-xs text-white/50">Profile</span>
          <div class="grid grid-cols-3 gap-2 mt-1">
            {#each profiles as option}
              <button
                class="px-2 py-2 rounded-lg text-sm transition-colors {profile === option.id ? 'bg-[#1db954] text-white' : 'bg-white/10 text-white/70 hover:text-white'}"
                onclick={() => profile = option.id}
                title={option.description}
              >
                {option.label}
              </button>
            {/each}
          </div>
        </div>

        <div>
          <span class="text-xs text-white/50">Key mode</span>
          <div class="grid grid-cols-2 gap-2 mt-1">
            <button
              class="px-3 py-2 rounded-lg text-sm transition-colors {keyMode === '21' ? 'bg-[#1db954] text-white' : 'bg-white/10 text-white/70 hover:text-white'}"
              onclick={() => keyMode = "21"}
            >
              21 Natural
            </button>
            <button
              class="px-3 py-2 rounded-lg text-sm transition-colors {keyMode === '36' ? 'bg-[#1db954] text-white' : 'bg-white/10 text-white/70 hover:text-white'}"
              onclick={() => keyMode = "36"}
            >
              36 Chromatic
            </button>
          </div>
        </div>

        <button
          class="w-full py-3 rounded-lg bg-[#1db954] hover:bg-[#1ed760] text-white font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          onclick={convert}
          disabled={!canConvert || isConverting || (needsAudioSetup && !status?.basicPitchReady)}
        >
          <Icon icon={isConverting ? "mdi:loading" : "mdi:music-box-multiple"} class="w-5 h-5 {isConverting ? 'animate-spin' : ''}" />
          {isConverting ? "Creating..." : "Create Library MIDI"}
        </button>
      </div>
    </section>

    {#if error}
      <section class="rounded-lg bg-red-500/10 border border-red-500/30 p-4">
        <p class="text-sm text-red-200 whitespace-pre-wrap">{error}</p>
      </section>
    {/if}

    {#if result}
      <section class="rounded-lg bg-[#1db954]/10 border border-[#1db954]/30 p-4 space-y-2">
        <div class="flex items-center gap-2 text-[#1db954] font-medium">
          <Icon icon="mdi:check-circle" class="w-5 h-5" />
          {result.outputPath ? "Saved to library" : "Setup complete"}
        </div>
        {#if result.outputPath}
          <p class="text-sm text-white/70 break-all">{result.outputPath}</p>
          <p class="text-xs text-white/50">No playback was started. Refresh/load the library and choose the song manually.</p>
        {/if}
        {#if result.report}
          <div class="text-xs text-white/60">
            {#if result.report.rawNoteCount !== undefined}
              <p>{result.report.optimizedNoteCount} of {result.report.rawNoteCount} notes kept</p>
            {/if}
            {#each result.report.warnings || [] as warning}
              <p>{warning}</p>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </div>
</div>
