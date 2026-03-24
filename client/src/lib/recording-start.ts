export interface StartRecordingTransitionHandlers {
  startRecording: () => Promise<void>;
  primeAudioPlayback: () => Promise<void>;
  onPrimeAudioPlaybackError?: (error: unknown) => void;
}

export async function startRecordingTransition({
  startRecording,
  primeAudioPlayback,
  onPrimeAudioPlaybackError,
}: StartRecordingTransitionHandlers): Promise<void> {
  await startRecording();
  void primeAudioPlayback().catch((error) => {
    onPrimeAudioPlaybackError?.(error);
  });
}
