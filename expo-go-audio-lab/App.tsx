import { StatusBar } from 'expo-status-bar';
import * as Application from 'expo-application';
import {
  type AudioMode,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
} from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const APP_VERSION = '1.1.1';
const AUDIO_CUE = require('./assets/cue.wav');

type ResultStatus = 'idle' | 'success' | 'warning' | 'error';

type StepId =
  | 'snapshot'
  | 'playback'
  | 'microphone'
  | 'recording-cold'
  | 'recording-handoff'
  | 'lock-screen'
  | 'summary';

type RecordingLabel = 'cold' | 'handoff';

type LogEntry = {
  timestamp: string;
  event: string;
  details?: string;
};

type StepResult = {
  status: ResultStatus;
  message: string;
};

type RecordingResult = {
  label: RecordingLabel;
  size: number;
  uri: string | null;
};

type Snapshot = {
  appVersion: string;
  deviceBrand: string | null;
  deviceModel: string | null;
  deviceName: string | null;
  isPhysicalDevice: boolean;
  nativeAppVersion: string | null;
  nativeBuildVersion: string | null;
  osBuildId: string | null;
  osName: string | null;
  osVersion: string | null;
  platform: string;
};

type LockScreenCounts = {
  pause: number;
  play: number;
};

const STEP_ORDER: Array<{ description: string; id: StepId; title: string }> = [
  {
    id: 'snapshot',
    title: 'Capture the native baseline',
    description: 'Save the device, OS, and Expo runtime details before changing audio state.',
  },
  {
    id: 'playback',
    title: 'Test native playback',
    description: 'Play the local cue with native audio mode enabled and confirm that you hear it.',
  },
  {
    id: 'microphone',
    title: 'Check microphone permission',
    description: 'Request mic access once and make sure the recorder can be prepared cleanly.',
  },
  {
    id: 'recording-cold',
    title: 'Record a cold take',
    description: 'Start a fresh recording in native play-and-record mode and see if the clip is usable.',
  },
  {
    id: 'recording-handoff',
    title: 'Test playback to recording handoff',
    description: 'Play the cue, then switch immediately into recording to test the handoff Safari struggled with.',
  },
  {
    id: 'lock-screen',
    title: 'Try lock-screen play and pause',
    description: 'Arm native lock-screen playback, then use Control Center, lock screen, or headset play/pause.',
  },
  {
    id: 'summary',
    title: 'Review and export the native report',
    description: 'Add notes, then copy or share the full report back into the repo experiment.',
  },
];

const PLAYBACK_MODE: AudioMode = {
  allowsRecording: false,
  interruptionMode: 'doNotMix',
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  shouldRouteThroughEarpiece: false,
};

const PLAY_AND_RECORD_MODE: AudioMode = {
  allowsRecording: true,
  interruptionMode: 'doNotMix',
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  shouldRouteThroughEarpiece: false,
};

