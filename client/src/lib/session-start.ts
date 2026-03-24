export interface SessionStartHandlers {
  setShowSetup: (showSetup: boolean) => void;
  setHasStarted: (hasStarted: boolean) => void;
  setCurrentLineIndex: (index: number) => void;
  primeAudioPlayback: () => Promise<void>;
  processFirstLine: () => void;
  onPrimeAudioPlaybackError?: (error: unknown) => void;
}

export async function startSessionTransition({
  setShowSetup,
  setHasStarted,
  setCurrentLineIndex,
  primeAudioPlayback,
  processFirstLine,
  onPrimeAudioPlaybackError,
}: SessionStartHandlers): Promise<void> {
  setShowSetup(false);
  setHasStarted(true);
  setCurrentLineIndex(0);

  void primeAudioPlayback().catch((error) => {
    onPrimeAudioPlaybackError?.(error);
  });
  processFirstLine();
}
