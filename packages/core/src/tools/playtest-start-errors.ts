// StudioTestService raises this when it still considers an earlier test running.
// That test may be real (still starting, or opened elsewhere) or stuck: after some
// sessions end, Studio refuses new tests until the place is reopened.
const TEST_IN_PROGRESS = /previous one is still in progress/i;

export interface PlaytestStartFailure {
  error: 'studio_test_in_progress' | 'studio_start_failed';
  message: string;
  studioError: string;
  recoveryHint?: string;
}

// Describe a test start that StudioTestService refused, keeping Studio's own text.
export function describePlaytestStartFailure(studioError: string, subject: string): PlaytestStartFailure {
  if (TEST_IN_PROGRESS.test(studioError)) {
    return {
      error: 'studio_test_in_progress',
      message: `Studio refused to start the ${subject} because it still considers a previous test in progress.`,
      studioError,
      recoveryHint:
        'If a test is still starting or running, end it first (solo_playtest stop or multiplayer_playtest end). ' +
        'If none is running, Studio is stuck in this state and stop/end cannot clear it: ' +
        'reopen the place (or restart Studio), then start the test again.',
    };
  }
  return {
    error: 'studio_start_failed',
    message: `Studio refused to start the ${subject}: ${studioError}`,
    studioError,
  };
}
