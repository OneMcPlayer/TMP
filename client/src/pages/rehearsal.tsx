import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ApiKeyInput } from '@/components/api-key-input';
import { CharacterSelector } from '@/components/character-selector';
import { DeviceSetupScreen } from '@/components/device-setup-screen';
import { CarModeStage } from '@/components/car-mode-stage';
import { RehearsalTimeline } from '@/components/rehearsal-timeline';
import { RehearsalControls } from '@/components/rehearsal-controls';
import { ScriptHeader } from '@/components/script-header';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  NO_AUDIO_CAPTURED_ERROR,
  NO_SPEECH_DETECTED_ERROR,
  prepareMicrophoneAccess,
  useAudioRecorder,
} from '@/hooks/use-audio-recorder';
import {
  resolvePreferredAudioSessionType,
  setPreferredAudioSessionType,
  subscribeToAudioSessionState,
} from '@/lib/audio-session';
import {
  textToSpeech,
  prefetchTextToSpeech,
  speechToText,
  playAudioBlob,
  getApiKey,
  playRecordingStartCue,
  primeAudioPlayback,
} from '@/lib/openai';
import { computeWordDiff, calculateAccuracy } from '@/lib/word-diff';
import { buildTranscriptionPrompt, getSpeakableText, normalizeScript } from '@/lib/script-utils';
import { startSessionTransition } from '@/lib/session-start';
import { startRecordingTransition } from '@/lib/recording-start';
import {
  buildNavigationTargetLines,
  buildRehearsalLines,
  buildSkippedUserLine,
  needsRehearsalLineInitialization,
} from '@/lib/rehearsal-flow';
import type { RawScript, RehearsalLine, RehearsalState, Script } from '@/lib/types';
import {
  appendDebugLogEntry,
  createDebugLogEntry,
  serializeDebugLogEntries,
  type DebugLogEntry,
} from '@/lib/debug-log';
import {
  capturePwaRuntimeDiagnostics,
  consumeQueuedPwaDebugLogs,
  requestServiceWorkerDebugSnapshot,
  subscribeToPwaDebugLogs,
} from '@/lib/pwa-debug';
import { APP_VERSION, buildUpdateReloadUrl, fetchLatestVersion, isUpdateAvailable } from '@/lib/version';
import { isSlowPreparation, shouldOfferPreparationRecovery } from '@/lib/rehearsal-latency';
import { prepareDeviceForRehearsal } from '@/lib/device-setup';
import { cn } from '@/lib/utils';
import { AlertCircle, CarFront, Copy, Download, RefreshCw, Settings, Smartphone, Theater } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const PREFERENCES_STORAGE_KEY = 'rehearsal_preferences';
const TRACK_NAVIGATION_STATES: RehearsalState[] = ['waiting-for-user', 'showing-feedback'];
const INITIAL_AUDIO_PREFETCH_COUNT = 5;
const LOOKAHEAD_AUDIO_PREFETCH_COUNT = 3;

const VOICE_MAP: Record<string, string> = {
  'CLOV': 'fable',
  'HAMM': 'onyx',
  'NAGG': 'echo',
  'NELL': 'shimmer',
};

function getVoiceForCharacter(character: string): string {
  return VOICE_MAP[character.toUpperCase()] || 'alloy';
}

function isPlaybackPermissionError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('notallowederror') ||
    message.includes('not allowed') ||
    message.includes('permission') ||
    message.includes('user gesture') ||
    message.includes('interaction')
  );
}

interface PracticePreferences {
  selectedCharacter: string | null;
  carMode: boolean;
  autoSpeakCorrections: boolean;
}

type DeviceSetupStatus = 'idle' | 'pending' | 'ready' | 'error';

type WakeLockStatus = 'active' | 'requesting' | 'inactive' | 'unavailable' | 'error';

type PendingAudioRecovery =
  | { kind: 'partner-line'; lineIndex: number; audioBlob: Blob }
  | { kind: 'correction'; lineIndex: number; audioBlob: Blob };

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>;
  };
};

function setMediaSessionActionHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Some browsers expose mediaSession but not every action.
  }
}

function loadPreferences(): PracticePreferences {
  const defaultPreferences: PracticePreferences = {
    selectedCharacter: null,
    carMode: false,
    autoSpeakCorrections: true,
  };

  try {
    const rawPreferences = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!rawPreferences) {
      return defaultPreferences;
    }

    const parsedPreferences = JSON.parse(rawPreferences) as Partial<PracticePreferences>;
    return {
      selectedCharacter: parsedPreferences.selectedCharacter ?? defaultPreferences.selectedCharacter,
      carMode: parsedPreferences.carMode ?? defaultPreferences.carMode,
      autoSpeakCorrections:
        parsedPreferences.autoSpeakCorrections ?? defaultPreferences.autoSpeakCorrections,
    };
  } catch {
    return defaultPreferences;
  }
}

function getPreparationErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallbackMessage;
}

