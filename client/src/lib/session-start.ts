export interface SessionStartHandlers {
  setShowSetup: (showSetup: boolean) => void;
  setHasStarted: (hasStarted: boolean) => void;
  setCurrentLineIndex: (index: number) => void;
  primeAudioPlayback: () => Promise<void>;
  processFirstLine: () => void;
}

export async function startSessionTransition({
  setShowSetup,
  setHasStarted,
  setCurrentLineIndex,
  primeAudioPlayback,
  processFirstLine,
}: SessionStartHandlers): Promise<void> {
  setShowSetup(false);
  setHasStarted(true);
  setCurrentLineIndex(0);

  await primeAudioPlayback().catch(() => undefined);
  processFirstLine();
}
