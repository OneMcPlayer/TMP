import { useCallback, useEffect, useRef, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  Copy,
  Download,
  Ear,
  FileText,
  Gauge,
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
  | 'playback'
  | 'audio-session'
  | 'microphone'
  | 'recording'
  | 'media-controls';

type ProbeMode = 'inactive' | 'metadata-only' | 'silent-loop';
type PlaybackObservation = 'unknown' | 'heard' | 'not-heard';
type RecordingMode = 'normal' | 'car';
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

const INITIAL_STEP_RESULTS: Record<AudioLabStepKey, AudioLabStepResult> = {
  environment: {
    status: 'idle',
    summary: 'Capture a runtime snapshot and service worker snapshot.',
  },
  playback: {
    status: 'idle',
    summary: 'Prime playback and confirm whether you hear the test cue.',
  },
  'audio-session': {
    status: 'idle',
    summary: 'Try the supported audio session modes and watch for state changes.',
  },
  microphone: {
    status: 'idle',
    summary: 'Check one-time mic permission and the persistent warm stream path.',
  },
  recording: {
    status: 'idle',
    summary: 'Run a manual recording in normal or car-style mode.',
  },
  'media-controls': {
    status: 'idle',
    summary: 'Arm the car-control probe and watch which media buttons fire.',
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

export default function AudioLabPage() {
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
  const [recordingSummary, setRecordingSummary] = useState(
    'No recording test has completed yet.',
  );
  const [lastRecordingBlob, setLastRecordingBlob] = useState<Blob | null>(null);
  const [probeMode, setProbeMode] = useState<ProbeMode>('inactive');
  const [mediaActionCounts, setMediaActionCounts] = useState(INITIAL_MEDIA_ACTION_COUNTS);
  const [testerNotes, setTesterNotes] = useState('');
  const warmStreamRef = useRef<MediaStream | null>(null);
  const controlProbeAudioRef = useRef<HTMLAudioElement | null>(null);
  const isUnmountingRef = useRef(false);
  const {
    startRecording,
    stopRecording,
    isRecording,
    error: recordingError,
  } = useAudioRecorder({
    carMode: recordingMode === 'car',
    silenceTimeoutMs: 5000,
  });

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
        setMediaActionCounts((counts) => {
          const nextCount = counts[action] + 1;
          appendLabLog('Media Control Triggered', `action=${action} | count=${nextCount}`);

          updateStepResult('media-controls', {
            status: 'success',
            summary: `${formatActionLabel(action)} fired. Hardware media controls are reaching the page.`,
          });

          return {
            ...counts,
            [action]: nextCount,
          };
        });
      });
    });

    setMediaSessionMetadata('Audio Lab', 'Waiting for hardware controls');

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

  const handleCaptureEnvironment = useCallback(async () => {
    await capturePwaRuntimeDiagnostics(APP_VERSION, 'Audio Lab Manual Snapshot', true);
    requestServiceWorkerDebugSnapshot();
    updateStepResult('environment', {
      status: 'success',
      summary: 'Runtime snapshot requested. Check the debug log for the returned details.',
    });
  }, [updateStepResult]);

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
        summary: `Requested ${nextType}. Watch the live state and then try the microphone and recording steps.`,
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
      setRecordingSummary(
        suspiciouslySmall
          ? `Recording captured only ${audioBlob.size} bytes as ${audioBlob.type || 'unknown mime type'}. This looks like a tiny warm-up blob rather than a usable take.`
          : `Recording captured ${audioBlob.size} bytes as ${audioBlob.type || 'unknown mime type'}.`,
      );
      appendLabLog(
        'Recording Captured',
        `size=${audioBlob.size} | type=${audioBlob.type || 'unknown'}`,
      );
      updateStepResult('recording', {
        status: suspiciouslySmall ? 'warning' : audioBlob.size > 0 ? 'success' : 'warning',
        summary:
          suspiciouslySmall
            ? 'Recording produced a tiny blob. Try the same test again and compare the second take.'
            : audioBlob.size > 0
            ? 'Recording completed with audio data.'
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

  const handleArmMetadataOnlyProbe = useCallback(() => {
    setProbeMode('metadata-only');
    setMediaSessionMetadata('Audio Lab Control Probe', 'Metadata only');
    setMediaSessionPlaybackState('playing');
    appendLabLog('Media Control Probe Armed', 'mode=metadata-only');
    updateStepResult('media-controls', {
      status: 'warning',
      summary: 'Metadata-only probe armed. Try your car controls and see if any events appear.',
    });
  }, [appendLabLog, updateStepResult]);

  const handleStartSilentProbe = useCallback(async () => {
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
      setProbeMode('silent-loop');
      setMediaSessionMetadata('Audio Lab Control Probe', 'Silent loop playing');
      setMediaSessionPlaybackState('playing');
      appendLabLog('Media Control Probe Armed', 'mode=silent-loop');
      updateStepResult('media-controls', {
        status: 'warning',
        summary: 'Silent-loop probe armed. Try play, next, and previous on the car or headset.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Silent probe failed.';
      appendLabLog('Media Control Probe Failed', message);
      updateStepResult('media-controls', {
        status: 'error',
        summary: message,
      });
    }
  }, [appendLabLog, updateStepResult]);

  const handleResetMediaCounts = useCallback(() => {
    setMediaActionCounts(INITIAL_MEDIA_ACTION_COUNTS);
    appendLabLog('Media Control Counts Reset');
  }, [appendLabLog]);

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
    } catch (error) {
      appendLabLog(
        'Audio Lab Report Copy Failed',
        error instanceof Error ? error.message : 'Clipboard write failed.',
      );
    }
  }, [appendLabLog, buildReport]);

  const handleDownloadTextReport = useCallback(() => {
    const report = buildReport();
    downloadFile(
      `audio-lab-report-${Date.now()}.txt`,
      serializeAudioLabReport(report),
      'text/plain;charset=utf-8',
    );
    appendLabLog('Audio Lab Text Report Downloaded');
  }, [appendLabLog, buildReport]);

  const handleDownloadJsonReport = useCallback(() => {
    const report = buildReport();
    downloadFile(
      `audio-lab-report-${Date.now()}.json`,
      JSON.stringify(report, null, 2),
      'application/json;charset=utf-8',
    );
    appendLabLog('Audio Lab JSON Report Downloaded');
  }, [appendLabLog, buildReport]);

  return (
    <div data-testid="audio-lab-page" className="min-h-screen bg-background">
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
              <TestTube2 className="h-4 w-4 text-primary" />
              Audio Lab
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">iPhone PWA Audio Experiment</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Guided checks for playback, microphone capture, audio session changes, and car-control
              media buttons. Export the final report and keep it with your device notes.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={buildAppRouteHref('rehearsal')}>
                <ArrowLeft className="h-4 w-4" />
                Back To Rehearsal
              </a>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <Alert className="border-primary/30 bg-primary/5">
          <Smartphone className="h-4 w-4" />
          <AlertTitle>What this page is for</AlertTitle>
          <AlertDescription>
            This page is meant to discover what Safari standalone PWA mode actually allows on your
            device. It does not depend on a server, and it focuses on hardware/media behavior rather
            than full rehearsal flow.
          </AlertDescription>
        </Alert>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Gauge className="h-5 w-5 text-primary" />
                      1. Environment
                    </CardTitle>
                    <CardDescription>
                      Capture the current runtime snapshot before touching playback or the microphone.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults.environment.status)}>
                    {stepResults.environment.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults.environment.summary}</p>
                <div className="flex flex-wrap gap-3">
                  <Button data-testid="button-audio-lab-capture-environment" onClick={() => void handleCaptureEnvironment()}>
                    Capture Snapshot
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Ear className="h-5 w-5 text-primary" />
                      2. Playback
                    </CardTitle>
                    <CardDescription>
                      First unlock audio, then play the audible start cue and mark what you really heard.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults.playback.status)}>
                    {stepResults.playback.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults.playback.summary}</p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => void handlePrimePlayback()}>Prime Playback</Button>
                  <Button variant="outline" onClick={() => void handlePlayCue()}>
                    Play Test Cue
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant={playbackObservation === 'heard' ? 'default' : 'outline'}
                    onClick={() => handlePlaybackObservation('heard')}
                  >
                    I Heard It
                  </Button>
                  <Button
                    variant={playbackObservation === 'not-heard' ? 'destructive' : 'outline'}
                    onClick={() => handlePlaybackObservation('not-heard')}
                  >
                    No Sound
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <AudioLines className="h-5 w-5 text-primary" />
                      3. Audio Session
                    </CardTitle>
                    <CardDescription>
                      Try the available `navigator.audioSession` modes and watch the live state.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults['audio-session'].status)}>
                    {stepResults['audio-session'].status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults['audio-session'].summary}</p>
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
                <div className="grid gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm sm:grid-cols-3">
                  <div>
                    <p className="font-medium">Supported</p>
                    <p className="text-muted-foreground">{audioSessionSupported ? 'Yes' : 'No'}</p>
                  </div>
                  <div>
                    <p className="font-medium">Current type</p>
                    <p className="text-muted-foreground">{audioSessionType ?? 'unknown'}</p>
                  </div>
                  <div>
                    <p className="font-medium">Current state</p>
                    <p className="text-muted-foreground">{audioSessionState ?? 'unknown'}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Mic className="h-5 w-5 text-primary" />
                      4. Microphone
                    </CardTitle>
                    <CardDescription>
                      Compare one-time permission with the persistent car-mode warm stream.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults.microphone.status)}>
                    {stepResults.microphone.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults.microphone.summary}</p>
                <div className="flex flex-wrap gap-3">
                  <Button onClick={() => void handleCheckMicrophone()}>Check Mic Once</Button>
                  <Button variant="outline" onClick={() => void handleWarmMicrophone()}>
                    Warm Car Mic
                  </Button>
                  <Button variant="outline" onClick={handleReleaseWarmMicrophone}>
                    Release Warm Mic
                  </Button>
                </div>
                <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
                  <p>{microphonePermissionSummary}</p>
                  <p>{warmStreamSummary}</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <ListRestart className="h-5 w-5 text-primary" />
                      5. Recording
                    </CardTitle>
                    <CardDescription>
                      Run a manual recording with the current session settings and inspect the resulting blob.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults.recording.status)}>
                    {stepResults.recording.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults.recording.summary}</p>

                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-muted/30 p-4">
                  <div>
                    <Label htmlFor="audio-lab-recording-mode">Use car-style recorder settings</Label>
                    <p className="text-sm text-muted-foreground">
                      Toggle this before starting the recording to compare normal and car-mode capture.
                    </p>
                  </div>
                  <Switch
                    id="audio-lab-recording-mode"
                    checked={recordingMode === 'car'}
                    onCheckedChange={(checked) => {
                      setRecordingMode(checked ? 'car' : 'normal');
                      appendLabLog('Recording Mode Changed', `mode=${checked ? 'car' : 'normal'}`);
                    }}
                  />
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button data-testid="button-audio-lab-start-recording" onClick={() => void handleStartRecording()} disabled={isRecording}>
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
                    Play Recorded Clip
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
                    Download Recording
                  </Button>
                </div>

                <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground">
                  {recordingSummary}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-xl">
                      <Music2 className="h-5 w-5 text-primary" />
                      6. Media Controls
                    </CardTitle>
                    <CardDescription>
                      Find out whether steering-wheel, headset, or lock-screen transport controls actually reach the page.
                    </CardDescription>
                  </div>
                  <Badge variant={getStepBadgeVariant(stepResults['media-controls'].status)}>
                    {stepResults['media-controls'].status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{stepResults['media-controls'].summary}</p>
                <div className="flex flex-wrap gap-3">
                  <Button data-testid="button-audio-lab-metadata-probe" onClick={handleArmMetadataOnlyProbe}>
                    Metadata Only Probe
                  </Button>
                  <Button data-testid="button-audio-lab-silent-probe" variant="outline" onClick={() => void handleStartSilentProbe()}>
                    Start Silent Probe
                  </Button>
                  <Button variant="outline" onClick={stopControlProbe}>
                    Stop Probe
                  </Button>
                  <Button variant="outline" onClick={handleResetMediaCounts}>
                    Reset Counters
                  </Button>
                </div>

                <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
                  <p className="text-sm font-medium">
                    Current probe: <span className="text-primary">{probeMode}</span>
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    After arming the probe, try `play`, `pause`, `next`, and `previous` from the car,
                    lock screen, headset, or control center. Any event that reaches the page increments below.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {MEDIA_ACTIONS.map((action) => (
                    <div
                      key={action}
                      className="rounded-2xl border border-border/60 bg-muted/30 p-4"
                    >
                      <p className="text-sm font-medium">{formatActionLabel(action)}</p>
                      <p className="mt-1 text-2xl font-semibold">{mediaActionCounts[action]}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <FileText className="h-5 w-5 text-primary" />
                  Notes And Export
                </CardTitle>
                <CardDescription>
                  Add real-device notes here, then export a text or JSON report for development.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  data-testid="textarea-audio-lab-notes"
                  value={testerNotes}
                  onChange={(event) => setTesterNotes(event.target.value)}
                  placeholder="Examples: nexttrack never fired in the car, cue was audible only through the receiver, recording worked in auto but failed in playback..."
                  className="min-h-40"
                />
                <div className="flex flex-wrap gap-3">
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">Live Debug Log</CardTitle>
                <CardDescription>
                  This combines Audio Lab actions with the existing PWA/service-worker debug events.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre
                  data-testid="audio-lab-log"
                  className="max-h-[40rem] overflow-auto rounded-2xl border border-border/60 bg-muted/30 p-4 text-xs leading-6 text-muted-foreground"
                >
                  {serializeDebugLogEntries(debugLogEntries)}
                </pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-xl">How To Use It</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>1. Capture the environment first.</p>
                <p>2. Prime playback and mark whether you heard the cue.</p>
                <p>3. Try audio session modes before microphone and recording steps.</p>
                <p>4. Run both microphone checks and at least one recording.</p>
                <p>5. Arm the media probe and try hardware next/back/play controls.</p>
                <p>6. Export the report and keep it with your phone/date/test notes.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