export default function RehearsalPage() {
  const { toast } = useToast();
  const initialPreferences = useRef<PracticePreferences>(loadPreferences());
  const [carMode, setCarMode] = useState(initialPreferences.current.carMode);
  const isStoppingRecordingRef = useRef(false);
  const onSilenceTimeoutRef = useRef<(() => void) | null>(null);
  const {
    prepareRecordingSession,
    releasePreparedRecordingSession,
    startRecording,
    stopRecording,
    isRecording,
  } = useAudioRecorder({
    carMode,
    silenceTimeoutMs: 5000,
    onSilenceTimeout: () => onSilenceTimeoutRef.current?.(),
  });

  const [script, setScript] = useState<Script | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState(!!getApiKey());
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(
    initialPreferences.current.selectedCharacter,
  );
  const [autoSpeakCorrections, setAutoSpeakCorrections] = useState(
    initialPreferences.current.autoSpeakCorrections,
  );
  const [rehearsalLines, setRehearsalLines] = useState<RehearsalLine[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const [rehearsalState, setRehearsalState] = useState<RehearsalState>('idle');
  const [hasStarted, setHasStarted] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [hasCompletedDeviceSetup, setHasCompletedDeviceSetup] = useState(false);
  const [isPreparingDevice, setIsPreparingDevice] = useState(false);
  const [microphoneSetupStatus, setMicrophoneSetupStatus] = useState<DeviceSetupStatus>('idle');
  const [microphoneSetupMessage, setMicrophoneSetupMessage] = useState<string | null>(null);
  const [playbackSetupStatus, setPlaybackSetupStatus] = useState<DeviceSetupStatus>('idle');
  const [playbackSetupMessage, setPlaybackSetupMessage] = useState<string | null>(null);
  const [debugLogEntries, setDebugLogEntries] = useState<DebugLogEntry[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [isCheckingVersion, setIsCheckingVersion] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [versionCheckedAt, setVersionCheckedAt] = useState<string | null>(null);
  const [slowPreparationSeconds, setSlowPreparationSeconds] = useState(0);
  const [wakeLockStatus, setWakeLockStatus] = useState<WakeLockStatus>('inactive');
  const [audioRecoveryMessage, setAudioRecoveryMessage] = useState<string | null>(null);
  const [isRecoveringAudio, setIsRecoveringAudio] = useState(false);

  const rehearsalLinesRef = useRef<RehearsalLine[]>([]);
  const currentLineIndexRef = useRef(-1);
  const isStartingRef = useRef(false);
  const isStartingRecordingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const rehearsalStateRef = useRef<RehearsalState>('idle');
  const carModeAutoStartTimeoutRef = useRef<number | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);
  const correctionAudioCacheRef = useRef<Map<number, Blob>>(new Map());
  const prefetchedAudioIndexesRef = useRef<Set<number>>(new Set());
  const hasScheduledInitialAudioPrefetchRef = useRef(false);
  const lastAppliedAudioSessionTypeRef = useRef<string | null>(null);
  const pendingAudioRecoveryRef = useRef<PendingAudioRecovery | null>(null);
  const lastSelectedModeRef = useRef(carMode);
  const discardActiveRecordingRef = useRef(false);

  useEffect(() => {
    rehearsalLinesRef.current = rehearsalLines;
  }, [rehearsalLines]);

  useEffect(() => {
    currentLineIndexRef.current = currentLineIndex;
  }, [currentLineIndex]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const addDebugLog = useCallback((event: string, details?: string) => {
    setDebugLogEntries((entries) =>
      appendDebugLogEntry(entries, createDebugLogEntry(event, details)),
    );
  }, []);

  const clearAudioRecovery = useCallback(() => {
    pendingAudioRecoveryRef.current = null;
    setAudioRecoveryMessage(null);
  }, []);

  const queueAudioRecovery = useCallback((message: string, pendingRecovery?: PendingAudioRecovery) => {
    if (pendingRecovery) {
      pendingAudioRecoveryRef.current = pendingRecovery;
    }

    setAudioRecoveryMessage(message);
    addDebugLog('Audio Recovery Required', message);
  }, [addDebugLog]);

  const updateRehearsalState = useCallback((nextState: RehearsalState) => {
    rehearsalStateRef.current = nextState;
    setRehearsalState(nextState);
  }, []);

  const clearCarModeAutoStartTimeout = useCallback(() => {
    if (carModeAutoStartTimeoutRef.current !== null) {
      window.clearTimeout(carModeAutoStartTimeoutRef.current);
      carModeAutoStartTimeoutRef.current = null;
    }
  }, []);

  const clearCorrectionAudioCache = useCallback(() => {
    correctionAudioCacheRef.current.clear();
  }, []);

  const clearPrefetchedAudioIndexes = useCallback(() => {
    prefetchedAudioIndexesRef.current.clear();
    hasScheduledInitialAudioPrefetchRef.current = false;
  }, []);

  const debugLogText = serializeDebugLogEntries(debugLogEntries);
  const updateAvailable = isUpdateAvailable(APP_VERSION, latestVersion);
  const hasVersionData = Boolean(latestVersion);

  const showSlowPreparationHint = isSlowPreparation(slowPreparationSeconds * 1000);
  const showPreparationRecoveryAction = shouldOfferPreparationRecovery(slowPreparationSeconds * 1000);
  const shouldKeepScreenAwake = carMode && hasStarted && !isComplete;
  const shouldShowLaunchScreen = !hasStarted;
  const preferredAudioSessionType = resolvePreferredAudioSessionType({
    carMode,
    hasCompletedDeviceSetup,
    hasStarted,
    isPreparingDevice,
    isRecording,
  });

  const releaseWakeLock = useCallback(async () => {
    const currentWakeLock = wakeLockSentinelRef.current;
    wakeLockSentinelRef.current = null;

    if (!currentWakeLock) {
      return;
    }

    try {
      await currentWakeLock.release();
    } catch {
      // Wake lock release can fail if the browser already released it.
    }
  }, []);

  useEffect(() => {
    rehearsalStateRef.current = rehearsalState;
  }, [rehearsalState]);

  useEffect(() => {
    const result = setPreferredAudioSessionType(navigator, preferredAudioSessionType);
    if (!result.supported) {
      return;
    }

    if (lastAppliedAudioSessionTypeRef.current !== preferredAudioSessionType || result.changed) {
      lastAppliedAudioSessionTypeRef.current = preferredAudioSessionType;
      addDebugLog(
        'Audio Session Configured',
        `type=${preferredAudioSessionType}${result.state ? ` | state=${result.state}` : ''}`,
      );
    }
  }, [addDebugLog, preferredAudioSessionType]);

  useEffect(() => {
    return subscribeToAudioSessionState(navigator, (state) => {
      addDebugLog('Audio Session State Changed', `state=${state}`);

      if (!hasStarted) {
        return;
      }

      if (state === 'interrupted' || state === 'inactive') {
        queueAudioRecovery(
          carMode
            ? 'iPhone paused the car-mode audio session. Tap Re-enable Audio to keep spoken playback and microphone routing ready.'
            : 'iPhone paused spoken playback. Tap Re-enable Audio to keep the rehearsal moving.',
        );
      }
    });
  }, [addDebugLog, carMode, hasStarted, queueAudioRecovery]);

  useEffect(() => {
    const wakeLockApi = (navigator as NavigatorWithWakeLock).wakeLock;

    if (!carMode) {
      setWakeLockStatus('inactive');
      void releaseWakeLock();
      return;
    }

    if (!wakeLockApi) {
      setWakeLockStatus('unavailable');
      return;
    }

    if (!shouldKeepScreenAwake) {
      setWakeLockStatus('inactive');
      void releaseWakeLock();
      return;
    }

    let cancelled = false;

    const requestWakeLock = async () => {
      if (document.visibilityState !== 'visible') {
        setWakeLockStatus('inactive');
        return;
      }

      const activeWakeLock = wakeLockSentinelRef.current;
      if (activeWakeLock && !activeWakeLock.released) {
        setWakeLockStatus('active');
        return;
      }

      setWakeLockStatus('requesting');

      try {
        const wakeLockSentinel = await wakeLockApi.request('screen');

        if (cancelled) {
          await wakeLockSentinel.release().catch(() => undefined);
          return;
        }

        wakeLockSentinelRef.current = wakeLockSentinel;
        wakeLockSentinel.addEventListener('release', () => {
          if (wakeLockSentinelRef.current === wakeLockSentinel) {
            wakeLockSentinelRef.current = null;
          }

          if (!cancelled && shouldKeepScreenAwake) {
            setWakeLockStatus('inactive');
          }
        });
        setWakeLockStatus('active');
      } catch (err) {
        addDebugLog(
          'Wake Lock Error',
          err instanceof Error ? err.message : 'Unable to keep the screen awake',
        );
        setWakeLockStatus('error');
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseWakeLock();
    };
  }, [addDebugLog, carMode, releaseWakeLock, shouldKeepScreenAwake]);

  useEffect(() => {
    localStorage.setItem(
      PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        selectedCharacter,
        carMode,
        autoSpeakCorrections,
      } satisfies PracticePreferences),
    );
  }, [selectedCharacter, carMode, autoSpeakCorrections]);

  useEffect(() => {
    const previousCarMode = lastSelectedModeRef.current;
    lastSelectedModeRef.current = carMode;

    if (previousCarMode === carMode || hasStarted) {
      return;
    }

    releasePreparedRecordingSession();
    setHasCompletedDeviceSetup(false);
    setMicrophoneSetupStatus('idle');
    setMicrophoneSetupMessage(null);
    setPlaybackSetupStatus('idle');
    setPlaybackSetupMessage(null);
  }, [carMode, hasStarted, releasePreparedRecordingSession]);

  useEffect(() => {
    if (carMode && hasStarted && showSetup) {
      setShowSetup(false);
    }
  }, [carMode, hasStarted, showSetup]);

  useEffect(() => {
    async function loadScript() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}script.json`);
        if (!response.ok) {
          throw new Error('Failed to load script');
        }
        const rawData: RawScript = await response.json();
        setScript(normalizeScript(rawData));
        addDebugLog('Script Loaded', 'Loaded script.json successfully');
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load script');
        addDebugLog(
          'Script Load Error',
          err instanceof Error ? err.message : 'Failed to load script',
        );
      }
    }

    void loadScript();
  }, [addDebugLog]);

  useEffect(() => {
    if (!script) {
      return;
    }

    const availableCharacters = Array.from(
      new Set(script.lines.map((line) => line.character)),
    );

    if (
      availableCharacters.length > 0 &&
      (!selectedCharacter || !availableCharacters.includes(selectedCharacter))
    ) {
      setSelectedCharacter(availableCharacters[0]);
    }
  }, [script, selectedCharacter]);

  useEffect(() => {
    if (!hasStarted || isComplete || (rehearsalState !== 'idle' && rehearsalState !== 'processing')) {
      setSlowPreparationSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      setSlowPreparationSeconds(Math.floor(elapsedMs / 1000));
    }, 1_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasStarted, isComplete, rehearsalState]);

  const handleCheckVersion = useCallback(async () => {
    setIsCheckingVersion(true);
    const versionMetadata = await fetchLatestVersion();

    setLatestVersion(versionMetadata?.version ?? null);
    setVersionCheckedAt(new Date().toISOString());
    setIsCheckingVersion(false);

    if (!versionMetadata) {
      addDebugLog('Version Check', 'Unable to fetch latest version metadata');
      return;
    }

    addDebugLog('Version Check', `Current: ${APP_VERSION}, Latest: ${versionMetadata.version}`);
  }, [addDebugLog]);

  const handleApplyUpdate = useCallback(async () => {
    if (isApplyingUpdate) {
      return;
    }

    if (!navigator.onLine) {
      addDebugLog('App Update Blocked', 'Device is offline');
      toast({
        variant: 'destructive',
        title: 'Update Needs Internet',
        description: 'Connect to the internet before reloading the app update.',
      });
      return;
    }

    setIsApplyingUpdate(true);
    addDebugLog(
      'App Update Requested',
      `Current: ${APP_VERSION}, Latest: ${latestVersion ?? 'unknown'}`,
    );
    await capturePwaRuntimeDiagnostics(APP_VERSION, 'Pre-Update Snapshot');

    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration().catch(() => null);

        if (registration) {
          addDebugLog('Service Worker Update Check', `scope=${registration.scope}`);
          await registration.update();
          addDebugLog('Service Worker Update Triggered');

          if (registration.waiting) {
            registration.waiting.postMessage({ type: 'skip-waiting' });
            addDebugLog('Service Worker Skip Waiting Requested');
          }
        } else {
          addDebugLog('Service Worker Update Check', 'No registration found');
        }
      }
    } catch (error) {
      addDebugLog(
        'App Update Error',
        error instanceof Error ? error.message : 'Unable to refresh the app bundle',
      );
    }

    const reloadUrl = buildUpdateReloadUrl(window.location.href);
    addDebugLog('App Reload Requested', reloadUrl);
    window.location.replace(reloadUrl);
  }, [addDebugLog, isApplyingUpdate, latestVersion, toast]);

  useEffect(() => {
    void handleCheckVersion();
  }, [handleCheckVersion]);

  useEffect(() => {
    if (script && selectedCharacter) {
      clearAudioRecovery();
      clearCorrectionAudioCache();
      clearPrefetchedAudioIndexes();
      const lines = buildRehearsalLines(script, selectedCharacter);
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      updateRehearsalState('idle');
    }
  }, [
    clearAudioRecovery,
    clearCorrectionAudioCache,
    clearPrefetchedAudioIndexes,
    script,
    selectedCharacter,
    updateRehearsalState,
  ]);

  const characters = script ? Array.from(new Set(script.lines.map(l => l.character))) : [];
  const completedLines = rehearsalLines.filter(l => l.state === 'completed').length;
  const currentLine = currentLineIndex >= 0 ? rehearsalLines[currentLineIndex] : null;
  const canReplayExpectedLine = Boolean(
    currentLine &&
      currentLine.isUserLine &&
      currentLine.state === 'completed' &&
      currentLine.accuracy !== undefined &&
      currentLine.accuracy < 100,
  );
  const canRetryLine = Boolean(
    currentLine && currentLine.isUserLine && currentLine.state === 'completed',
  );
  const canGoPrevious = currentLineIndex > 0;
  const canGoNext = currentLineIndex >= 0 && rehearsalLines.length > 0;
  const canStartRehearsal =
    hasApiKey && Boolean(selectedCharacter) && hasCompletedDeviceSetup && !isPreparingDevice;

  const prefetchLineAudio = useCallback((lineIndex: number) => {
    if (!hasApiKey || lineIndex < 0) {
      return;
    }

    const line = rehearsalLinesRef.current[lineIndex];
    if (!line) {
      return;
    }

    const speakableText = getSpeakableText(line.text);
    if (!speakableText || prefetchedAudioIndexesRef.current.has(lineIndex)) {
      return;
    }

    prefetchedAudioIndexesRef.current.add(lineIndex);
    void prefetchTextToSpeech(speakableText, {
      voice: getVoiceForCharacter(line.character),
    }).then((didPrefetchSucceed) => {
      if (!didPrefetchSucceed) {
        prefetchedAudioIndexesRef.current.delete(lineIndex);
      }
    });
  }, [hasApiKey]);

  const prefetchLineWindow = useCallback((startIndex: number, lineCount: number) => {
    if (!hasApiKey || startIndex < 0) {
      return;
    }

    const finalIndex = Math.min(rehearsalLinesRef.current.length, startIndex + lineCount);
    for (let lineIndex = startIndex; lineIndex < finalIndex; lineIndex += 1) {
      prefetchLineAudio(lineIndex);
    }
  }, [hasApiKey, prefetchLineAudio]);

  useEffect(() => {
    if (
      !hasCompletedDeviceSetup ||
      !hasApiKey ||
      !script ||
      !selectedCharacter ||
      hasScheduledInitialAudioPrefetchRef.current
    ) {
      return;
    }

    hasScheduledInitialAudioPrefetchRef.current = true;
    addDebugLog(
      'Audio Prefetch Scheduled',
      `Warming the first ${INITIAL_AUDIO_PREFETCH_COUNT} rehearsal lines in the background`,
    );
    prefetchLineWindow(0, INITIAL_AUDIO_PREFETCH_COUNT);
  }, [
    addDebugLog,
    hasApiKey,
    hasCompletedDeviceSetup,
    prefetchLineWindow,
    script,
    selectedCharacter,
  ]);

  useEffect(() => {
    if (!hasStarted || currentLineIndex < 0 || !hasApiKey) {
      return;
    }

    prefetchLineWindow(currentLineIndex, LOOKAHEAD_AUDIO_PREFETCH_COUNT);
  }, [currentLineIndex, hasApiKey, hasStarted, prefetchLineWindow]);

  const playBlobWithRecovery = useCallback(
    async (pendingRecovery: PendingAudioRecovery): Promise<boolean> => {
      try {
        await playAudioBlob(pendingRecovery.audioBlob);
        clearAudioRecovery();
        return true;
      } catch (err) {
        if (isPlaybackPermissionError(err)) {
          const message =
            pendingRecovery.kind === 'correction'
              ? carMode
                ? 'Safari paused car-mode audio before the spoken correction. Tap Re-enable Audio to hear it.'
                : 'Safari paused audio before the spoken correction. Tap Re-enable Audio to hear it.'
              : carMode
                ? 'Safari paused car-mode playback. Tap Re-enable Audio to continue the scene.'
                : 'Safari paused spoken playback. Tap Re-enable Audio to continue the scene.';

          queueAudioRecovery(message, pendingRecovery);
          toast({
            title: 'Tap to Re-enable Audio',
            description: message,
          });
          return false;
        }

        throw err;
      }
    },
    [carMode, clearAudioRecovery, queueAudioRecovery, toast],
  );

  const speakExpectedLine = useCallback(
    async (lineIndex: number = currentLineIndexRef.current) => {
      const line = rehearsalLinesRef.current[lineIndex];
      if (!line) {
        return;
      }

      const expectedText = getSpeakableText(line.text);
      if (!expectedText) {
        updateRehearsalState('showing-feedback');
        return;
      }

      updateRehearsalState('playing-correction');
      addDebugLog('Playing Correction', `Line ${lineIndex + 1} (${line.character})`);

      try {
        let audioBlob = correctionAudioCacheRef.current.get(lineIndex);
        if (!audioBlob) {
          audioBlob = await textToSpeech(expectedText, {
            voice: getVoiceForCharacter(line.character),
          });
          correctionAudioCacheRef.current.set(lineIndex, audioBlob);
        }

        const didPlayCorrection = await playBlobWithRecovery({
          kind: 'correction',
          lineIndex,
          audioBlob,
        });
        if (!didPlayCorrection) {
          return;
        }

        setRehearsalLines((previousLines) =>
          previousLines.map((rehearsalLine, index) =>
            index === lineIndex
              ? { ...rehearsalLine, correctionPlayed: true }
              : rehearsalLine,
          ),
        );
      } catch (err) {
        addDebugLog(
          'Correction Playback Error',
          err instanceof Error ? err.message : 'Failed to read the correct line',
        );
        toast({
          variant: 'destructive',
          title: 'Correction Playback Error',
          description: err instanceof Error ? err.message : 'Failed to read the correct line',
        });
      } finally {
        updateRehearsalState('showing-feedback');
      }
    },
    [addDebugLog, playBlobWithRecovery, toast, updateRehearsalState],
  );

  const processLine = useCallback(async (lineIndex: number) => {
    const lines = rehearsalLinesRef.current;
    const line = lines[lineIndex];
    if (!line) {
      addDebugLog('Rehearsal Complete', 'Reached end of script');
      setIsComplete(true);
      return;
    }

    setRehearsalLines(prev => prev.map((l, i) => 
      i === lineIndex ? { ...l, state: 'active' } : l
    ));

    const speakableText = getSpeakableText(line.text);

    if (!speakableText) {
      addDebugLog('Skipped Silent Line', `Line ${lineIndex + 1} has no speakable text`);
      setRehearsalLines(prev => prev.map((l, i) => 
        i === lineIndex
          ? {
              ...l,
              state: 'completed',
              spokenText: '',
              diff: [],
              accuracy: 100,
            }
          : l
      ));

      const nextIndex = lineIndex + 1;
      const currentLines = rehearsalLinesRef.current;
      if (nextIndex < currentLines.length) {
        setCurrentLineIndex(nextIndex);
        setTimeout(() => {
          void processLine(nextIndex);
        }, 300);
      } else {
        addDebugLog('Rehearsal Complete', 'Reached end of script');
        setIsComplete(true);
        updateRehearsalState('idle');
      }
      return;
    }

    if (!line.isUserLine) {
      updateRehearsalState('playing-tts');
      addDebugLog('Playing Partner Line', `Line ${lineIndex + 1} (${line.character})`);
      let shouldAdvanceAfterPlayback = true;

      try {
        const audioBlob = await textToSpeech(speakableText, {
          voice: getVoiceForCharacter(line.character),
        });
        shouldAdvanceAfterPlayback = await playBlobWithRecovery({
          kind: 'partner-line',
          lineIndex,
          audioBlob,
        });
      } catch (err) {
        addDebugLog(
          'TTS Error',
          err instanceof Error ? err.message : 'Failed to speak line',
        );
        toast({
          variant: 'destructive',
          title: 'TTS Error',
          description: err instanceof Error ? err.message : 'Failed to speak line',
        });
      }

      if (!shouldAdvanceAfterPlayback) {
        return;
      }

      setRehearsalLines(prev => prev.map((l, i) => 
        i === lineIndex ? { ...l, state: 'completed' } : l
      ));

      const nextIndex = lineIndex + 1;
      const currentLines = rehearsalLinesRef.current;
      if (nextIndex < currentLines.length) {
        setCurrentLineIndex(nextIndex);
        setTimeout(() => {
          void processLine(nextIndex);
        }, 500);
      } else {
        addDebugLog('Rehearsal Complete', 'Reached end of script');
        setIsComplete(true);
        updateRehearsalState('idle');
      }
    } else {
      addDebugLog('Waiting For User Line', `Line ${lineIndex + 1} (${line.character})`);
      updateRehearsalState('waiting-for-user');
    }
  }, [addDebugLog, playBlobWithRecovery, toast, updateRehearsalState]);

  const handleStart = useCallback(async () => {
    if (isStartingRef.current) {
      return;
    }

    if (!hasApiKey) {
      toast({
        variant: 'destructive',
        title: 'API Key Required',
        description: 'Please enter your OpenAI API key to start rehearsing',
      });
      return;
    }
    if (!selectedCharacter) {
      toast({
        variant: 'destructive',
        title: 'Character Required',
        description: 'Please select your character',
      });
      return;
    }
    if (!script) {
      toast({
        variant: 'destructive',
        title: 'Script Not Ready',
        description: 'Please wait for the script to finish loading',
      });
      return;
    }

    isStartingRef.current = true;
    try {
      if (needsRehearsalLineInitialization(rehearsalLinesRef.current, script, selectedCharacter)) {
        const initializedLines = buildRehearsalLines(script, selectedCharacter);
        rehearsalLinesRef.current = initializedLines;
        setRehearsalLines(initializedLines);
        addDebugLog('Session Prep', 'Initialized rehearsal lines before starting');
      }

      addDebugLog('Session Started', `Character: ${selectedCharacter}`);
      await startSessionTransition({
        setShowSetup,
        setHasStarted,
        setCurrentLineIndex,
        primeAudioPlayback,
        processFirstLine: () => {
          void processLine(0);
        },
        onPrimeAudioPlaybackError: (error) => {
          addDebugLog(
            'Audio Priming Error',
            `Session start: ${error instanceof Error ? error.message : 'Audio playback priming failed'}`,
          );
        },
      });
    } finally {
      isStartingRef.current = false;
    }
  }, [addDebugLog, hasApiKey, processLine, rehearsalLinesRef, script, selectedCharacter, toast]);

  const handlePrepareDevice = useCallback(async () => {
    if (isPreparingDevice) {
      return;
    }

    setIsPreparingDevice(true);
    setMicrophoneSetupStatus('pending');
    setMicrophoneSetupMessage(null);
    setPlaybackSetupStatus('pending');
    setPlaybackSetupMessage(null);
    addDebugLog('Device Setup Started', `Car mode: ${carMode ? 'on' : 'off'}`);

    try {
      const result = await prepareDeviceForRehearsal({
        primeAudioPlayback,
        prepareMicrophone: () =>
          carMode
            ? prepareRecordingSession()
            : prepareMicrophoneAccess(navigator.mediaDevices, carMode),
        onPlaybackReady: () => {
          setPlaybackSetupStatus('ready');
          addDebugLog('Playback Ready', 'Audio playback primed before rehearsal');
        },
        onPlaybackError: (error) => {
          const message = getPreparationErrorMessage(
            error,
            'Audio playback could not be prepared',
          );
          setPlaybackSetupStatus('error');
          setPlaybackSetupMessage(message);
          addDebugLog('Playback Prep Error', message);
        },
        onMicrophoneReady: () => {
          setMicrophoneSetupStatus('ready');
          addDebugLog(
            'Microphone Ready',
            carMode
              ? 'Microphone permission granted and kept warm for car mode'
              : 'Microphone permission granted before rehearsal',
          );
        },
        onMicrophoneError: (error) => {
          const message = getPreparationErrorMessage(
            error,
            'Microphone access could not be prepared',
          );
          setMicrophoneSetupStatus('error');
          setMicrophoneSetupMessage(message);
          addDebugLog('Microphone Prep Error', message);
        },
      });

      if (result.playbackReady && result.microphoneReady) {
        clearAudioRecovery();
        setHasCompletedDeviceSetup(true);
        toast({
          title: 'Device Ready',
          description: carMode
            ? 'Microphone, playback, and car-mode audio routing are prepared for rehearsal.'
            : 'Microphone and playback are prepared for a smoother rehearsal start.',
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Device Setup Incomplete',
          description: 'Check the messages on screen, then run the preparation step again.',
        });
      }
    } finally {
      setIsPreparingDevice(false);
    }
  }, [addDebugLog, carMode, clearAudioRecovery, isPreparingDevice, prepareRecordingSession, toast]);

  const handleReenableAudio = useCallback(async () => {
    if (isRecoveringAudio) {
      return;
    }

    setIsRecoveringAudio(true);
    const pendingRecovery = pendingAudioRecoveryRef.current;
    addDebugLog(
      'Audio Recovery Requested',
      pendingRecovery
        ? `${pendingRecovery.kind} | line ${pendingRecovery.lineIndex + 1}`
        : 'Manual audio re-arm',
    );

    try {
      const result = await prepareDeviceForRehearsal({
        primeAudioPlayback,
        prepareMicrophone: async () => {
          if (carMode) {
            await prepareRecordingSession();
          }
        },
        onPlaybackReady: () => {
          addDebugLog('Playback Ready', 'Audio playback re-enabled after interruption');
        },
        onPlaybackError: (error) => {
          addDebugLog(
            'Playback Prep Error',
            getPreparationErrorMessage(error, 'Audio playback could not be re-enabled'),
          );
        },
        onMicrophoneReady: () => {
          if (carMode) {
            addDebugLog('Microphone Ready', 'Car-mode microphone session re-armed after interruption');
          }
        },
        onMicrophoneError: (error) => {
          if (carMode) {
            addDebugLog(
              'Microphone Prep Error',
              getPreparationErrorMessage(error, 'Microphone access could not be re-armed'),
            );
          }
        },
      });

      if (!result.playbackReady || !result.microphoneReady) {
        throw new Error(
          carMode
            ? 'Audio or microphone could not be re-enabled. Try the button again.'
            : 'Audio could not be re-enabled. Try the button again.',
        );
      }

      clearAudioRecovery();

      if (!pendingRecovery) {
        toast({
          title: 'Audio Re-enabled',
          description: carMode
            ? 'Spoken playback and car-mode audio are ready again.'
            : 'Spoken playback is ready again.',
        });
        return;
      }

      pendingAudioRecoveryRef.current = null;
      const didReplayBlockedAudio = await playBlobWithRecovery(pendingRecovery);
      if (!didReplayBlockedAudio) {
        return;
      }

      if (pendingRecovery.kind === 'correction') {
        setRehearsalLines((previousLines) =>
          previousLines.map((rehearsalLine, index) =>
            index === pendingRecovery.lineIndex
              ? { ...rehearsalLine, correctionPlayed: true }
              : rehearsalLine,
          ),
        );
        return;
      }

      setRehearsalLines((previousLines) =>
        previousLines.map((rehearsalLine, index) =>
          index === pendingRecovery.lineIndex
            ? { ...rehearsalLine, state: 'completed' }
            : rehearsalLine,
        ),
      );

      const nextIndex = pendingRecovery.lineIndex + 1;
      const currentLines = rehearsalLinesRef.current;
      if (nextIndex < currentLines.length) {
        setCurrentLineIndex(nextIndex);
        window.setTimeout(() => {
          void processLine(nextIndex);
        }, 500);
      } else {
        addDebugLog('Rehearsal Complete', 'Reached end of script');
        setIsComplete(true);
        updateRehearsalState('idle');
      }
    } catch (err) {
      const message = getPreparationErrorMessage(err, 'Audio could not be re-enabled');
      setAudioRecoveryMessage(message);
      toast({
        variant: 'destructive',
        title: 'Audio Still Needs Attention',
        description: message,
      });
    } finally {
      setIsRecoveringAudio(false);
    }
  }, [
    addDebugLog,
    carMode,
    clearAudioRecovery,
    isRecoveringAudio,
    playBlobWithRecovery,
    prepareRecordingSession,
    primeAudioPlayback,
    processLine,
    toast,
    updateRehearsalState,
  ]);

  const handleStartRecording = useCallback(async () => {
    if (
      isStartingRecordingRef.current ||
      isStoppingRecordingRef.current ||
      isRecordingRef.current ||
      rehearsalStateRef.current === 'recording'
    ) {
      return;
    }

    isStartingRecordingRef.current = true;

    try {
      clearCarModeAutoStartTimeout();
      const recordingAudioSessionResult = setPreferredAudioSessionType(
        navigator,
        'play-and-record',
      );
      if (
        recordingAudioSessionResult.supported &&
        lastAppliedAudioSessionTypeRef.current !== 'play-and-record'
      ) {
        lastAppliedAudioSessionTypeRef.current = 'play-and-record';
        addDebugLog(
          'Audio Session Configured',
          `type=play-and-record${recordingAudioSessionResult.state ? ` | state=${recordingAudioSessionResult.state}` : ''}`,
        );
      }

      if (carMode) {
        await playRecordingStartCue().catch((error) => {
          addDebugLog(
            'Recording Start Cue Error',
            error instanceof Error ? error.message : 'Recording start cue failed',
          );
        });
      }

      const didStartRecording = await startRecordingTransition({
        startRecording,
        primeAudioPlayback,
        onPrimeAudioPlaybackError: (error) => {
          addDebugLog(
            'Audio Priming Error',
            `Recording start: ${error instanceof Error ? error.message : 'Audio playback priming failed'}`,
          );
        },
      });

      if (!didStartRecording) {
        return;
      }

      updateRehearsalState('recording');
      addDebugLog('Recording Started');
    } catch (err) {
      addDebugLog(
        'Microphone Error',
        err instanceof Error ? err.message : 'Microphone access denied',
      );
      toast({
        variant: 'destructive',
        title: 'Microphone Error',
        description: 'Please allow microphone access to record your lines',
      });
    } finally {
      isStartingRecordingRef.current = false;
    }
  }, [
    addDebugLog,
    carMode,
    clearCarModeAutoStartTimeout,
    playRecordingStartCue,
    primeAudioPlayback,
    startRecording,
    toast,
    updateRehearsalState,
  ]);

  const handleStopRecording = useCallback(async () => {
    if (isStoppingRecordingRef.current) {
      return;
    }
    isStoppingRecordingRef.current = true;
    updateRehearsalState('processing');
    addDebugLog('Recording Stopped', 'Processing user audio');
    
    try {
      const audioBlob = await stopRecording();
      if (discardActiveRecordingRef.current) {
        discardActiveRecordingRef.current = false;
        updateRehearsalState('idle');
        return;
      }

      void primeAudioPlayback().catch((error) => {
        addDebugLog(
          'Audio Priming Error',
          `Stop recording: ${error instanceof Error ? error.message : 'Audio playback priming failed'}`,
        );
      });
      const idx = currentLineIndexRef.current;
      const currentLine = rehearsalLinesRef.current[idx];
      if (!currentLine || !script) {
        throw new Error('No active line to score');
      }

      const expectedText = getSpeakableText(currentLine.text);
      const transcription = await speechToText(audioBlob, {
        prompt: buildTranscriptionPrompt(script, selectedCharacter, expectedText),
      });
      const diff = computeWordDiff(expectedText, transcription);
      const accuracy = calculateAccuracy(diff);
      const hasMeaningfulErrors = diff.some((item) => item.status !== 'correct');
      addDebugLog(
        'Line Scored',
        `Line ${idx + 1} accuracy: ${Math.round(accuracy)}%, transcription: "${transcription}"`,
      );

      setRehearsalLines(prev => prev.map((l, i) => 
        i === idx 
          ? { 
              ...l, 
              state: 'completed',
              spokenText: transcription,
              diff,
              accuracy,
              correctionPlayed: false,
            } 
          : l
      ));

      if (hasMeaningfulErrors && autoSpeakCorrections) {
        addDebugLog('Auto Correction Triggered', `Line ${idx + 1}`);
        await speakExpectedLine(idx);
      } else {
        updateRehearsalState('showing-feedback');
      }
    } catch (err) {
      if (discardActiveRecordingRef.current) {
        discardActiveRecordingRef.current = false;
        updateRehearsalState('idle');
        return;
      }

      const errorMessage = err instanceof Error ? err.message : 'Failed to transcribe audio';

      if (errorMessage === NO_SPEECH_DETECTED_ERROR) {
        addDebugLog('No Speech Detected', 'Car mode auto-stop did not hear any speech');
        toast({
          title: 'No Speech Detected',
          description: 'Car mode stopped listening because it did not hear speech. Try the line again.',
        });
        updateRehearsalState('waiting-for-user');
        return;
      }

      if (errorMessage === NO_AUDIO_CAPTURED_ERROR) {
        addDebugLog('Empty Recording', 'No audio data was captured before transcription');
        toast({
          title: 'Recording Was Empty',
          description: 'The browser returned an empty recording. Please try the line again.',
        });
        updateRehearsalState('waiting-for-user');
        return;
      }

      addDebugLog(
        'Transcription Error',
        errorMessage,
      );
      toast({
        variant: 'destructive',
        title: 'Transcription Error',
        description: errorMessage,
      });
      updateRehearsalState('waiting-for-user');
    } finally {
      isStoppingRecordingRef.current = false;
    }
  }, [
    addDebugLog,
    autoSpeakCorrections,
    script,
    selectedCharacter,
    speakExpectedLine,
    stopRecording,
    toast,
    updateRehearsalState,
  ]);

  useEffect(() => {
    onSilenceTimeoutRef.current = () => {
      if (!carMode || !isRecording || isStoppingRecordingRef.current) {
        return;
      }

      addDebugLog('Silence Auto-Stop', 'No voice detected for 5 seconds in car mode');
      void handleStopRecording();
    };
  }, [addDebugLog, carMode, handleStopRecording, isRecording]);

  const handleReplayExpectedLine = useCallback(async () => {
    clearAudioRecovery();
    await primeAudioPlayback().catch(() => undefined);
    void speakExpectedLine();
  }, [clearAudioRecovery, speakExpectedLine]);

  const handleRetryLine = useCallback(() => {
    const idx = currentLineIndexRef.current;
    if (idx < 0) {
      return;
    }

    clearAudioRecovery();
    setRehearsalLines((previousLines) =>
      previousLines.map((line, index) =>
        index === idx
          ? {
              ...line,
              state: 'active',
              spokenText: undefined,
              diff: undefined,
              accuracy: undefined,
              correctionPlayed: false,
            }
          : line,
      ),
    );
    updateRehearsalState('waiting-for-user');
    addDebugLog('Retry Line', `Line ${idx + 1}`);
  }, [addDebugLog, clearAudioRecovery, updateRehearsalState]);

  const navigateToLine = useCallback((
    targetIndex: number,
    direction: 'previous' | 'next',
  ) => {
    if (!TRACK_NAVIGATION_STATES.includes(rehearsalStateRef.current)) {
      return;
    }

    const lines = rehearsalLinesRef.current;
    if (targetIndex < 0 || targetIndex >= lines.length) {
      return;
    }

    clearCarModeAutoStartTimeout();
    clearAudioRecovery();

    const nextLines = buildNavigationTargetLines(lines, targetIndex);

    rehearsalLinesRef.current = nextLines;
    currentLineIndexRef.current = targetIndex;
    rehearsalStateRef.current = 'idle';

    setIsComplete(false);
    setRehearsalLines(nextLines);
    setCurrentLineIndex(targetIndex);
    updateRehearsalState('idle');
    addDebugLog(
      direction === 'previous' ? 'Moved To Previous Line' : 'Moved To Next Line',
      `Line ${targetIndex + 1}`,
    );

    void processLine(targetIndex);
  }, [addDebugLog, clearAudioRecovery, clearCarModeAutoStartTimeout, processLine, updateRehearsalState]);

  const handlePrevious = useCallback(() => {
    navigateToLine(currentLineIndexRef.current - 1, 'previous');
  }, [navigateToLine]);

  const handleNext = useCallback(() => {
    if (!TRACK_NAVIGATION_STATES.includes(rehearsalStateRef.current)) {
      return;
    }

    clearCarModeAutoStartTimeout();

    const idx = currentLineIndexRef.current;
    const lines = rehearsalLinesRef.current;
    const nextIndex = idx + 1;
    if (nextIndex < lines.length) {
      navigateToLine(nextIndex, 'next');
    } else {
      const completedLines = buildNavigationTargetLines(lines, lines.length);

      rehearsalLinesRef.current = completedLines;
      addDebugLog('Rehearsal Complete', 'Reached end of script');
      setIsComplete(true);
      setRehearsalLines(completedLines);
      updateRehearsalState('idle');
    }
  }, [addDebugLog, clearCarModeAutoStartTimeout, navigateToLine, updateRehearsalState]);

  const handleSkipLine = useCallback(() => {
    const idx = currentLineIndexRef.current;
    const line = rehearsalLinesRef.current[idx];
    if (!line || !line.isUserLine) {
      return;
    }

    clearCarModeAutoStartTimeout();
    clearAudioRecovery();

    setRehearsalLines((previousLines) =>
      previousLines.map((rehearsalLine, index) =>
        index === idx ? buildSkippedUserLine(rehearsalLine) : rehearsalLine,
      ),
    );
    addDebugLog('Line Skipped', `Line ${idx + 1} (${line.character})`);
    updateRehearsalState('showing-feedback');
  }, [addDebugLog, clearAudioRecovery, clearCarModeAutoStartTimeout, updateRehearsalState]);

  const handleRestart = useCallback(async () => {
    clearCarModeAutoStartTimeout();
    clearAudioRecovery();
    clearCorrectionAudioCache();
    clearPrefetchedAudioIndexes();
    setShowSetup(false);

    if (isRecordingRef.current || isStoppingRecordingRef.current) {
      discardActiveRecordingRef.current = true;

      if (!isStoppingRecordingRef.current) {
        isStoppingRecordingRef.current = true;
        try {
          await stopRecording();
          addDebugLog('Recording Discarded', 'Active recording stopped during session restart');
        } catch (error) {
          addDebugLog(
            'Recording Discarded',
            error instanceof Error ? error.message : 'Active recording stopped during session restart',
          );
        } finally {
          discardActiveRecordingRef.current = false;
          isStoppingRecordingRef.current = false;
        }
      }
    }

    addDebugLog('Session Restarted');
    if (script && selectedCharacter) {
      const lines = buildRehearsalLines(script, selectedCharacter);
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      updateRehearsalState('idle');
    }
  }, [
    addDebugLog,
    clearAudioRecovery,
    clearCarModeAutoStartTimeout,
    clearCorrectionAudioCache,
    clearPrefetchedAudioIndexes,
    script,
    selectedCharacter,
    stopRecording,
    updateRehearsalState,
  ]);

  const handleRecoverPreparation = useCallback(() => {
    const idx = currentLineIndexRef.current;
    if (idx < 0) {
      return;
    }

    addDebugLog('Manual Preparation Retry', `Retrying line ${idx + 1}`);
    void processLine(idx);
  }, [addDebugLog, processLine]);

  const handleToggleSetup = useCallback(() => {
    if (carMode && hasStarted) {
      return;
    }

    setShowSetup(prev => !prev);
  }, [carMode, hasStarted]);

  const handleCarModePlayOrNext = useCallback(() => {
    const activeLine = rehearsalLinesRef.current[currentLineIndexRef.current];

    if (
      rehearsalStateRef.current === 'waiting-for-user' &&
      activeLine?.isUserLine &&
      !isRecordingRef.current
    ) {
      void handleStartRecording();
      return;
    }

    handleNext();
  }, [handleNext, handleStartRecording]);

  const handleCopyDebugLogs = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(debugLogText);
      addDebugLog('Debug Logs Copied');
      toast({
        title: 'Debug Logs Copied',
        description: 'The logs are in your clipboard and ready to paste.',
      });
    } catch (err) {
      addDebugLog(
        'Copy Debug Logs Error',
        err instanceof Error ? err.message : 'Clipboard write failed',
      );
      toast({
        variant: 'destructive',
        title: 'Copy Failed',
        description: 'Unable to copy debug logs. You can still select and copy from the box.',
      });
    }
  }, [addDebugLog, debugLogText, toast]);

  const handleDownloadDebugLogs = useCallback(() => {
    const fileName = `rehearsal-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const blob = new Blob([debugLogText], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(blobUrl);
    addDebugLog('Debug Logs Downloaded', fileName);
  }, [addDebugLog, debugLogText]);

  const handleCapturePwaDiagnostics = useCallback(async () => {
    await capturePwaRuntimeDiagnostics(APP_VERSION, 'Manual PWA Snapshot', true);
    requestServiceWorkerDebugSnapshot();
    toast({
      title: 'PWA Diagnostics Captured',
      description: 'Current PWA and mobile runtime details were added to the debug log.',
    });
  }, [toast]);

  useEffect(() => {
    consumeQueuedPwaDebugLogs().forEach((entry) => {
      addDebugLog(entry.event, entry.details);
    });

    return subscribeToPwaDebugLogs((entry) => {
      addDebugLog(entry.event, entry.details);
    });
  }, [addDebugLog]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) {
      return;
    }

    if (!script || !carMode || !hasStarted || isComplete) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      setMediaSessionActionHandler('nexttrack', null);
      setMediaSessionActionHandler('previoustrack', null);
      setMediaSessionActionHandler('play', null);
      setMediaSessionActionHandler('pause', null);
      setMediaSessionActionHandler('stop', null);
      return;
    }

    if ('MediaMetadata' in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: script.title,
        artist: selectedCharacter ? `Practicing as ${selectedCharacter}` : 'Rehearsal Partner',
        album: currentLine
          ? `Line ${currentLine.index + 1}: ${currentLine.character}`
          : 'Car mode rehearsal',
      });
    }

    navigator.mediaSession.playbackState =
      rehearsalState === 'playing-tts' || rehearsalState === 'playing-correction'
        ? 'playing'
        : 'paused';

    setMediaSessionActionHandler('nexttrack', handleCarModePlayOrNext);
    setMediaSessionActionHandler('previoustrack', handlePrevious);
    setMediaSessionActionHandler('play', () => {
      if (rehearsalStateRef.current === 'waiting-for-user' && !isRecordingRef.current) {
        void handleStartRecording();
      }
    });
    setMediaSessionActionHandler('pause', () => {
      if (isRecordingRef.current) {
        void handleStopRecording();
      }
    });
    setMediaSessionActionHandler('stop', () => {
      if (isRecordingRef.current) {
        void handleStopRecording();
      }
    });

    return () => {
      setMediaSessionActionHandler('nexttrack', null);
      setMediaSessionActionHandler('previoustrack', null);
      setMediaSessionActionHandler('play', null);
      setMediaSessionActionHandler('pause', null);
      setMediaSessionActionHandler('stop', null);
    };
  }, [
    carMode,
    currentLine,
    handleCarModePlayOrNext,
    handleStartRecording,
    handleStopRecording,
    handlePrevious,
    hasStarted,
    isComplete,
    rehearsalState,
    script,
    selectedCharacter,
  ]);

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Alert variant="destructive" className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to Load Script</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!script) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse flex items-center gap-3">
          <Theater className="w-8 h-8 text-primary" />
          <span className="text-lg text-muted-foreground">Loading script...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col overflow-x-hidden',
        carMode && hasStarted ? 'h-[100dvh] max-h-[100dvh] overflow-hidden' : 'min-h-screen',
      )}
    >
      <header className={cn(
        'safe-area-top safe-area-x border-b border-border bg-background/95 backdrop-blur z-50 supports-[backdrop-filter]:bg-background/80',
        carMode && hasStarted ? 'shrink-0' : 'sticky top-0',
      )}>
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Theater className="w-6 h-6 text-primary" />
            <span className="font-serif font-semibold text-lg">Rehearsal Partner</span>
          </div>
          <div className="flex items-center gap-2">
            {(!hasStarted || !carMode) && (
              <Button
                data-testid="button-toggle-setup"
                size="icon"
                variant="ghost"
                onClick={handleToggleSetup}
              >
                <Settings className="w-5 h-5" />
              </Button>
            )}
            {hasStarted && carMode && (
              <Button
                data-testid="button-end-session"
                type="button"
                size="sm"
                variant="outline"
                onClick={handleRestart}
              >
                End Session
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main
        className={cn(
          'flex-1 flex flex-col min-h-0 max-w-4xl mx-auto w-full',
          carMode && hasStarted && 'overflow-hidden',
        )}
      >
        {shouldShowLaunchScreen && (
          <DeviceSetupScreen
            apiKeySection={<ApiKeyInput onKeyChange={setHasApiKey} />}
            characterSection={
              <CharacterSelector
                characters={characters}
                selectedCharacter={selectedCharacter}
                onSelect={setSelectedCharacter}
                disabled={false}
              />
            }
            autoSpeakCorrections={autoSpeakCorrections}
            canStart={canStartRehearsal}
            carMode={carMode}
            isDeviceReady={hasCompletedDeviceSetup}
            isPreparing={isPreparingDevice}
            microphoneStatus={microphoneSetupStatus}
            microphoneMessage={microphoneSetupMessage}
            playbackStatus={playbackSetupStatus}
            playbackMessage={playbackSetupMessage}
            onAutoSpeakCorrectionsChange={setAutoSpeakCorrections}
            onCarModeChange={setCarMode}
            onPrepare={() => {
              void handlePrepareDevice();
            }}
            onStart={() => {
              void handleStart();
            }}
          />
        )}

        {showSetup && (!hasStarted || !carMode) && (
          <div className="p-4 space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <ApiKeyInput onKeyChange={setHasApiKey} />
              <CharacterSelector
                characters={characters}
                selectedCharacter={selectedCharacter}
                onSelect={setSelectedCharacter}
                disabled={hasStarted && !isComplete}
              />
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <CarFront className="w-5 h-5 text-primary" />
                    Practice Options
                  </CardTitle>
                  <CardDescription>
                    Tuned for solo rehearsal and quick use on your phone
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="car-mode">Car mode</Label>
                      <p className="text-sm text-muted-foreground">
                        Larger controls, stronger microphone cleanup, and a simpler hands-free flow.
                      </p>
                    </div>
                    <Switch
                      id="car-mode"
                      checked={carMode}
                      onCheckedChange={setCarMode}
                      disabled={hasStarted}
                    />
                  </div>
                  {hasStarted && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
                      Close the current session to switch between normal mode and car mode.
                    </div>
                  )}

                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="spoken-corrections">Speak the correct line when I miss it</Label>
                      <p className="text-sm text-muted-foreground">
                        After a mismatch, the app reads the expected line aloud before you continue.
                      </p>
                    </div>
                    <Switch
                      id="spoken-corrections"
                      checked={autoSpeakCorrections}
                      onCheckedChange={setAutoSpeakCorrections}
                    />
                  </div>

                  <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                    Scoring ignores punctuation and stage directions inside parentheses.
                  </div>
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Debug Logs</CardTitle>
                <CardDescription>
                  Copy or download this ready-to-paste log when you need help debugging, including PWA, service worker, and mobile runtime diagnostics.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  data-testid="debug-log-output"
                  value={debugLogText}
                  readOnly
                  className="min-h-40 font-mono text-xs"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void handleCopyDebugLogs();
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    Copy logs
                  </Button>
                  <Button type="button" variant="outline" onClick={handleDownloadDebugLogs}>
                    <Download className="mr-2 h-4 w-4" />
                    Download logs
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void handleCapturePwaDiagnostics()}>
                    <Smartphone className="mr-2 h-4 w-4" />
                    Capture PWA status
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">App Version</CardTitle>
                <CardDescription>
                  Check whether this device is already on the latest release.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>
                  Current version: <strong>{APP_VERSION}</strong>
                </p>
                <p>
                  Latest available:{' '}
                  <strong>{latestVersion ?? (isCheckingVersion ? 'Checking…' : 'Unavailable')}</strong>
                </p>
                <p
                  className={
                    !hasVersionData
                      ? 'text-muted-foreground'
                      : updateAvailable
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-green-600 dark:text-green-400'
                  }
                >
                  {!hasVersionData
                    ? 'Latest version could not be checked right now.'
                    : updateAvailable
                    ? 'An update is available. Reload the app to install it.'
                    : 'You are using the latest version.'}
                </p>
                {versionCheckedAt && (
                  <p className="text-muted-foreground">
                    Last checked: {new Date(versionCheckedAt).toLocaleString()}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isCheckingVersion}
                    onClick={() => void handleCheckVersion()}
                  >
                    {isCheckingVersion ? 'Checking…' : 'Check for updates'}
                  </Button>
                  {updateAvailable && (
                    <Button
                      type="button"
                      disabled={isApplyingUpdate}
                      onClick={() => {
                        void handleApplyUpdate();
                      }}
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      {isApplyingUpdate ? 'Reloading…' : 'Reload app now'}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {!shouldShowLaunchScreen && (
          <>
            {!carMode && (
              <ScriptHeader
                title={script.title}
                author={script.author}
                totalLines={script.lines.length}
                completedLines={completedLines}
                userCharacter={selectedCharacter}
                carMode={carMode}
                autoSpeakCorrections={autoSpeakCorrections}
                wakeLockStatus={wakeLockStatus}
                showWakeLockStatus={shouldKeepScreenAwake}
              />
            )}

            {carMode ? (
              <CarModeStage
                autoSpeakCorrections={autoSpeakCorrections}
                canGoNext={canGoNext}
                canGoPrevious={canGoPrevious}
                completedLines={completedLines}
                currentLine={currentLine}
                rehearsalState={rehearsalState}
                scriptTitle={script.title}
                totalLines={script.lines.length}
                userCharacter={selectedCharacter}
              />
            ) : (
              <RehearsalTimeline
                lines={rehearsalLines}
                currentLineIndex={currentLineIndex}
              />
            )}

            <div
              className={cn(
                'safe-area-bottom safe-area-x border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80',
                carMode ? 'shrink-0' : 'sticky bottom-0',
              )}
            >
              <div className="p-4">
                {audioRecoveryMessage && (
                  <Alert className="mb-4 border-primary/40 bg-primary/5">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Safari Needs One More Tap</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{audioRecoveryMessage}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          data-testid="button-reenable-audio"
                          onClick={() => {
                            void handleReenableAudio();
                          }}
                          disabled={isRecoveringAudio}
                        >
                          <RefreshCw className={isRecoveringAudio ? 'mr-2 h-4 w-4 animate-spin' : 'mr-2 h-4 w-4'} />
                          {isRecoveringAudio ? 'Re-enabling…' : 'Re-enable Audio'}
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
                <RehearsalControls
                  state={rehearsalState}
                  onStartRecording={handleStartRecording}
                  onStopRecording={handleStopRecording}
                  onPrevious={handlePrevious}
                  onNext={handleNext}
                  onStart={handleStart}
                  onRestart={handleRestart}
                  onReplayExpectedLine={handleReplayExpectedLine}
                  onRetryLine={handleRetryLine}
                  onSkipLine={handleSkipLine}
                  onRecoverPreparation={handleRecoverPreparation}
                  hasStarted={hasStarted}
                  isComplete={isComplete}
                  carMode={carMode}
                  canReplayExpectedLine={canReplayExpectedLine}
                  canRetryLine={canRetryLine}
                  canGoPrevious={canGoPrevious}
                  canGoNext={canGoNext}
                  disabled={!hasApiKey || !selectedCharacter}
                  showSlowPreparationHint={showSlowPreparationHint}
                  slowPreparationSeconds={slowPreparationSeconds}
                  showPreparationRecoveryAction={showPreparationRecoveryAction}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
