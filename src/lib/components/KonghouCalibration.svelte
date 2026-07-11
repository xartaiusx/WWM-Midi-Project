<script>
  import { onMount } from 'svelte';
  import Icon from '@iconify/svelte';
  import { invoke } from '../tauri/core-proxy.js';

  let report = null;
  let running = null;
  let error = '';
  let elapsedSeconds = 0;
  let timer = null;

  const stages = [
    { kind: 'PitchSweep', label: '36-pitch sweep', duration: 'about 20 seconds', icon: 'mdi:music-accidental-sharp' },
    { kind: 'TimingStress', label: 'Timing and chord stress', duration: 'about 50 seconds', icon: 'mdi:timer-music-outline' },
    { kind: 'Drift', label: 'Five-minute drift', duration: '5 minutes', icon: 'mdi:timeline-clock-outline' },
  ];

  onMount(async () => {
    try {
      report = await invoke('get_konghou_calibration');
    } catch (loadError) {
      console.warn('Failed to load local Konghou calibration:', loadError);
    }
  });

  async function runStage(kind) {
    if (running) return;
    running = kind;
    error = '';
    elapsedSeconds = 0;
    timer = setInterval(() => elapsedSeconds += 1, 1000);
    try {
      report = await invoke('run_konghou_calibration', { kind });
      if (kind === 'TimingStress' && report?.passed && report.recommended_input_timing) {
        localStorage.setItem(
          'wwm-modifier-delay',
          String(report.recommended_input_timing.modifier_lead_ms),
        );
      }
    } catch (runError) {
      error = runError?.message || String(runError);
    } finally {
      clearInterval(timer);
      timer = null;
      running = null;
    }
  }

  async function cancel() {
    await invoke('cancel_konghou_calibration');
  }

  function formatMetric(value, suffix = '') {
    return Number.isFinite(value) ? `${Number(value).toFixed(1)}${suffix}` : 'Not measured';
  }
</script>

<div class="space-y-4">
  <div class="flex items-start gap-3">
    <Icon icon="mdi:waveform" class="w-6 h-6 text-[#1db954] flex-shrink-0" />
    <div>
      <p class="font-medium text-white">WASAPI audio verification</p>
      <p class="text-sm text-white/60">Run with the WWM Konghou interface open and other system audio muted. Results remain beside the local album.</p>
    </div>
  </div>

  <div class="grid grid-cols-3 gap-2">
    {#each stages as stage}
      <button
        class="min-h-24 border border-white/10 rounded-md p-3 text-left hover:border-white/25 hover:bg-white/5 disabled:opacity-40"
        onclick={() => runStage(stage.kind)}
        disabled={Boolean(running)}
      >
        <Icon icon={running === stage.kind ? 'mdi:loading' : stage.icon} class="w-5 h-5 mb-2 {running === stage.kind ? 'animate-spin text-[#1db954]' : 'text-white/70'}" />
        <p class="text-sm font-medium text-white">{stage.label}</p>
        <p class="text-xs text-white/40 mt-1">{stage.duration}</p>
      </button>
    {/each}
  </div>

  {#if running}
    <div class="flex items-center justify-between border-t border-white/10 pt-3">
      <span class="text-sm text-white/70">Capturing and measuring - {elapsedSeconds}s</span>
      <button class="w-8 h-8 flex items-center justify-center rounded-md bg-red-500/15 text-red-300 hover:bg-red-500/25" onclick={cancel} title="Cancel calibration">
        <Icon icon="mdi:stop" class="w-4 h-4" />
      </button>
    </div>
  {/if}

  {#if error}
    <p class="text-sm text-red-300 border-t border-red-500/20 pt-3">{error}</p>
  {/if}

  {#if report}
    <div class="border-t border-white/10 pt-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <Icon icon={report.passed ? 'mdi:check-decagram' : 'mdi:alert-circle-outline'} class="w-5 h-5 {report.passed ? 'text-[#1db954]' : 'text-orange-400'}" />
          <p class="font-medium">{report.passed ? 'Stage certified' : 'Stage needs another pass'}</p>
        </div>
        <span class="text-xs text-white/40">{report.kind}</span>
      </div>
      <div class="grid grid-cols-3 gap-x-4 gap-y-3 mt-4 text-sm">
        <div><p class="text-white/40 text-xs">Pitch/probe passes</p><p>{report.correct_pitch_count}/{report.expected_note_count}</p></div>
        <div><p class="text-white/40 text-xs">All-probe recall</p><p>{formatMetric(report.onset_recall_percent, '%')}</p></div>
        <div><p class="text-white/40 text-xs">p95 onset</p><p>{formatMetric(report.p95_relative_onset_error_ms, ' ms')}</p></div>
        <div><p class="text-white/40 text-xs">Modifier notes</p><p>{report.modifier_reliable_count}/{report.modifier_note_count}</p></div>
        <div><p class="text-white/40 text-xs">Chord spread</p><p>{formatMetric(report.p95_chord_spread_ms, ' ms')}</p></div>
        <div><p class="text-white/40 text-xs">Drift</p><p>{formatMetric(report.cumulative_drift_ms, ' ms')}</p></div>
        <div><p class="text-white/40 text-xs">Certified rate</p><p>{report.maximum_clean_onsets_per_second ? `${report.maximum_clean_onsets_per_second}/s at ${formatMetric(report.certified_rate_onset_recall_percent, '%')}` : 'Not measured'}</p></div>
        <div><p class="text-white/40 text-xs">Modifier timing</p><p>{report.recommended_input_timing ? `${report.recommended_input_timing.modifier_lead_ms}/${report.recommended_input_timing.modifier_release_ms} ms` : 'Not measured'}</p></div>
        <div><p class="text-white/40 text-xs">Tap timing</p><p>{report.recommended_input_timing ? `${report.recommended_input_timing.tap_ms} ms` : 'Not measured'}</p></div>
      </div>
    </div>
  {/if}
</div>
