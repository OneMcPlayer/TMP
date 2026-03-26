export type PreferredAudioSessionType = 'auto' | 'playback' | 'play-and-record';

export interface AudioSessionLike {
  addEventListener?: (type: 'statechange', listener: () => void) => void;
  removeEventListener?: (type: 'statechange', listener: () => void) => void;
  state?: string;
  type?: string;
}

export interface NavigatorWithAudioSession extends Navigator {
  audioSession?: AudioSessionLike;
}

export function getAudioSession(
  navigatorLike: NavigatorWithAudioSession | undefined,
): AudioSessionLike | null {
  return navigatorLike?.audioSession ?? null;
}

export function resolvePreferredAudioSessionType({
  carMode,
  hasCompletedDeviceSetup,
  hasStarted,
  isPreparingDevice,
  isRecording,
}: {
  carMode: boolean;
  hasCompletedDeviceSetup: boolean;
  hasStarted: boolean;
  isPreparingDevice: boolean;
  isRecording: boolean;
}): PreferredAudioSessionType {
  const shouldArmAudioSession =
    hasCompletedDeviceSetup || hasStarted || isPreparingDevice || isRecording;

  if (!shouldArmAudioSession) {
    return 'auto';
  }

  return carMode || isRecording ? 'play-and-record' : 'playback';
}

export function setPreferredAudioSessionType(
  navigatorLike: NavigatorWithAudioSession | undefined,
  nextType: PreferredAudioSessionType,
): { supported: boolean; changed: boolean; state: string | null } {
  const audioSession = getAudioSession(navigatorLike);
  if (!audioSession || typeof audioSession.type !== 'string') {
    return { supported: false, changed: false, state: null };
  }

  const changed = audioSession.type !== nextType;
  audioSession.type = nextType;

  return {
    supported: true,
    changed,
    state: typeof audioSession.state === 'string' ? audioSession.state : null,
  };
}

export function subscribeToAudioSessionState(
  navigatorLike: NavigatorWithAudioSession | undefined,
  listener: (state: string) => void,
): () => void {
  const audioSession = getAudioSession(navigatorLike);
  if (!audioSession?.addEventListener || !audioSession.removeEventListener) {
    return () => undefined;
  }

  const handleStateChange = () => {
    listener(typeof audioSession.state === 'string' ? audioSession.state : 'unknown');
  };

  audioSession.addEventListener('statechange', handleStateChange);

  return () => {
    audioSession.removeEventListener?.('statechange', handleStateChange);
  };
}
