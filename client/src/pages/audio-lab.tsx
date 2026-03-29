import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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
import {
  getAudioSession,
  setPreferredAudioSessionType,
  subscribeToAudioSessionState,
  type PreferredAudioSessionType,
} from '@/lib/audio-session';
import { buildAppRouteHref } from '@/lib/app-route';
import {
  serializeAudioLabReport,
  type AudioLabMediaActionCounts,
  type AudioLabReport,
  type AudioLabStepResult,
} from '@/lib/audio-lab-report';
import {
  getAudioUploadFilename,
  playAudioBlob,
  playRecordingStartCue,
  primeAudioPlayback,
} from '@/lib/openai';
import { isSuspiciouslySmallRecordingBlob } from '@/lib/recording-quality';
import {
  prepareMicrophoneAccess,
  preparePersistentMicrophoneAccess,
  useAudioRecorder,
} from '@/hooks/use-audio-recorder';
import { APP_VERSION } from '@/lib/version';
import { cn } from '@/lib/utils';
import {
  ArrowLeft,
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Ear,
  FileText,
  ListRestart,
  Mic,
  Music2,
  Smartphone,
  TestTube2,
} from 'lucide-react';

const SILENT_CONTROL_PROBE_DATA_URI =
  'data:audio/wav;base64,' +
  'UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

type AudioLabStepKey =
  | 'environment'
  | 'media-baseline'
  | 'playback'
  | 'media-after-playback'
  | 'audio-session'
  | 'microphone'
  | 'recording'
  | 'media-after-recording'
  | 'summary';

type MediaCheckStepKey =
  | 'media-baseline'
  | 'media-after-playback'
  | 'media-after-recording';

type ProbeMode = 'inactive' | 'metadata-only' | 'silent-loop';
type PlaybackObservation = 'unknown' | 'heard' | 'not-heard';
type RecordingMode = 'normal' | 'car';
type MediaObservation = 'worked' | 'not-working' | 'bursty';
type RecordingObservation = 'usable' | 'not-usable';
type MediaActionName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'nexttrack'
  | 'previoustrack'
  | 'seekforward'
  | 'seekbackward';

const MEDIA_ACTIONS: MediaActionName[] = [
  'play',
  'pause',
  'stop',
  'nexttrack',
  'previoustrack',
  'seekforward',
  'seekbackward',
];

const INITIAL_MEDIA_ACTION_COUNTS: AudioLabMediaActionCounts = {
  play: 0,
  pause: 0,
  stop: 0,
  nexttrack: 0,
  previoustrack: 0,
  seekforward: 0,
  seekbackward: 0,
};

const AUDIO_LAB_WIZARD_STEPS: Array<{
  key: AudioLabStepKey;
  label: string;
  title: string;
  description: string;
}> = [
  {
    key: 'environment',
    label: 'Snapshot',
    title: 'Capture The Baseline Snapshot',
    description:
      'Start by saving the runtime and service-worker state before you touch playback, microphone, or car controls.',
  },
  {
    key: 'media-baseline',
    label: 'Controls 1',
    title: 'Try Next And Back Before Any Other Audio',
    description:
      'This step answers the first open question directly: do car controls reach the PWA immediately, or only after later audio activity?',
  },
  {
    key: 'playback',
    label: 'Playback',
    title: 'Check Playback Priming And The Audible Cue',
    description:
      'Prime audio, play the short cue, and record whether you actually heard it on the device.',
  },
  {
    key: 'media-after-playback',
    label: 'Controls 2',
    title: 'Try Next And Back Again After Playback',
    description:
      'If the controls only wake up after real audio playback, this step should be more reliable than the baseline check.',
  },
  {
    key: 'audio-session',
    label: 'Session',
    title: 'Compare Audio Session Modes',
    description:
      'Request `auto`, `playback`, and `play-and-record`, then watch how later microphone and recording steps react.',
  },
  {
    key: 'microphone',
    label: 'Mic',
    title: 'Test One-Time Mic Permission And Warm Stream',
    description:
      'Check whether ordinary permission and the persistent car-style stream both succeed under the current session mode.',
  },
  {
    key: 'recording',
    label: 'Recording',
    title: 'Record A Short Clip And Judge The Result',
    description:
      'Record a short sample, inspect the blob size, and mark whether the take was actually usable.',
  },
  {
    key: 'media-after-recording',
    label: 'Controls 3',
    title: 'Try Next And Back One More Time After Recording',
    description:
      'This final controls check tells us whether recording activity is what finally wakes car transport events up.',
  },
  {
    key: 'summary',
    label: 'Export',
    title: 'Review The Findings And Export Everything',
    description:
      'Save the detailed report, keep the raw log, and add any device notes that would help future debugging.',
  },
];

const INITIAL_STEP_RESULTS: Record<AudioLabStepKey, AudioLabStepResult> = {
  environment: {
    status: 'idle',
    summary: 'Capture the runtime snapshot and the service-worker snapshot first.',
  },
  'media-baseline': {
    status: 'idle',
    summary: 'Arm a probe before any other audio activity and try next/back once.',
  },
  playback: {
    status: 'idle',
    summary: 'Prime playback, play the cue, and mark whether you actually heard it.',
  },
  'media-after-playback': {
    status: 'idle',
    summary: 'Repeat the next/back test after audible playback.',
  },
  'audio-session': {
    status: 'idle',
    summary: 'Try the supported audio session modes and watch the live state.',
  },
  microphone: {
    status: 'idle',
    summary: 'Check one-time permission and the persistent warm microphone stream.',
  },
  recording: {
    status: 'idle',
    summary: 'Run a recording and inspect whether the captured blob is actually usable.',
  },
  'media-after-recording': {
    status: 'idle',
    summary: 'Run a final next/back test after microphone and recording activity.',
  },
  summary: {
    status: 'idle',
    summary: 'Add notes and export the full report when the run is complete.',
  },
};

