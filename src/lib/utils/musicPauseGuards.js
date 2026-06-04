export const MUSIC_PAUSE_REASONS = Object.freeze({
  GAME_CHAT: 'game-chat',
  MUSIC_SETTINGS: 'music-settings',
  SMART_FOCUS: 'smart-focus',
});

export function shouldPauseForMusicModeInterruption({
  pending = false,
  smartPause = false,
  isPlaying = false,
  isPaused = false,
} = {}) {
  return Boolean(!pending && smartPause && isPlaying && !isPaused);
}

export function createMusicPauseDiagnostic(reason, outcome, state = {}) {
  return {
    reason,
    outcome,
    smartPause: Boolean(state.smartPause),
    isPlaying: Boolean(state.isPlaying),
    isPaused: Boolean(state.isPaused),
    pending: Boolean(state.pending),
    timestamp: new Date().toISOString(),
  };
}
