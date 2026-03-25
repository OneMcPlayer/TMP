import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ApiKeyInput } from '@/components/api-key-input';
import { CharacterSelector } from '@/components/character-selector';
import { DeviceSetupScreen } from '@/components/device-setup-screen';
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
  textToSpeech,
  speechToText,
  playAudioBlob,
  getApiKey,
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
import { AlertCircle, CarFront, Copy, Download, RefreshCw, Settings, Smartphone, Theater } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const PREFERENCES_STORAGE_KEY = 'rehearsal_preferences';
const TRACK_NAVIGATION_STATES: RehearsalState[] = ['waiting-for-user', 'showing-feedback'];
const CAR_MODE_AUTO_START_DELAY_MS = 1000;

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
  const isAutoStartingRecordingRef = useRef(false);
  const onSilenceTimeoutRef = useRef<(() => void) | null>(null);
  const { startRecording, stopRecording, isRecording } = useAudioRecorder({
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
  const [showSetup, setShowSetup] = useState(true);
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

  const rehearsalLinesRef = useRef<RehearsalLine[]>([]);
  const currentLineIndexRef = useRef(-1);
  const isStartingRef = useRef(false);
  const isStartingRecordingRef = useRef(false);
  const isRecordingRef = useRef(false);
  const rehearsalStateRef = useRef<RehearsalState>('idle');
  const carModeAutoStartTimeoutRef = useRef<number | null>(null);
  const wakeLockSentinelRef = useRef<WakeLockSentinel | null>(null);

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

  const debugLogText = serializeDebugLogEntries(debugLogEntries);
  const updateAvailable = isUpdateAvailable(APP_VERSION, latestVersion);
  const hasVersionData = Boolean(latestVersion);

  const showSlowPreparationHint = isSlowPreparation(slowPreparationSeconds * 1000);
  const showPreparationRecoveryAction = shouldOfferPreparationRecovery(slowPreparationSeconds * 1000);
  const shouldKeepScreenAwake = carMode && hasStarted && !isComplete;
  const shouldShowFirstSetupScreen = showSetup && !hasStarted && !hasCompletedDeviceSetup;

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
      const lines = buildRehearsalLines(script, selectedCharacter);
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      updateRehearsalState('idle');
    }
  }, [script, selectedCharacter, updateRehearsalState]);

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
        const audioBlob = await textToSpeech(expectedText, {
          voice: getVoiceForCharacter(line.character),
        });
        await playAudioBlob(audioBlob);

        setRehearsalLines((previousLines) =>
          previousLines.map((rehearsalLine, index) =>
            index === lineIndex
              ? { ...rehearsalLine, correctionPlayed: true }
              : rehearsalLine,
          ),
        );
      } catch (err) {
        if (isPlaybackPermissionError(err)) {
          addDebugLog(
            'Correction Playback Blocked',
            err instanceof Error ? err.message : 'Browser blocked autoplay',
          );
          toast({
            title: 'Tap to Hear the Correct Line',
            description:
              "Automatic playback was blocked by your browser. Tap 'Hear Correct Line' to play it.",
          });
        } else {
          addDebugLog(
            'Correction Playback Error',
            err instanceof Error ? err.message : 'Failed to read the correct line',
          );
          toast({
            variant: 'destructive',
            title: 'Correction Playback Error',
            description: err instanceof Error ? err.message : 'Failed to read the correct line',
          });
        }
      } finally {
        updateRehearsalState('showing-feedback');
      }
    },
    [addDebugLog, toast, updateRehearsalState],
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
      try {
        const audioBlob = await textToSpeech(speakableText, {
          voice: getVoiceForCharacter(line.character),
        });
        await playAudioBlob(audioBlob);
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
  }, [addDebugLog, toast, updateRehearsalState]);

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
        prepareMicrophone: () => prepareMicrophoneAccess(navigator.mediaDevices, carMode),
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
          addDebugLog('Microphone Ready', 'Microphone permission granted before rehearsal');
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
        setHasCompletedDeviceSetup(true);
        toast({
          title: 'Device Ready',
          description: 'Microphone and playback are prepared for a smoother rehearsal start.',
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
  }, [addDebugLog, carMode, isPreparingDevice, toast]);

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
    clearCarModeAutoStartTimeout,
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
      void primeAudioPlayback().catch((error) => {
        addDebugLog(
          'Audio Priming Error',
          `Stop recording: ${error instanceof Error ? error.message : 'Audio playback priming failed'}`,
        );
      });
      const audioBlob = await stopRecording();
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

  useEffect(() => {
    clearCarModeAutoStartTimeout();

    if (
      !carMode ||
      !hasStarted ||
      isComplete ||
      rehearsalState !== 'waiting-for-user' ||
      isRecording ||
      isStartingRecordingRef.current ||
      isAutoStartingRecordingRef.current ||
      isStoppingRecordingRef.current
    ) {
      return;
    }

    carModeAutoStartTimeoutRef.current = window.setTimeout(() => {
      carModeAutoStartTimeoutRef.current = null;

      if (
        rehearsalStateRef.current !== 'waiting-for-user' ||
        isRecordingRef.current ||
        isStartingRecordingRef.current ||
        isAutoStartingRecordingRef.current ||
        isStoppingRecordingRef.current
      ) {
        return;
      }

      isAutoStartingRecordingRef.current = true;
      addDebugLog(
        'Car Mode Auto-Start',
        `Automatically restarting recording after ${CAR_MODE_AUTO_START_DELAY_MS}ms`,
      );
      void handleStartRecording().finally(() => {
        isAutoStartingRecordingRef.current = false;
      });
    }, CAR_MODE_AUTO_START_DELAY_MS);

    return clearCarModeAutoStartTimeout;
  }, [
    addDebugLog,
    carMode,
    clearCarModeAutoStartTimeout,
    handleStartRecording,
    hasStarted,
    isComplete,
    isRecording,
    rehearsalState,
  ]);

  const handleReplayExpectedLine = useCallback(async () => {
    await primeAudioPlayback().catch(() => undefined);
    void speakExpectedLine();
  }, [speakExpectedLine]);

  const handleRetryLine = useCallback(() => {
    const idx = currentLineIndexRef.current;
    if (idx < 0) {
      return;
    }

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
  }, [addDebugLog, updateRehearsalState]);

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
  }, [addDebugLog, clearCarModeAutoStartTimeout, processLine, updateRehearsalState]);

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

    setRehearsalLines((previousLines) =>
      previousLines.map((rehearsalLine, index) =>
        index === idx ? buildSkippedUserLine(rehearsalLine) : rehearsalLine,
      ),
    );
    addDebugLog('Line Skipped', `Line ${idx + 1} (${line.character})`);
    updateRehearsalState('showing-feedback');
  }, [addDebugLog, clearCarModeAutoStartTimeout, updateRehearsalState]);

  const handleRestart = useCallback(() => {
    clearCarModeAutoStartTimeout();
    setShowSetup(true);
    addDebugLog('Session Restarted');
    if (script && selectedCharacter) {
      const lines = buildRehearsalLines(script, selectedCharacter);
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      updateRehearsalState('idle');
    }
  }, [addDebugLog, clearCarModeAutoStartTimeout, script, selectedCharacter, updateRehearsalState]);

  const handleRecoverPreparation = useCallback(() => {
    const idx = currentLineIndexRef.current;
    if (idx < 0) {
      return;
    }

    addDebugLog('Manual Preparation Retry', `Retrying line ${idx + 1}`);
    void processLine(idx);
  }, [addDebugLog, processLine]);

  const handleToggleSetup = useCallback(() => {
    setShowSetup(prev => !prev);
  }, []);

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

    setMediaSessionActionHandler('nexttrack', handleNext);
    setMediaSessionActionHandler('previoustrack', handlePrevious);

    return () => {
      setMediaSessionActionHandler('nexttrack', null);
      setMediaSessionActionHandler('previoustrack', null);
    };
  }, [
    carMode,
    currentLine,
    handleNext,
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
    <div className="min-h-screen flex flex-col overflow-x-hidden">
      <header className="safe-area-top safe-area-x border-b border-border bg-background/95 backdrop-blur sticky top-0 z-50 supports-[backdrop-filter]:bg-background/80">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Theater className="w-6 h-6 text-primary" />
            <span className="font-serif font-semibold text-lg">Rehearsal Partner</span>
          </div>
          <div className="flex items-center gap-2">
            {hasStarted && (
              <Button
                data-testid="button-toggle-setup"
                size="icon"
                variant="ghost"
                onClick={handleToggleSetup}
              >
                <Settings className="w-5 h-5" />
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col min-h-0 max-w-4xl mx-auto w-full">
        {shouldShowFirstSetupScreen && (
          <DeviceSetupScreen
            isPreparing={isPreparingDevice}
            microphoneStatus={microphoneSetupStatus}
            microphoneMessage={microphoneSetupMessage}
            playbackStatus={playbackSetupStatus}
            playbackMessage={playbackSetupMessage}
            onPrepare={() => {
              void handlePrepareDevice();
            }}
          />
        )}

        {showSetup && !shouldShowFirstSetupScreen && (
          <div className="p-4 space-y-4">
            {hasCompletedDeviceSetup && !hasStarted && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Device Ready</AlertTitle>
                <AlertDescription>
                  Microphone access and audio playback have already been prepared for this session.
                </AlertDescription>
              </Alert>
            )}
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
                    />
                  </div>

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

        <RehearsalTimeline
          lines={rehearsalLines}
          currentLineIndex={currentLineIndex}
        />

        <div className="safe-area-bottom safe-area-x sticky bottom-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="p-4">
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
      </main>
    </div>
  );
}