function getStepBadgeVariant(status: AudioLabStepResult['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'success':
      return 'default';
    case 'warning':
      return 'secondary';
    case 'error':
      return 'destructive';
    default:
      return 'outline';
  }
}

function downloadFile(filename: string, contents: string | Blob, type?: string): void {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

function setMediaSessionPlaybackState(nextState: MediaSessionPlaybackState): void {
  try {
    if ('mediaSession' in navigator && navigator.mediaSession) {
      navigator.mediaSession.playbackState = nextState;
    }
  } catch {
    // Playback state support varies by browser.
  }
}

function setMediaSessionActionHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    if ('mediaSession' in navigator && navigator.mediaSession) {
      navigator.mediaSession.setActionHandler(action, handler);
    }
  } catch {
    // Action handler support varies by browser.
  }
}

function setMediaSessionMetadata(title: string, album: string): void {
  if (
    typeof window === 'undefined' ||
    typeof window.MediaMetadata !== 'function' ||
    !('mediaSession' in navigator) ||
    !navigator.mediaSession
  ) {
    return;
  }

  navigator.mediaSession.metadata = new window.MediaMetadata({
    title,
    artist: 'Rehearsal Partner Audio Lab',
    album,
  });
}

function formatActionLabel(action: MediaActionName): string {
  switch (action) {
    case 'nexttrack':
      return 'Next track';
    case 'previoustrack':
      return 'Previous track';
    case 'seekforward':
      return 'Seek forward';
    case 'seekbackward':
      return 'Seek backward';
    default:
      return action[0].toUpperCase() + action.slice(1);
  }
}

function getWizardStepMeta(stepKey: AudioLabStepKey) {
  return AUDIO_LAB_WIZARD_STEPS.find((step) => step.key === stepKey) ?? AUDIO_LAB_WIZARD_STEPS[0];
}

function isMediaCheckStepKey(stepKey: AudioLabStepKey): stepKey is MediaCheckStepKey {
  return (
    stepKey === 'media-baseline' ||
    stepKey === 'media-after-playback' ||
    stepKey === 'media-after-recording'
  );
}

function formatMediaCountsSummary(counts: AudioLabMediaActionCounts): string {
  return `next=${counts.nexttrack}, previous=${counts.previoustrack}, play=${counts.play}, pause=${counts.pause}, stop=${counts.stop}`;
}

function buildMediaObservationResult(
  outcome: MediaObservation,
  counts: AudioLabMediaActionCounts,
  probeMode: ProbeMode,
): AudioLabStepResult {
  const countSummary = formatMediaCountsSummary(counts);

  if (outcome === 'worked') {
    return {
      status: 'success',
      summary: `Tester confirmed the controls worked with ${probeMode}. Counts: ${countSummary}.`,
    };
  }

  if (outcome === 'bursty') {
    return {
      status: 'warning',
      summary: `Controls fired, but the tester reported bursty or repeated events with ${probeMode}. Counts: ${countSummary}.`,
    };
  }

  return {
    status: 'warning',
    summary: `Tester reported no useful next/back events yet with ${probeMode}. Counts: ${countSummary}.`,
  };
}

function buildRecordingObservationResult(
  outcome: RecordingObservation,
  blob: Blob | null,
  recordingSummary: string,
): AudioLabStepResult {
  if (outcome === 'usable') {
    return {
      status: 'success',
      summary: `Tester marked the latest recording as usable. ${recordingSummary}`,
    };
  }

  return {
    status: 'warning',
    summary: `Tester marked the latest recording as unusable. ${blob ? `Blob size=${blob.size}. ` : ''}${recordingSummary}`,
  };
}

function StepCountPanel({
  counts,
  probeMode,
}: {
  counts: AudioLabMediaActionCounts;
  probeMode: ProbeMode;
}) {
  return (
    <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Current control counts</p>
        <Badge data-testid="audio-lab-probe-mode" variant="outline">
          {probeMode}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div
          data-testid="audio-lab-next-count-card"
          className="rounded-2xl border border-border/60 bg-background/70 p-4"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Next Track
          </p>
          <p data-testid="audio-lab-next-count" className="mt-2 text-3xl font-semibold">
            {counts.nexttrack}
          </p>
        </div>
        <div
          data-testid="audio-lab-previous-count-card"
          className="rounded-2xl border border-border/60 bg-background/70 p-4"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Previous Track
          </p>
          <p data-testid="audio-lab-previous-count" className="mt-2 text-3xl font-semibold">
            {counts.previoustrack}
          </p>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Other actions: play {counts.play}, pause {counts.pause}, stop {counts.stop}, seek forward{' '}
        {counts.seekforward}, seek backward {counts.seekbackward}.
      </p>
    </div>
  );
}

