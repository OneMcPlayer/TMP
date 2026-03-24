export interface StartRecordingTransitionHandlers {
  startRecording: () => Promise<boolean>;
  primeAudioPlayback: () => Promise<void>;
  onPrimeAudioPlaybackError?: (error: unknown) => void;
}

export async function startRecordingTransition({
  startRecording,
  primeAudioPlayback,
  onPrimeAudioPlaybackError,
}: StartRecordingTransitionHandlers): Promise<boolean> {
  const didStartRecording = await startRecording();
  if (!didStartRecording) {
    return false;
  }

  void primeAudioPlayback().catch((error) => {
    onPrimeAudioPlaybackError?.(error);
  });

  return true;
}
