export interface StartRecordingTransitionHandlers {
  startRecording: () => Promise<void>;
  primeAudioPlayback: () => Promise<void>;
}

export async function startRecordingTransition({
  startRecording,
  primeAudioPlayback,
}: StartRecordingTransitionHandlers): Promise<void> {
  await startRecording();
  await primeAudioPlayback().catch(() => undefined);
}