export default function AudioLabPage() {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [debugLogEntries, setDebugLogEntries] = useState<DebugLogEntry[]>(() =>
    consumeQueuedPwaDebugLogs(),
  );
  const [stepResults, setStepResults] = useState(INITIAL_STEP_RESULTS);
  const [audioSessionSupported, setAudioSessionSupported] = useState(false);
  const [audioSessionType, setAudioSessionType] = useState<string | null>(null);
  const [audioSessionState, setAudioSessionState] = useState<string | null>(null);
  const [audioSessionHistory, setAudioSessionHistory] = useState<string[]>([]);
  const [playbackObservation, setPlaybackObservation] = useState<PlaybackObservation>('unknown');
  const [microphonePermissionSummary, setMicrophonePermissionSummary] = useState(
    'Microphone permission has not been checked yet.',
  );
  const [warmStreamSummary, setWarmStreamSummary] = useState(
    'Persistent car-mode stream has not been opened yet.',
  );
  const [recordingMode, setRecordingMode] = useState<RecordingMode>('normal');
  const [recordingSummary, setRecordingSummary] = useState('No recording test has completed yet.');
  const [lastRecordingBlob, setLastRecordingBlob] = useState<Blob | null>(null);
  const [probeMode, setProbeMode] = useState<ProbeMode>('inactive');
  const [mediaActionCounts, setMediaActionCounts] = useState(INITIAL_MEDIA_ACTION_COUNTS);
  const [testerNotes, setTesterNotes] = useState('');
  const [recordingObservation, setRecordingObservation] = useState<RecordingObservation | null>(
    null,
  );
  const warmStreamRef = useRef<MediaStream | null>(null);
  const controlProbeAudioRef = useRef<HTMLAudioElement | null>(null);
  const isUnmountingRef = useRef(false);
  const activeMediaStepRef = useRef<MediaCheckStepKey | null>(null);
  const previousStepKeyRef = useRef<AudioLabStepKey | null>(null);
  const {
    startRecording,
    stopRecording,
    isRecording,
    error: recordingError,
  } = useAudioRecorder({
    carMode: recordingMode === 'car',
    silenceTimeoutMs: 5000,
  });

  const currentStep = AUDIO_LAB_WIZARD_STEPS[currentStepIndex];
  const currentStepResult = stepResults[currentStep.key];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === AUDIO_LAB_WIZARD_STEPS.length - 1;

  const appendLabLog = useCallback((event: string, details?: string) => {
    setDebugLogEntries((currentEntries) =>
      appendDebugLogEntry(currentEntries, createDebugLogEntry(event, details)),
    );
  }, []);

  const updateStepResult = useCallback(
    (stepKey: AudioLabStepKey, nextResult: AudioLabStepResult) => {
      setStepResults((currentStepResults) => ({
        ...currentStepResults,
        [stepKey]: nextResult,
      }));
    },
    [],
  );

  const syncAudioSessionSnapshot = useCallback(() => {
    const session = getAudioSession(navigator);
    setAudioSessionSupported(Boolean(session));
    setAudioSessionType(typeof session?.type === 'string' ? session.type : null);
    setAudioSessionState(typeof session?.state === 'string' ? session.state : null);
  }, []);

  const stopControlProbe = useCallback(() => {
    const probeAudio = controlProbeAudioRef.current;
    if (probeAudio) {
      probeAudio.pause();
      probeAudio.currentTime = 0;
    }

    activeMediaStepRef.current = null;
    setProbeMode('inactive');
    setMediaSessionPlaybackState('paused');
    setMediaSessionMetadata('Audio Lab', 'Probe stopped');
  }, []);

  useEffect(() => {
    isUnmountingRef.current = false;
    syncAudioSessionSnapshot();
    void capturePwaRuntimeDiagnostics(APP_VERSION, 'Audio Lab Opened Snapshot', true);
    appendLabLog('Audio Lab Opened', `version=${APP_VERSION}`);

    const unsubscribePwaLogs = subscribeToPwaDebugLogs((entry) => {
      if (!isUnmountingRef.current) {
        setDebugLogEntries((currentEntries) => appendDebugLogEntry(currentEntries, entry));
      }
    });

    const unsubscribeAudioSession = subscribeToAudioSessionState(navigator, (nextState) => {
      setAudioSessionState(nextState);
      setAudioSessionHistory((history) => [...history, `state=${nextState}`]);
      appendLabLog('Audio Session State Changed', `state=${nextState}`);
    });

    MEDIA_ACTIONS.forEach((action) => {
      setMediaSessionActionHandler(action, () => {
        const activeStepKey = activeMediaStepRef.current;

        setMediaActionCounts((counts) => {
          const nextCounts = {
            ...counts,
            [action]: counts[action] + 1,
          };

          appendLabLog(
            'Media Control Triggered',
            `step=${activeStepKey ?? 'none'} | action=${action} | count=${nextCounts[action]}`,
          );

          if (activeStepKey) {
            updateStepResult(activeStepKey, {
              status: 'success',
              summary: `${formatActionLabel(action)} fired. Counts: ${formatMediaCountsSummary(nextCounts)}.`,
            });
          }

          return nextCounts;
        });
      });
    });

    setMediaSessionMetadata('Audio Lab', 'Waiting for step actions');

    return () => {
      isUnmountingRef.current = true;
      unsubscribePwaLogs();
      unsubscribeAudioSession();
      MEDIA_ACTIONS.forEach((action) => {
        setMediaSessionActionHandler(action, null);
      });
      stopControlProbe();
      warmStreamRef.current?.getTracks().forEach((track) => track.stop());
      warmStreamRef.current = null;
    };
  }, [appendLabLog, stopControlProbe, syncAudioSessionSnapshot, updateStepResult]);

  useEffect(() => {
    appendLabLog('Audio Lab Step Opened', `step=${currentStep.key}`);
  }, [appendLabLog, currentStep.key]);

  useEffect(() => {
    const previousStepKey = previousStepKeyRef.current;
    if (previousStepKey && isMediaCheckStepKey(previousStepKey) && previousStepKey !== currentStep.key) {
      stopControlProbe();
    }
    previousStepKeyRef.current = currentStep.key;
  }, [currentStep.key, stopControlProbe]);

  useEffect(() => {
    if (!recordingError) {
      return;
    }

    setRecordingSummary(recordingError);
    updateStepResult('recording', {
      status: 'error',
      summary: recordingError,
    });
    appendLabLog('Recording Error', recordingError);
  }, [appendLabLog, recordingError, updateStepResult]);

  const goToStep = useCallback((nextIndex: number) => {
    setCurrentStepIndex(Math.min(Math.max(nextIndex, 0), AUDIO_LAB_WIZARD_STEPS.length - 1));
  }, []);

  const handleCaptureEnvironment = useCallback(async () => {
    await capturePwaRuntimeDiagnostics(APP_VERSION, 'Audio Lab Manual Snapshot', true);
    requestServiceWorkerDebugSnapshot();
    syncAudioSessionSnapshot();
    updateStepResult('environment', {
      status: 'success',
      summary: 'Runtime snapshot requested. Check the debug log for the returned details.',
    });
  }, [syncAudioSessionSnapshot, updateStepResult]);

  const handlePrimePlayback = useCallback(async () => {
    try {
      await primeAudioPlayback();
      appendLabLog('Playback Primed', 'Silent primer succeeded.');
      updateStepResult('playback', {
        status: 'success',
        summary: 'Playback primed successfully. Now try the audible cue.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playback priming failed.';
      appendLabLog('Playback Priming Failed', message);
      updateStepResult('playback', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, updateStepResult]);

  const handlePlayCue = useCallback(async () => {
    try {
      await playRecordingStartCue();
      appendLabLog('Playback Cue Played', 'Recording start cue finished.');
      updateStepResult('playback', {
        status: 'success',
        summary: 'Cue played. Mark whether you actually heard it on the device.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Playback cue failed.';
      appendLabLog('Playback Cue Failed', message);
      updateStepResult('playback', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, updateStepResult]);

  const handlePlaybackObservation = useCallback(
    (nextObservation: PlaybackObservation) => {
      setPlaybackObservation(nextObservation);

      if (nextObservation === 'heard') {
        updateStepResult('playback', {
          status: 'success',
          summary: 'You heard the cue on the device.',
        });
        appendLabLog('Playback Observation', 'tester=heard-cue');
        return;
      }

      if (nextObservation === 'not-heard') {
        updateStepResult('playback', {
          status: 'warning',
          summary: 'The cue reported success in code, but the tester did not hear it.',
        });
        appendLabLog('Playback Observation', 'tester=no-audio');
      }
    },
    [appendLabLog, updateStepResult],
  );

  const handleSetAudioSessionType = useCallback(
    (nextType: PreferredAudioSessionType) => {
      const result = setPreferredAudioSessionType(navigator, nextType);

      if (!result.supported) {
        appendLabLog('Audio Session Unsupported', 'navigator.audioSession is not available here.');
        updateStepResult('audio-session', {
          status: 'warning',
          summary: 'navigator.audioSession is not available on this device/browser.',
        });
        syncAudioSessionSnapshot();
        return;
      }

      setAudioSessionHistory((history) => [...history, `type=${nextType}`]);
      appendLabLog(
        'Audio Session Type Requested',
        `type=${nextType} | changed=${result.changed ? 'yes' : 'no'} | state=${result.state ?? 'unknown'}`,
      );
      updateStepResult('audio-session', {
        status: 'success',
        summary: `Requested ${nextType}. Now compare microphone and recording behavior under this mode.`,
      });
      syncAudioSessionSnapshot();
    },
    [appendLabLog, syncAudioSessionSnapshot, updateStepResult],
  );

  const handleCheckMicrophone = useCallback(async () => {
    try {
      await prepareMicrophoneAccess(navigator.mediaDevices, false);
      setMicrophonePermissionSummary('One-time microphone permission succeeded.');
      appendLabLog('Microphone Permission Ready', 'One-time microphone check succeeded.');
      updateStepResult('microphone', {
        status: 'success',
        summary: 'One-time microphone permission succeeded.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone permission failed.';
      setMicrophonePermissionSummary(message);
      appendLabLog('Microphone Permission Failed', message);
      updateStepResult('microphone', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, updateStepResult]);

  const handleWarmMicrophone = useCallback(async () => {
    warmStreamRef.current?.getTracks().forEach((track) => track.stop());
    warmStreamRef.current = null;

    try {
      const stream = await preparePersistentMicrophoneAccess(navigator.mediaDevices, true);
      const liveTrackCount = stream.getTracks().filter((track) => track.readyState !== 'ended').length;
      warmStreamRef.current = stream;
      setWarmStreamSummary(`Persistent car-mode stream active with ${liveTrackCount} live track(s).`);
      appendLabLog('Warm Microphone Ready', `live-tracks=${liveTrackCount}`);
      updateStepResult('microphone', {
        status: 'success',
        summary: 'Persistent car-mode microphone stream opened successfully.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Persistent microphone stream failed.';
      setWarmStreamSummary(message);
      appendLabLog('Warm Microphone Failed', message);
      updateStepResult('microphone', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, updateStepResult]);

  const handleReleaseWarmMicrophone = useCallback(() => {
    warmStreamRef.current?.getTracks().forEach((track) => track.stop());
    warmStreamRef.current = null;
    setWarmStreamSummary('Persistent car-mode stream released.');
    appendLabLog('Warm Microphone Released');
  }, [appendLabLog]);

  const handleStartRecording = useCallback(async () => {
    const started = await startRecording();
    if (!started) {
      appendLabLog('Recording Start Ignored', 'Recorder was already busy or still starting.');
      updateStepResult('recording', {
        status: 'warning',
        summary: 'Start request was ignored because the recorder was already busy.',
      });
      return;
    }

    setRecordingObservation(null);
    appendLabLog('Recording Started', `mode=${recordingMode}`);
    updateStepResult('recording', {
      status: 'success',
      summary: `Recording started in ${recordingMode} mode.`,
    });
  }, [appendLabLog, recordingMode, startRecording, updateStepResult]);

  const handleStopRecording = useCallback(async () => {
    try {
      const audioBlob = await stopRecording();
      setLastRecordingBlob(audioBlob);
      const suspiciouslySmall = isSuspiciouslySmallRecordingBlob(audioBlob.size);
      const nextSummary = suspiciouslySmall
        ? `Recording captured only ${audioBlob.size} bytes as ${audioBlob.type || 'unknown mime type'}. This looks like a tiny warm-up blob rather than a usable take.`
        : `Recording captured ${audioBlob.size} bytes as ${audioBlob.type || 'unknown mime type'}.`;

      setRecordingSummary(nextSummary);
      appendLabLog(
        'Recording Captured',
        `size=${audioBlob.size} | type=${audioBlob.type || 'unknown'}`,
      );
      updateStepResult('recording', {
        status: suspiciouslySmall ? 'warning' : audioBlob.size > 0 ? 'success' : 'warning',
        summary:
          suspiciouslySmall
            ? 'Recording produced a tiny blob. Try the same test again and mark whether the second take becomes usable.'
            : audioBlob.size > 0
            ? 'Recording completed with audio data. Mark whether the clip sounded usable.'
            : 'Recording stopped, but the blob was empty.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recording stop failed.';
      setRecordingSummary(message);
      appendLabLog('Recording Stop Failed', message);
      updateStepResult('recording', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, stopRecording, updateStepResult]);

  const handlePlayRecording = useCallback(async () => {
    if (!lastRecordingBlob) {
      return;
    }

    try {
      await playAudioBlob(lastRecordingBlob);
      appendLabLog('Recorded Clip Played', `size=${lastRecordingBlob.size}`);
    } catch (error) {
      appendLabLog(
        'Recorded Clip Playback Failed',
        error instanceof Error ? error.message : 'Unknown playback failure.',
      );
    }
  }, [appendLabLog, lastRecordingBlob]);

  const handleRecordingObservation = useCallback(
    (outcome: RecordingObservation) => {
      setRecordingObservation(outcome);
      const result = buildRecordingObservationResult(outcome, lastRecordingBlob, recordingSummary);
      updateStepResult('recording', result);
      appendLabLog(
        'Recording Observation',
        `tester=${outcome} | blob=${lastRecordingBlob?.size ?? 'none'} | mode=${recordingMode}`,
      );
    },
    [appendLabLog, lastRecordingBlob, recordingMode, recordingSummary, updateStepResult],
  );

  const handleArmMetadataOnlyProbe = useCallback(
    (stepKey: MediaCheckStepKey) => {
      const probeAudio = controlProbeAudioRef.current;
      if (probeAudio) {
        probeAudio.pause();
        probeAudio.currentTime = 0;
      }

      activeMediaStepRef.current = stepKey;
      setMediaActionCounts(INITIAL_MEDIA_ACTION_COUNTS);
      setProbeMode('metadata-only');
      setMediaSessionMetadata('Audio Lab Control Probe', `${getWizardStepMeta(stepKey).title} | metadata only`);
      setMediaSessionPlaybackState('playing');
      appendLabLog('Media Control Counts Reset', `step=${stepKey}`);
      appendLabLog('Media Control Probe Armed', `step=${stepKey} | mode=metadata-only`);
      updateStepResult(stepKey, {
        status: 'warning',
        summary: 'Metadata-only probe armed. Try next/back now and then mark what happened.',
      });
    },
    [appendLabLog, updateStepResult],
  );

  const handleStartSilentProbe = useCallback(
    async (stepKey: MediaCheckStepKey) => {
      try {
        let audio = controlProbeAudioRef.current;
        if (!audio) {
          audio = new Audio();
          audio.preload = 'auto';
          audio.loop = true;
          audio.setAttribute('playsinline', '');
          audio.setAttribute('webkit-playsinline', '');
          controlProbeAudioRef.current = audio;
        }

        audio.src = SILENT_CONTROL_PROBE_DATA_URI;
        audio.load();
        await audio.play();
        activeMediaStepRef.current = stepKey;
        setMediaActionCounts(INITIAL_MEDIA_ACTION_COUNTS);
        setProbeMode('silent-loop');
        setMediaSessionMetadata('Audio Lab Control Probe', `${getWizardStepMeta(stepKey).title} | silent loop`);
        setMediaSessionPlaybackState('playing');
        appendLabLog('Media Control Counts Reset', `step=${stepKey}`);
        appendLabLog('Media Control Probe Armed', `step=${stepKey} | mode=silent-loop`);
        updateStepResult(stepKey, {
          status: 'warning',
          summary: 'Silent-loop probe armed. Try next/back now and then mark what happened.',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Silent probe failed.';
        appendLabLog('Media Control Probe Failed', `step=${stepKey} | ${message}`);
        updateStepResult(stepKey, {
          status: 'error',
          summary: message,
        });
      }
    },
    [appendLabLog, updateStepResult],
  );

  const handleMediaObservation = useCallback(
    (stepKey: MediaCheckStepKey, outcome: MediaObservation) => {
      const result = buildMediaObservationResult(outcome, mediaActionCounts, probeMode);
      updateStepResult(stepKey, result);
      appendLabLog(
        'Media Control Observation',
        `step=${stepKey} | outcome=${outcome} | probe=${probeMode} | ${formatMediaCountsSummary(mediaActionCounts)}`,
      );
    },
    [appendLabLog, mediaActionCounts, probeMode, updateStepResult],
  );

  const buildReport = useCallback((): AudioLabReport => {
    return {
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
      locationHref: window.location.href,
      testerNotes,
      audioSession: {
        supported: audioSessionSupported,
        type: audioSessionType,
        state: audioSessionState,
        history: audioSessionHistory,
      },
      mediaControls: {
        probeMode,
        counts: mediaActionCounts,
      },
      microphone: {
        permissionSummary: microphonePermissionSummary,
        warmStreamSummary,
      },
      recording: {
        mode: recordingMode,
        summary: recordingSummary,
        lastBlobSize: lastRecordingBlob?.size ?? null,
        lastMimeType: lastRecordingBlob?.type ?? null,
      },
      steps: stepResults,
      debugEntries: debugLogEntries,
    };
  }, [
    audioSessionHistory,
    audioSessionState,
    audioSessionSupported,
    audioSessionType,
    debugLogEntries,
    lastRecordingBlob,
    mediaActionCounts,
    microphonePermissionSummary,
    probeMode,
    recordingMode,
    recordingSummary,
    stepResults,
    testerNotes,
    warmStreamSummary,
  ]);

  const handleCopyReport = useCallback(async () => {
    const reportText = serializeAudioLabReport(buildReport());
    try {
      await navigator.clipboard.writeText(reportText);
      appendLabLog('Audio Lab Report Copied');
      updateStepResult('summary', {
        status: 'success',
        summary: 'Copied the full Audio Lab report to the clipboard.',
      });
    } catch (error) {
      appendLabLog(
        'Audio Lab Report Copy Failed',
        error instanceof Error ? error.message : 'Clipboard write failed.',
      );
      updateStepResult('summary', {
        status: 'error',
        summary: 'Clipboard write failed. Use one of the download buttons instead.',
      });
    }
  }, [appendLabLog, buildReport, updateStepResult]);

  const handleDownloadTextReport = useCallback(() => {
    const report = buildReport();
    downloadFile(
      `audio-lab-report-${Date.now()}.txt`,
      serializeAudioLabReport(report),
      'text/plain;charset=utf-8',
    );
    appendLabLog('Audio Lab Text Report Downloaded');
    updateStepResult('summary', {
      status: 'success',
      summary: 'Downloaded the text report successfully.',
    });
  }, [appendLabLog, buildReport, updateStepResult]);

  const handleDownloadJsonReport = useCallback(() => {
    const report = buildReport();
    downloadFile(
      `audio-lab-report-${Date.now()}.json`,
      JSON.stringify(report, null, 2),
      'application/json;charset=utf-8',
    );
    appendLabLog('Audio Lab JSON Report Downloaded');
    updateStepResult('summary', {
      status: 'success',
      summary: 'Downloaded the JSON report successfully.',
    });
  }, [appendLabLog, buildReport, updateStepResult]);

  const summaryItems = useMemo(
    () =>
      AUDIO_LAB_WIZARD_STEPS.filter((step) => step.key !== 'summary').map((step) => ({
        label: step.label,
        title: step.title,
        result: stepResults[step.key],
      })),
    [stepResults],
  );

  const renderMediaStep = (stepKey: MediaCheckStepKey) => {
    const result = stepResults[stepKey];

    return (
      <div className="space-y-5">
        <div className="rounded-3xl border border-border/60 bg-primary/5 p-4 text-sm text-muted-foreground">
          Try one clean press on car `next` and one clean press on car `previous`. If nothing happens,
          mark `Not Working Yet`. If several events fire from one press, mark `Repeated / Bursty`.
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Button
            data-testid="button-audio-lab-metadata-probe"
            onClick={() => handleArmMetadataOnlyProbe(stepKey)}
          >
            Metadata Only
          </Button>
          <Button
            data-testid="button-audio-lab-silent-probe"
            variant="outline"
            onClick={() => void handleStartSilentProbe(stepKey)}
          >
            Silent Loop
          </Button>
          <Button variant="outline" onClick={stopControlProbe}>
            Stop Probe
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Button
            data-testid="button-audio-lab-media-worked"
            variant="default"
            onClick={() => handleMediaObservation(stepKey, 'worked')}
          >
            It Worked
          </Button>
          <Button
            data-testid="button-audio-lab-media-not-working"
            variant="outline"
            onClick={() => handleMediaObservation(stepKey, 'not-working')}
          >
            Not Working Yet
          </Button>
          <Button
            data-testid="button-audio-lab-media-bursty"
            variant="secondary"
            onClick={() => handleMediaObservation(stepKey, 'bursty')}
          >
            Repeated / Bursty
          </Button>
        </div>

        <StepCountPanel counts={mediaActionCounts} probeMode={probeMode} />

        <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
          <p className="text-sm font-medium">Current step result</p>
          <p className="mt-2 text-sm text-muted-foreground">{result.summary}</p>
        </div>
      </div>
    );
  };

  const renderCurrentStepContent = () => {
    switch (currentStep.key) {
      case 'environment':
        return (
          <div className="space-y-5">
            <div className="rounded-3xl border border-primary/20 bg-primary/5 p-5">
              <div className="flex items-start gap-3">
                <Smartphone className="mt-0.5 h-5 w-5 text-primary" />
                <div className="space-y-2">
                  <p className="font-medium">Why this step matters</p>
                  <p className="text-sm text-muted-foreground">
                    We want a clean baseline of runtime, service worker, and PWA state before we
                    start changing audio session, microphone, or media-session behavior.
                  </p>
                </div>
              </div>
            </div>

            <Button
              data-testid="button-audio-lab-capture-environment"
              onClick={() => void handleCaptureEnvironment()}
            >
              Capture Snapshot
            </Button>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">Current step result</p>
              <p className="mt-2 text-sm text-muted-foreground">{stepResults.environment.summary}</p>
            </div>
          </div>
        );

      case 'media-baseline':
        return renderMediaStep('media-baseline');

      case 'playback':
        return (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button onClick={() => void handlePrimePlayback()}>Prime Playback</Button>
              <Button variant="outline" onClick={() => void handlePlayCue()}>
                Play Cue
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant={playbackObservation === 'heard' ? 'default' : 'outline'}
                onClick={() => handlePlaybackObservation('heard')}
              >
                I Heard The Cue
              </Button>
              <Button
                variant={playbackObservation === 'not-heard' ? 'destructive' : 'outline'}
                onClick={() => handlePlaybackObservation('not-heard')}
              >
                I Did Not Hear It
              </Button>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">Current step result</p>
              <p className="mt-2 text-sm text-muted-foreground">{stepResults.playback.summary}</p>
            </div>
          </div>
        );

      case 'media-after-playback':
        return renderMediaStep('media-after-playback');

      case 'audio-session':
        return (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Button variant="outline" onClick={() => handleSetAudioSessionType('auto')}>
                Set Auto
              </Button>
              <Button variant="outline" onClick={() => handleSetAudioSessionType('playback')}>
                Set Playback
              </Button>
              <Button variant="outline" onClick={() => handleSetAudioSessionType('play-and-record')}>
                Set Play And Record
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Supported
                </p>
                <p className="mt-2 text-lg font-semibold">{audioSessionSupported ? 'Yes' : 'No'}</p>
              </div>
              <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Current Type
                </p>
                <p className="mt-2 text-lg font-semibold">{audioSessionType ?? 'unknown'}</p>
              </div>
              <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Current State
                </p>
                <p className="mt-2 text-lg font-semibold">{audioSessionState ?? 'unknown'}</p>
              </div>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">History</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {audioSessionHistory.length > 0 ? audioSessionHistory.join(', ') : 'No audio-session changes yet.'}
              </p>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">Current step result</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {stepResults['audio-session'].summary}
              </p>
            </div>
          </div>
        );

      case 'microphone':
        return (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Button onClick={() => void handleCheckMicrophone()}>Check Mic Once</Button>
              <Button variant="outline" onClick={() => void handleWarmMicrophone()}>
                Warm Car Mic
              </Button>
              <Button variant="outline" onClick={handleReleaseWarmMicrophone}>
                Release Warm Mic
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                <p className="text-sm font-medium">One-time permission</p>
                <p className="mt-2 text-sm text-muted-foreground">{microphonePermissionSummary}</p>
              </div>
              <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                <p className="text-sm font-medium">Warm stream</p>
                <p className="mt-2 text-sm text-muted-foreground">{warmStreamSummary}</p>
              </div>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">Current step result</p>
              <p className="mt-2 text-sm text-muted-foreground">{stepResults.microphone.summary}</p>
            </div>
          </div>
        );

      case 'recording':
        return (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3 rounded-3xl border border-border/60 bg-muted/30 p-4">
              <div>
                <Label htmlFor="audio-lab-recording-mode">Use car-style recorder settings</Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  Toggle this before recording if you want to compare normal capture against the
                  car-style cleanup path.
                </p>
              </div>
              <Switch
                id="audio-lab-recording-mode"
                checked={recordingMode === 'car'}
                onCheckedChange={(checked) => {
                  const nextMode = checked ? 'car' : 'normal';
                  setRecordingMode(nextMode);
                  appendLabLog('Recording Mode Changed', `mode=${nextMode}`);
                }}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Button
                data-testid="button-audio-lab-start-recording"
                onClick={() => void handleStartRecording()}
                disabled={isRecording}
              >
                Start Recording
              </Button>
              <Button
                data-testid="button-audio-lab-stop-recording"
                variant="outline"
                onClick={() => void handleStopRecording()}
                disabled={!isRecording}
              >
                Stop Recording
              </Button>
              <Button variant="outline" onClick={() => void handlePlayRecording()} disabled={!lastRecordingBlob}>
                Play Clip
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (!lastRecordingBlob) {
                    return;
                  }

                  downloadFile(getAudioUploadFilename(lastRecordingBlob), lastRecordingBlob);
                  appendLabLog('Recorded Clip Downloaded');
                }}
                disabled={!lastRecordingBlob}
              >
                Download Clip
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                data-testid="button-audio-lab-recording-usable"
                variant={recordingObservation === 'usable' ? 'default' : 'outline'}
                onClick={() => handleRecordingObservation('usable')}
                disabled={!lastRecordingBlob}
              >
                Recording Was Usable
              </Button>
              <Button
                data-testid="button-audio-lab-recording-unusable"
                variant={recordingObservation === 'not-usable' ? 'secondary' : 'outline'}
                onClick={() => handleRecordingObservation('not-usable')}
                disabled={!lastRecordingBlob}
              >
                Recording Was Bad
              </Button>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <p className="text-sm font-medium">Current step result</p>
              <p className="mt-2 text-sm text-muted-foreground">{stepResults.recording.summary}</p>
              <p className="mt-3 text-sm text-muted-foreground">{recordingSummary}</p>
            </div>
          </div>
        );

      case 'media-after-recording':
        return renderMediaStep('media-after-recording');

      case 'summary':
        return (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {summaryItems.map((item) => (
                <div key={item.label} className="rounded-3xl border border-border/60 bg-muted/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
                        {item.label}
                      </p>
                    </div>
                    <Badge variant={getStepBadgeVariant(item.result.status)}>{item.result.status}</Badge>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{item.result.summary}</p>
                </div>
              ))}
            </div>

            <Textarea
              data-testid="textarea-audio-lab-notes"
              value={testerNotes}
              onChange={(event) => setTesterNotes(event.target.value)}
              placeholder="Examples: controls only woke up after playback, metadata-only never worked until the silent loop ran, first recording blob was small but second one was fine..."
              className="min-h-28"
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <Button variant="outline" onClick={() => void handleCopyReport()}>
                <Copy className="h-4 w-4" />
                Copy Report
              </Button>
              <Button variant="outline" onClick={handleDownloadTextReport}>
                <Download className="h-4 w-4" />
                Download Text
              </Button>
              <Button variant="outline" onClick={handleDownloadJsonReport}>
                <Download className="h-4 w-4" />
                Download JSON
              </Button>
            </div>

            <div className="rounded-3xl border border-border/60 bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileText className="h-4 w-4 text-primary" />
                Live Debug Log
              </div>
              <pre
                data-testid="audio-lab-log"
                className="mt-3 max-h-64 overflow-auto rounded-2xl border border-border/60 bg-background/70 p-4 text-xs leading-6 text-muted-foreground"
              >
                {serializeDebugLogEntries(debugLogEntries)}
              </pre>
            </div>
          </div>
        );
    }
  };

  return (
    <div data-testid="audio-lab-page" className="flex min-h-screen flex-col overflow-hidden bg-background">
      <header className="safe-area-top safe-area-x border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex max-w-5xl items-start justify-between gap-4 px-4 py-3 sm:items-center sm:px-6 sm:py-4 lg:px-8">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              <TestTube2 className="h-4 w-4 text-primary" />
              Audio Lab
            </div>
            <h1 className="mt-1 text-base font-semibold tracking-tight sm:text-xl">
              iPhone PWA Audio Test Wizard
            </h1>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={buildAppRouteHref('rehearsal')}>
                <ArrowLeft className="h-4 w-4" />
                Back
              </a>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="safe-area-x safe-area-bottom mx-auto flex min-h-0 flex-1 max-w-5xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              Step {currentStepIndex + 1} of {AUDIO_LAB_WIZARD_STEPS.length}
            </p>
            <h2
              data-testid="audio-lab-step-title"
              className="mt-1 text-lg font-semibold tracking-tight sm:text-2xl"
            >
              {currentStep.title}
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{currentStep.description}</p>
          </div>
          <Badge className="w-fit" variant={getStepBadgeVariant(currentStepResult.status)}>
            {currentStepResult.status}
          </Badge>
        </div>

        <div className="mb-4 overflow-x-auto">
          <div className="flex min-w-max gap-2 pb-1">
            {AUDIO_LAB_WIZARD_STEPS.map((step, index) => (
              <Button
                key={step.key}
                data-testid={`button-audio-lab-step-${step.key}`}
                variant={index === currentStepIndex ? 'default' : 'outline'}
                size="sm"
                className={cn('rounded-full', index === currentStepIndex && 'shadow-sm')}
                onClick={() => goToStep(index)}
              >
                {step.label}
              </Button>
            ))}
          </div>
        </div>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <CardHeader className="border-b pb-4">
            <CardTitle className="flex items-center gap-2 text-xl">
              {currentStep.key === 'environment' ? (
                <Smartphone className="h-5 w-5 text-primary" />
              ) : currentStep.key === 'playback' ? (
                <Ear className="h-5 w-5 text-primary" />
              ) : currentStep.key === 'audio-session' ? (
                <AudioLines className="h-5 w-5 text-primary" />
              ) : currentStep.key === 'microphone' ? (
                <Mic className="h-5 w-5 text-primary" />
              ) : currentStep.key === 'recording' ? (
                <ListRestart className="h-5 w-5 text-primary" />
              ) : currentStep.key === 'summary' ? (
                <FileText className="h-5 w-5 text-primary" />
              ) : (
                <Music2 className="h-5 w-5 text-primary" />
              )}
              {currentStep.label}
            </CardTitle>
            <CardDescription>{currentStepResult.summary}</CardDescription>
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col gap-5 p-4 sm:p-5">
            <div className="min-h-0 flex-1 overflow-auto pr-1">{renderCurrentStepContent()}</div>

            <div className="flex flex-col gap-3 border-t pt-4">
              <div className="grid w-full grid-cols-1 gap-3 sm:flex sm:w-auto sm:items-center sm:justify-between">
                <Button
                  data-testid="button-audio-lab-previous-step"
                  className="w-full sm:flex-none"
                  variant="outline"
                  onClick={() => goToStep(currentStepIndex - 1)}
                  disabled={isFirstStep}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>

                <Button
                  data-testid="button-audio-lab-next-step"
                  className="w-full sm:flex-none"
                  onClick={() => goToStep(currentStepIndex + 1)}
                  disabled={isLastStep}
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <p className="hidden text-center text-xs text-muted-foreground sm:block sm:max-w-xs sm:self-end sm:text-right">
                This wizard is meant to answer the current open questions one phase at a time.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
