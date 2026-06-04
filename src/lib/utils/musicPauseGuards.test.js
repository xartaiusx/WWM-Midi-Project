import { describe, expect, it } from 'vitest'
import {
  MUSIC_PAUSE_REASONS,
  createMusicPauseDiagnostic,
  shouldPauseForMusicModeInterruption,
} from './musicPauseGuards.js'

describe('music pause guards', () => {
  it('allows chat pause only while music-mode smart pause is actively playing', () => {
    expect(shouldPauseForMusicModeInterruption({
      smartPause: true,
      isPlaying: true,
      isPaused: false,
      pending: false,
    })).toBe(true)
  })

  it('allows F1 settings pause through the same guard', () => {
    const canPause = shouldPauseForMusicModeInterruption({
      smartPause: true,
      isPlaying: true,
      isPaused: false,
    })
    const diagnostic = createMusicPauseDiagnostic(MUSIC_PAUSE_REASONS.MUSIC_SETTINGS, canPause ? 'triggered' : 'skipped', {
      smartPause: true,
      isPlaying: true,
      isPaused: false,
    })

    expect(canPause).toBe(true)
    expect(diagnostic).toMatchObject({
      reason: 'music-settings',
      outcome: 'triggered',
      smartPause: true,
      isPlaying: true,
      isPaused: false,
    })
  })

  it('does not pause when smart pause is disabled', () => {
    expect(shouldPauseForMusicModeInterruption({
      smartPause: false,
      isPlaying: true,
      isPaused: false,
    })).toBe(false)
  })

  it('does not pause when playback is not active', () => {
    expect(shouldPauseForMusicModeInterruption({
      smartPause: true,
      isPlaying: false,
      isPaused: false,
    })).toBe(false)
  })

  it('does not pause when already paused', () => {
    expect(shouldPauseForMusicModeInterruption({
      smartPause: true,
      isPlaying: true,
      isPaused: true,
    })).toBe(false)
  })

  it('does not re-enter while a pause is pending', () => {
    expect(shouldPauseForMusicModeInterruption({
      pending: true,
      smartPause: true,
      isPlaying: true,
      isPaused: false,
    })).toBe(false)
  })
})