function createInitialResults(): Record<StepId, StepResult> {
  return {
    snapshot: {
      status: 'idle',
      message: 'Capture the native environment before testing playback and recording.',
    },
    playback: {
      status: 'idle',
      message: 'Play the local cue and confirm whether native playback is audible.',
    },
    microphone: {
      status: 'idle',
      message: 'Request the microphone once and confirm preparation succeeds.',
    },
    'recording-cold': {
      status: 'idle',
      message: 'Record a normal native take and judge whether the result is useful.',
    },
    'recording-handoff': {
      status: 'idle',
      message: 'Run the playback-to-recording handoff to see if native audio avoids the Safari failure.',
    },
    'lock-screen': {
      status: 'idle',
      message: 'Arm lock-screen playback and see whether play/pause controls actually affect the player.',
    },
    summary: {
      status: 'idle',
      message: 'Export the report once the run is complete.',
    },
  };
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

function formatLogEntries(entries: LogEntry[]): string {
  return entries
    .map((entry) =>
      entry.details
        ? `[${entry.timestamp}] ${entry.event} — ${entry.details}`
        : `[${entry.timestamp}] ${entry.event}`,
    )
    .join('\n');
}

function formatStepResults(results: Record<StepId, StepResult>): string {
  return STEP_ORDER.map((step) => {
    const result = results[step.id];
    return `${step.id}: ${result.status.toUpperCase()} — ${result.message}`;
  }).join('\n');
}

function resultColor(status: ResultStatus): string {
  switch (status) {
    case 'success':
      return '#1a7f47';
    case 'warning':
      return '#9a6700';
    case 'error':
      return '#b42318';
    default:
      return '#5f6c7b';
  }
}

function outlineColor(status: ResultStatus): string {
  switch (status) {
    case 'success':
      return 'rgba(26, 127, 71, 0.28)';
    case 'warning':
      return 'rgba(154, 103, 0, 0.28)';
    case 'error':
      return 'rgba(180, 35, 24, 0.28)';
    default:
      return 'rgba(95, 108, 123, 0.22)';
  }
}

export default function App() {
  useKeepAwake();

  const cuePlayer = useAudioPlayer(AUDIO_CUE, {
    keepAudioSessionActive: true,
  });
  const cueStatus = useAudioPlayerStatus(cuePlayer);

  const recordedClipPlayer = useAudioPlayer(null, {
    keepAudioSessionActive: true,
  });

  const lockScreenPlayer = useAudioPlayer(AUDIO_CUE, {
    keepAudioSessionActive: true,
  });
  const lockScreenStatus = useAudioPlayerStatus(lockScreenPlayer);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [currentAudioMode, setCurrentAudioMode] = useState<'play-and-record' | 'playback' | 'unknown'>('unknown');
  const [audioModeHistory, setAudioModeHistory] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [playbackOutcome, setPlaybackOutcome] = useState<'heard' | 'not-heard' | 'unknown'>('unknown');
  const [microphoneGranted, setMicrophoneGranted] = useState<boolean | null>(null);
  const [stepResults, setStepResults] = useState<Record<StepId, StepResult>>(createInitialResults);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [notes, setNotes] = useState('');
  const [activeRecordingLabel, setActiveRecordingLabel] = useState<RecordingLabel | null>(null);
  const [recordings, setRecordings] = useState<Partial<Record<RecordingLabel, RecordingResult>>>({});
  const [lockScreenCounts, setLockScreenCounts] = useState<LockScreenCounts>({ play: 0, pause: 0 });
  const [lockScreenObservation, setLockScreenObservation] = useState<'unknown' | 'worked' | 'not-working'>('unknown');

  const handoffTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreNextLockScreenPlayRef = useRef(false);
  const previousLockScreenPlayingRef = useRef(lockScreenStatus.playing);

  const currentStep = STEP_ORDER[currentStepIndex];

  const addLog = useCallback((event: string, details?: string) => {
    setLogEntries((entries) => [
      ...entries,
      {
        timestamp: formatTimestamp(),
        event,
        details,
      },
    ]);
  }, []);

  const updateStepResult = useCallback((stepId: StepId, status: ResultStatus, message: string) => {
    setStepResults((results) => ({
      ...results,
      [stepId]: {
        status,
        message,
      },
    }));
  }, []);

  const applyAudioMode = useCallback(
    async (label: 'play-and-record' | 'playback', mode: AudioMode) => {
      await setAudioModeAsync(mode);
      setCurrentAudioMode(label);
      setAudioModeHistory((history) => [...history, `${formatTimestamp()} type=${label}`]);
      addLog('Native Audio Mode Applied', `type=${label}`);
    },
    [addLog],
  );

  const captureSnapshot = useCallback(async () => {
    const nextSnapshot: Snapshot = {
      appVersion: APP_VERSION,
      deviceBrand: Device.brand,
      deviceModel: Device.modelName,
      deviceName: Device.deviceName,
      isPhysicalDevice: Device.isDevice,
      nativeAppVersion: Application.nativeApplicationVersion,
      nativeBuildVersion: Application.nativeBuildVersion,
      osBuildId: Device.osBuildId,
      osName: Device.osName,
      osVersion: Device.osVersion,
      platform: Platform.OS,
    };

    setSnapshot(nextSnapshot);
    addLog(
      'Native Snapshot Captured',
      `platform=${nextSnapshot.platform} | os=${nextSnapshot.osName ?? 'unknown'} ${nextSnapshot.osVersion ?? 'unknown'} | device=${nextSnapshot.deviceModel ?? 'unknown'} | expo-lab=${APP_VERSION}`,
    );
    updateStepResult('snapshot', 'success', 'Saved the native device and runtime snapshot.');
  }, [addLog, updateStepResult]);

  const playCue = useCallback(async () => {
    try {
      await applyAudioMode('playback', PLAYBACK_MODE);
      await cuePlayer.seekTo(0);
      cuePlayer.play();
      addLog('Playback Cue Started', 'Playing the local native cue');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native cue playback failed';
      addLog('Playback Cue Failed', message);
      updateStepResult('playback', 'error', message);
    }
  }, [applyAudioMode, cuePlayer, addLog, updateStepResult]);

  const requestMicrophone = useCallback(async () => {
    try {
      const permission = await requestRecordingPermissionsAsync();
      setMicrophoneGranted(permission.granted);

      if (permission.granted) {
        addLog('Microphone Permission Ready', 'Native microphone permission granted');
        updateStepResult('microphone', 'success', 'Native microphone permission succeeded.');
        return;
      }

      addLog('Microphone Permission Denied', `status=${permission.status}`);
      updateStepResult('microphone', 'error', `Native microphone permission failed with status=${permission.status}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native microphone permission failed';
      setMicrophoneGranted(false);
      addLog('Microphone Permission Failed', message);
      updateStepResult('microphone', 'error', message);
    }
  }, [addLog, updateStepResult]);

  const startRecording = useCallback(
    async (label: RecordingLabel) => {
      try {
        await applyAudioMode('play-and-record', PLAY_AND_RECORD_MODE);
        await recorder.prepareToRecordAsync();
        recorder.record();
        setActiveRecordingLabel(label);
        addLog('Recording Started', `mode=${label}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Native recording could not start';
        addLog('Recording Start Failed', `mode=${label} | ${message}`);
        updateStepResult(
          label === 'cold' ? 'recording-cold' : 'recording-handoff',
          'error',
          message,
        );
      }
    },
    [addLog, applyAudioMode, recorder, updateStepResult],
  );

  const stopRecording = useCallback(async () => {
    if (!activeRecordingLabel) {
      return;
    }

    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) {
        throw new Error('Recorder stopped without producing a file URI.');
      }

      const recordedFile = new File(uri);
      const recordingResult: RecordingResult = {
        label: activeRecordingLabel,
        size: recordedFile.size,
        uri,
      };

      setRecordings((previous) => ({
        ...previous,
        [activeRecordingLabel]: recordingResult,
      }));
      addLog(
        'Recording Captured',
        `mode=${activeRecordingLabel} | size=${recordingResult.size} | uri=${uri}`,
      );
      updateStepResult(
        activeRecordingLabel === 'cold' ? 'recording-cold' : 'recording-handoff',
        recordingResult.size > 0 ? 'success' : 'warning',
        recordingResult.size > 0
          ? `Native recording completed with ${recordingResult.size} bytes.`
          : 'Native recording stopped but produced an empty file.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stopping the native recorder failed';
      addLog('Recording Stop Failed', `mode=${activeRecordingLabel} | ${message}`);
      updateStepResult(
        activeRecordingLabel === 'cold' ? 'recording-cold' : 'recording-handoff',
        'error',
        message,
      );
    } finally {
      setActiveRecordingLabel(null);
    }
  }, [activeRecordingLabel, addLog, recorder, updateStepResult]);

  const playRecordedClip = useCallback(
    async (label: RecordingLabel) => {
      const recording = recordings[label];
      if (!recording?.uri) {
        return;
      }

      try {
        await applyAudioMode('playback', PLAYBACK_MODE);
        recordedClipPlayer.replace({ uri: recording.uri });
        recordedClipPlayer.play();
        addLog('Recorded Clip Playback Started', `mode=${label} | size=${recording.size}`);
      } catch (error) {
        addLog(
          'Recorded Clip Playback Failed',
          error instanceof Error ? error.message : 'Native recorded clip playback failed',
        );
      }
    },
    [applyAudioMode, recordedClipPlayer, recordings, addLog],
  );

  const runHandoffRecording = useCallback(async () => {
    try {
      await applyAudioMode('playback', PLAYBACK_MODE);
      await cuePlayer.seekTo(0);
      cuePlayer.play();
      addLog('Handoff Cue Started', 'Cue is playing and recording will arm immediately after it.');
      updateStepResult(
        'recording-handoff',
        'idle',
        'Cue started. Speak as soon as recording begins after the cue.',
      );

      if (handoffTimeoutRef.current) {
        clearTimeout(handoffTimeoutRef.current);
      }

      handoffTimeoutRef.current = setTimeout(() => {
        void startRecording('handoff');
      }, 420);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native cue-to-record handoff could not start';
      addLog('Handoff Cue Failed', message);
      updateStepResult('recording-handoff', 'error', message);
    }
  }, [addLog, applyAudioMode, cuePlayer, startRecording, updateStepResult]);

  const armLockScreenPlayback = useCallback(async () => {
    try {
      await applyAudioMode('playback', PLAYBACK_MODE);
      setLockScreenCounts({ play: 0, pause: 0 });
      setLockScreenObservation('unknown');
      ignoreNextLockScreenPlayRef.current = true;
      lockScreenPlayer.loop = true;
      lockScreenPlayer.setActiveForLockScreen(
        true,
        {
          title: 'Rehearsal Partner Native Lab',
          artist: 'Expo Go audio test',
        },
        {
          showSeekBackward: false,
          showSeekForward: false,
        },
      );
      await lockScreenPlayer.seekTo(0);
      lockScreenPlayer.play();
      addLog(
        'Lock Screen Playback Armed',
        'Expo Go native playback is looping. Use lock-screen, Control Center, or headset play/pause now.',
      );
      updateStepResult(
        'lock-screen',
        'idle',
        'Looping native playback is armed. Try play/pause from lock screen or Control Center now.',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Lock-screen playback could not be armed';
      addLog('Lock Screen Playback Failed', message);
      updateStepResult('lock-screen', 'error', message);
    }
  }, [addLog, applyAudioMode, lockScreenPlayer, updateStepResult]);

  const stopLockScreenPlayback = useCallback(() => {
    lockScreenPlayer.pause();
    lockScreenPlayer.clearLockScreenControls();
    addLog('Lock Screen Playback Stopped', 'Looping native playback was stopped and lock-screen controls were cleared.');
  }, [addLog, lockScreenPlayer]);

  useEffect(() => {
    addLog('Expo Audio Lab Opened', `version=${APP_VERSION}`);

    const appStateSubscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      addLog('App State Changed', `state=${nextState}`);
    });

    return () => {
      appStateSubscription.remove();
      if (handoffTimeoutRef.current) {
        clearTimeout(handoffTimeoutRef.current);
      }
      lockScreenPlayer.clearLockScreenControls();
      lockScreenPlayer.pause();
    };
  }, [addLog, lockScreenPlayer]);

  useEffect(() => {
    if (!cueStatus.didJustFinish) {
      return;
    }

    addLog('Playback Cue Finished', `mode=${currentAudioMode}`);
  }, [addLog, cueStatus.didJustFinish, currentAudioMode]);

  useEffect(() => {
    const previousPlaying = previousLockScreenPlayingRef.current;
    const nextPlaying = lockScreenStatus.playing;

    if (previousPlaying === nextPlaying) {
      return;
    }

    previousLockScreenPlayingRef.current = nextPlaying;

    if (ignoreNextLockScreenPlayRef.current && nextPlaying) {
      ignoreNextLockScreenPlayRef.current = false;
      return;
    }

    setLockScreenCounts((counts) => {
      const nextCounts = nextPlaying
        ? { ...counts, play: counts.play + 1 }
        : { ...counts, pause: counts.pause + 1 };

      addLog(
        'Lock Screen Playback State Changed',
        `playing=${nextPlaying ? 'yes' : 'no'} | play=${nextCounts.play} | pause=${nextCounts.pause}`,
      );

      return nextCounts;
    });
  }, [addLog, lockScreenStatus.playing]);

  const reportText = useMemo(() => {
    const coldRecording = recordings.cold;
    const handoffRecording = recordings.handoff;

    return [
      'Expo Native Audio Lab Report',
      `Version: ${APP_VERSION}`,
      `Exported: ${formatTimestamp()}`,
      '',
      'Environment',
      `Platform: ${snapshot?.platform ?? 'unknown'}`,
      `Device: ${snapshot?.deviceModel ?? 'unknown'}`,
      `OS: ${snapshot?.osName ?? 'unknown'} ${snapshot?.osVersion ?? 'unknown'}`,
      `OS Build: ${snapshot?.osBuildId ?? 'unknown'}`,
      `Native App Version: ${snapshot?.nativeAppVersion ?? 'unknown'}`,
      `Native Build Version: ${snapshot?.nativeBuildVersion ?? 'unknown'}`,
      `Physical Device: ${snapshot?.isPhysicalDevice ? 'yes' : 'no'}`,
      '',
      'Audio Mode History',
      audioModeHistory.length > 0 ? audioModeHistory.join('\n') : 'No audio-mode changes recorded.',
      '',
      'Playback',
      `Outcome: ${playbackOutcome}`,
      '',
      'Microphone',
      `Permission: ${
        microphoneGranted === null ? 'not checked' : microphoneGranted ? 'granted' : 'denied'
      }`,
      '',
      'Recording',
      `Cold recording: ${coldRecording ? `${coldRecording.size} bytes` : 'not captured'}`,
      `Handoff recording: ${handoffRecording ? `${handoffRecording.size} bytes` : 'not captured'}`,
      '',
      'Lock Screen Controls',
      'Expo Go SDK 54 does not expose next/back transport callbacks in this experiment build.',
      `Observed play transitions: ${lockScreenCounts.play}`,
      `Observed pause transitions: ${lockScreenCounts.pause}`,
      `Tester outcome: ${lockScreenObservation}`,
      '',
      'Step Results',
      formatStepResults(stepResults),
      '',
      'Tester Notes',
      notes.trim() || 'No tester notes provided.',
      '',
      'Debug Log',
      formatLogEntries(logEntries),
    ].join('\n');
  }, [audioModeHistory, lockScreenCounts.pause, lockScreenCounts.play, lockScreenObservation, logEntries, microphoneGranted, notes, playbackOutcome, recordings.cold, recordings.handoff, snapshot, stepResults]);

  const handleCopyReport = useCallback(async () => {
    await Clipboard.setStringAsync(reportText);
    addLog('Report Copied', 'The native experiment report was copied to the clipboard.');
    updateStepResult('summary', 'success', 'Copied the native report to the clipboard.');
  }, [addLog, reportText, updateStepResult]);

  const handleShareReport = useCallback(async () => {
    const reportFile = new File(Paths.cache, `expo-native-audio-lab-${Date.now()}.txt`);
    reportFile.create({ intermediates: true, overwrite: true });
    reportFile.write(reportText);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(reportFile.uri, {
        UTI: 'public.plain-text',
        dialogTitle: 'Share Expo Native Audio Lab Report',
        mimeType: 'text/plain',
      });
      addLog('Report Shared', reportFile.uri);
      updateStepResult('summary', 'success', 'Shared the native report as a text file.');
      return;
    }

    await Clipboard.setStringAsync(reportText);
    addLog('Report Shared Fallback', 'Sharing is unavailable, so the report was copied to the clipboard.');
    updateStepResult('summary', 'warning', 'Sharing was unavailable, so the report was copied instead.');
  }, [addLog, reportText, updateStepResult]);

  const renderStepContent = () => {
    switch (currentStep.id) {
      case 'snapshot':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              Save the native environment first so later playback and recording behavior has a clean baseline.
            </Text>
            <ActionButton label="Capture Native Snapshot" onPress={() => void captureSnapshot()} />
            <InfoCard title="Current snapshot">
              {snapshot ? (
                <>
                  <InfoRow label="Expo lab version" value={snapshot.appVersion} />
                  <InfoRow label="Device" value={snapshot.deviceModel ?? 'unknown'} />
                  <InfoRow label="OS" value={`${snapshot.osName ?? 'unknown'} ${snapshot.osVersion ?? 'unknown'}`} />
                  <InfoRow label="OS build" value={snapshot.osBuildId ?? 'unknown'} />
                  <InfoRow label="Native app" value={snapshot.nativeAppVersion ?? 'unknown'} />
                </>
              ) : (
                <Text style={styles.mutedText}>No snapshot captured yet.</Text>
              )}
            </InfoCard>
          </View>
        );

      case 'playback':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              This uses native Expo audio instead of Safari media elements. First play the local cue, then mark whether you actually heard it.
            </Text>
            <ActionButton label="Play Native Cue" onPress={() => void playCue()} />
            <View style={styles.rowActions}>
              <SecondaryButton
                label="I Heard It"
                onPress={() => {
                  setPlaybackOutcome('heard');
                  addLog('Playback Observation', 'tester=heard-cue');
                  updateStepResult('playback', 'success', 'The native cue was heard on the device.');
                }}
              />
              <SecondaryButton
                label="I Did Not Hear It"
                onPress={() => {
                  setPlaybackOutcome('not-heard');
                  addLog('Playback Observation', 'tester=did-not-hear-cue');
                  updateStepResult('playback', 'error', 'The native cue was not audible on the device.');
                }}
              />
            </View>
            <InfoCard title="Playback state">
              <InfoRow label="Audio mode" value={currentAudioMode} />
              <InfoRow label="Cue loaded" value={cueStatus.isLoaded ? 'yes' : 'no'} />
              <InfoRow label="Cue playing" value={cueStatus.playing ? 'yes' : 'no'} />
            </InfoCard>
          </View>
        );

      case 'microphone':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              Expo Go uses native microphone APIs here. This step only checks permission and recorder preparation, not transport controls.
            </Text>
            <ActionButton label="Request Microphone Permission" onPress={() => void requestMicrophone()} />
            <InfoCard title="Microphone status">
              <InfoRow
                label="Permission"
                value={
                  microphoneGranted === null
                    ? 'not checked'
                    : microphoneGranted
                    ? 'granted'
                    : 'denied'
                }
              />
              <InfoRow label="Recorder can record" value={recorderState.canRecord ? 'yes' : 'no'} />
            </InfoCard>
          </View>
        );

      case 'recording-cold':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              This is a plain native recording in play-and-record mode. Start, speak, stop, then replay the clip and judge whether it is usable.
            </Text>
            <View style={styles.rowActions}>
              <ActionButton label="Start Cold Recording" onPress={() => void startRecording('cold')} />
              <ActionButton label="Stop Recording" onPress={() => void stopRecording()} tone="dark" />
            </View>
            <View style={styles.rowActions}>
              <SecondaryButton
                label="Play Cold Clip"
                onPress={() => void playRecordedClip('cold')}
                disabled={!recordings.cold?.uri}
              />
              <SecondaryButton
                label="Mark Usable"
                onPress={() => {
                  addLog('Recording Observation', `mode=cold | tester=usable | blob=${recordings.cold?.size ?? 0}`);
                  updateStepResult('recording-cold', 'success', `Cold recording felt usable (${recordings.cold?.size ?? 0} bytes).`);
                }}
              />
              <SecondaryButton
                label="Mark Broken"
                onPress={() => {
                  addLog('Recording Observation', `mode=cold | tester=broken | blob=${recordings.cold?.size ?? 0}`);
                  updateStepResult('recording-cold', 'warning', `Cold recording was not usable (${recordings.cold?.size ?? 0} bytes).`);
                }}
              />
            </View>
            <InfoCard title="Cold recording">
              <InfoRow label="Recording now" value={activeRecordingLabel === 'cold' ? 'yes' : 'no'} />
              <InfoRow label="Current duration" value={`${Math.round(recorderState.durationMillis / 100) / 10}s`} />
              <InfoRow label="Last file size" value={recordings.cold ? `${recordings.cold.size} bytes` : 'none'} />
            </InfoCard>
          </View>
        );

      case 'recording-handoff':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              This is the key native test. It plays the cue and then immediately arms recording to see if native audio avoids the Safari playback-to-recording failure.
            </Text>
            <View style={styles.rowActions}>
              <ActionButton label="Run Cue Then Record" onPress={() => void runHandoffRecording()} />
              <ActionButton label="Stop Recording" onPress={() => void stopRecording()} tone="dark" />
            </View>
            <View style={styles.rowActions}>
              <SecondaryButton
                label="Play Handoff Clip"
                onPress={() => void playRecordedClip('handoff')}
                disabled={!recordings.handoff?.uri}
              />
              <SecondaryButton
                label="Mark Usable"
                onPress={() => {
                  addLog('Recording Observation', `mode=handoff | tester=usable | blob=${recordings.handoff?.size ?? 0}`);
                  updateStepResult('recording-handoff', 'success', `Cue-to-record handoff felt usable (${recordings.handoff?.size ?? 0} bytes).`);
                }}
              />
              <SecondaryButton
                label="Mark Broken"
                onPress={() => {
                  addLog('Recording Observation', `mode=handoff | tester=broken | blob=${recordings.handoff?.size ?? 0}`);
                  updateStepResult('recording-handoff', 'warning', `Cue-to-record handoff still failed or felt unreliable (${recordings.handoff?.size ?? 0} bytes).`);
                }}
              />
            </View>
            <InfoCard title="Handoff recording">
              <InfoRow label="Recording now" value={activeRecordingLabel === 'handoff' ? 'yes' : 'no'} />
              <InfoRow label="Current duration" value={`${Math.round(recorderState.durationMillis / 100) / 10}s`} />
              <InfoRow label="Last file size" value={recordings.handoff ? `${recordings.handoff.size} bytes` : 'none'} />
            </InfoCard>
          </View>
        );

      case 'lock-screen':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              Expo Go on this SDK does not expose direct next/back callbacks, so this step focuses on native lock-screen play and pause instead.
            </Text>
            <View style={styles.rowActions}>
              <ActionButton label="Arm Lock-Screen Playback" onPress={() => void armLockScreenPlayback()} />
              <ActionButton label="Stop Loop" onPress={stopLockScreenPlayback} tone="dark" />
            </View>
            <View style={styles.rowActions}>
              <SecondaryButton
                label="Worked"
                onPress={() => {
                  setLockScreenObservation('worked');
                  addLog('Lock Screen Observation', `tester=worked | play=${lockScreenCounts.play} | pause=${lockScreenCounts.pause}`);
                  updateStepResult('lock-screen', 'success', 'Lock-screen play/pause changed the native player.');
                }}
              />
              <SecondaryButton
                label="Not Working Yet"
                onPress={() => {
                  setLockScreenObservation('not-working');
                  addLog('Lock Screen Observation', `tester=not-working | play=${lockScreenCounts.play} | pause=${lockScreenCounts.pause}`);
                  updateStepResult('lock-screen', 'warning', 'Lock-screen play/pause still did not move the native player.');
                }}
              />
            </View>
            <InfoCard title="Observed control state">
              <InfoRow label="Player active" value={lockScreenStatus.playing ? 'yes' : 'no'} />
              <InfoRow label="Observed play" value={`${lockScreenCounts.play}`} />
              <InfoRow label="Observed pause" value={`${lockScreenCounts.pause}`} />
            </InfoCard>
          </View>
        );

      case 'summary':
        return (
          <View style={styles.sectionStack}>
            <Text style={styles.bodyText}>
              This report is meant to answer one question: does native Expo audio avoid the Safari/PWA problems enough to justify moving the fuller app off the web stack?
            </Text>
            <TextInput
              multiline
              placeholder="Add tester notes here..."
              placeholderTextColor="#8b949e"
              style={styles.notesInput}
              value={notes}
              onChangeText={setNotes}
            />
            <View style={styles.rowActions}>
              <ActionButton label="Copy Report" onPress={() => void handleCopyReport()} />
              <ActionButton label="Share Report" onPress={() => void handleShareReport()} tone="dark" />
            </View>
            <InfoCard title="Step results">
              <Text style={styles.logText}>{formatStepResults(stepResults)}</Text>
            </InfoCard>
            <InfoCard title="Native debug log">
              <Text style={styles.logText}>{formatLogEntries(logEntries) || 'No logs yet.'}</Text>
            </InfoCard>
          </View>
        );

      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>EXPO GO LAB</Text>
            <Text style={styles.title}>Native Audio Test Wizard</Text>
            <Text style={styles.subtitle}>Version {APP_VERSION}</Text>
          </View>
          <View style={styles.headerBadge}>
            <Text style={styles.headerBadgeLabel}>Step {currentStepIndex + 1} of {STEP_ORDER.length}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.stepTitle}>{currentStep.title}</Text>
          <Text style={styles.stepDescription}>{currentStep.description}</Text>
          <View
            style={[
              styles.resultBadge,
              {
                borderColor: outlineColor(stepResults[currentStep.id].status),
              },
            ]}
          >
            <Text
              style={[
                styles.resultBadgeLabel,
                {
                  color: resultColor(stepResults[currentStep.id].status),
                },
              ]}
            >
              {stepResults[currentStep.id].status.toUpperCase()}
            </Text>
          </View>

          <ScrollView
            style={styles.stepBody}
            contentContainerStyle={styles.stepBodyContent}
            showsVerticalScrollIndicator={false}
          >
            {renderStepContent()}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              style={({ pressed }) => [
                styles.footerButton,
                currentStepIndex === 0 && styles.footerButtonDisabled,
                pressed && currentStepIndex > 0 && styles.footerButtonPressed,
              ]}
              disabled={currentStepIndex === 0}
              onPress={() => setCurrentStepIndex((value) => Math.max(0, value - 1))}
            >
              <Text style={styles.footerButtonText}>Previous</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.footerButton,
                styles.footerButtonPrimary,
                currentStepIndex === STEP_ORDER.length - 1 && styles.footerButtonDisabled,
                pressed && currentStepIndex < STEP_ORDER.length - 1 && styles.footerButtonPrimaryPressed,
              ]}
              disabled={currentStepIndex === STEP_ORDER.length - 1}
              onPress={() =>
                setCurrentStepIndex((value) => Math.min(STEP_ORDER.length - 1, value + 1))
              }
            >
              <Text style={styles.footerButtonPrimaryText}>
                {currentStepIndex === STEP_ORDER.length - 1 ? 'Done' : 'Next'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function InfoCard({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoCardTitle}>{title}</Text>
      <View style={styles.infoCardBody}>{children}</View>
    </View>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoRowLabel}>{label}</Text>
      <Text style={styles.infoRowValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  tone?: 'dark' | 'primary';
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionButton,
        tone === 'dark' ? styles.actionButtonDark : styles.actionButtonPrimary,
        pressed && styles.actionButtonPressed,
      ]}
      onPress={onPress}
    >
      <Text style={styles.actionButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.secondaryButton,
        disabled && styles.footerButtonDisabled,
        pressed && !disabled && styles.footerButtonPressed,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#16120f',
  },
  shell: {
    flex: 1,
    backgroundColor: '#16120f',
    paddingHorizontal: 18,
    paddingBottom: 18,
    paddingTop: 8,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 16,
  },
  headerText: {
    flex: 1,
    gap: 4,
  },
  eyebrow: {
    color: '#d85a2b',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 3.6,
  },
  title: {
    color: '#fff7ef',
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 36,
  },
  subtitle: {
    color: '#c4b4a4',
    fontSize: 14,
  },
  headerBadge: {
    backgroundColor: '#2a221d',
    borderColor: 'rgba(216, 90, 43, 0.26)',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerBadgeLabel: {
    color: '#f3d2bf',
    fontSize: 13,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#211a15',
    borderColor: 'rgba(255, 247, 239, 0.08)',
    borderRadius: 24,
    borderWidth: 1,
    flex: 1,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 14,
  },
  stepTitle: {
    color: '#fff7ef',
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 34,
  },
  stepDescription: {
    color: '#d2c2b2',
    fontSize: 16,
    lineHeight: 24,
    marginTop: 8,
  },
  resultBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#171311',
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  resultBadgeLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  stepBody: {
    flex: 1,
    marginTop: 16,
  },
  stepBodyContent: {
    gap: 16,
    paddingBottom: 16,
  },
  sectionStack: {
    gap: 16,
  },
  bodyText: {
    color: '#efe2d5',
    fontSize: 16,
    lineHeight: 24,
  },
  mutedText: {
    color: '#9f9489',
    fontSize: 15,
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  actionButton: {
    borderRadius: 18,
    minHeight: 56,
    minWidth: 156,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  actionButtonPrimary: {
    backgroundColor: '#d85a2b',
  },
  actionButtonDark: {
    backgroundColor: '#3b2d25',
  },
  actionButtonPressed: {
    opacity: 0.82,
  },
  actionButtonText: {
    color: '#fff7ef',
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  secondaryButton: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 18,
    borderWidth: 1,
    minHeight: 52,
    minWidth: 140,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonText: {
    color: '#f3e5d8',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  infoCard: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.08)',
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  infoCardTitle: {
    color: '#fff7ef',
    fontSize: 18,
    fontWeight: '700',
  },
  infoCardBody: {
    gap: 10,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  infoRowLabel: {
    color: '#b4a596',
    flex: 1,
    fontSize: 14,
  },
  infoRowValue: {
    color: '#fff7ef',
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'right',
  },
  notesInput: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 18,
    borderWidth: 1,
    color: '#fff7ef',
    fontSize: 16,
    minHeight: 140,
    padding: 16,
    textAlignVertical: 'top',
  },
  logText: {
    color: '#d9ccc0',
    fontFamily: Platform.select({
      android: 'monospace',
      ios: 'Menlo',
      default: 'monospace',
    }),
    fontSize: 12,
    lineHeight: 18,
  },
  footer: {
    borderTopColor: 'rgba(255, 247, 239, 0.08)',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingTop: 14,
  },
  footerButton: {
    alignItems: 'center',
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 52,
  },
  footerButtonPrimary: {
    backgroundColor: '#d85a2b',
    borderColor: '#d85a2b',
  },
  footerButtonDisabled: {
    opacity: 0.4,
  },
  footerButtonPressed: {
    backgroundColor: '#211a15',
  },
  footerButtonPrimaryPressed: {
    opacity: 0.84,
  },
  footerButtonText: {
    color: '#f3e5d8',
    fontSize: 16,
    fontWeight: '700',
  },
  footerButtonPrimaryText: {
    color: '#fff7ef',
    fontSize: 16,
    fontWeight: '800',
  },
});
