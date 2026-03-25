export interface DevicePreparationHandlers {
  primeAudioPlayback: () => Promise<void>;
  prepareMicrophone: () => Promise<void>;
  onPlaybackReady?: () => void;
  onPlaybackError?: (error: unknown) => void;
  onMicrophoneReady?: () => void;
  onMicrophoneError?: (error: unknown) => void;
}

export interface DevicePreparationResult {
  playbackReady: boolean;
  microphoneReady: boolean;
}

async function runPreparationStep(
  step: () => Promise<void>,
  onReady?: () => void,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  try {
    await step();
    onReady?.();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

export async function prepareDeviceForRehearsal({
  primeAudioPlayback,
  prepareMicrophone,
  onPlaybackReady,
  onPlaybackError,
  onMicrophoneReady,
  onMicrophoneError,
}: DevicePreparationHandlers): Promise<DevicePreparationResult> {
  const playbackPromise = runPreparationStep(
    primeAudioPlayback,
    onPlaybackReady,
    onPlaybackError,
  );
  const microphonePromise = runPreparationStep(
    prepareMicrophone,
    onMicrophoneReady,
    onMicrophoneError,
  );

  const [playbackReady, microphoneReady] = await Promise.all([
    playbackPromise,
    microphonePromise,
  ]);

  return {
    playbackReady,
    microphoneReady,
  };
}
