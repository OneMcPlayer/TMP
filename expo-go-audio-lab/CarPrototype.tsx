import { StatusBar } from 'expo-status-bar';
import {
  type AudioMode,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

const AUDIO_CUE = require('./assets/cue.wav');
const RAW_SCRIPT = require('./assets/script.json') as {
  author?: string;
  language?: string;
  lines: Array<{ line?: string; speaker?: string }>;
  title: string;
};

const TTS_MODEL = 'tts-1';
const STT_MODEL = 'gpt-4o-transcribe';
const DEFAULT_VOICE = 'alloy';
const ACCEPTANCE_THRESHOLD = 85;
const MAX_INITIAL_SILENCE_MS = 7_000;
const SILENCE_AUTO_STOP_MS = 1_250;
const VOICE_METERING_THRESHOLD = -38;
const SILENCE_METERING_THRESHOLD = -45;

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

const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

type Character = 'CLOV' | 'HAMM';
type PrototypePhase =
  | 'setup'
  | 'playing-partner'
  | 'listening'
  | 'processing'
  | 'playing-correction'
  | 'complete'
  | 'error';
type PlaybackKind = 'correction' | 'partner' | null;

type PrototypeLine = {
  character: Character;
  isUserLine: boolean;
  text: string;
};

type LogEntry = {
  details?: string;
  event: string;
  timestamp: string;
};

type AttemptRecord = {
  accuracy: number;
  attempt: number;
  lineIndex: number;
  outcome: 'accepted' | 'maxed-out' | 'retry';
  transcript: string;
};

function stripStageDirections(text: string): string {
  let cleaned = text;
  let previous = '';

  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

function getSpeakableText(text: string): string {
  return stripStageDirections(text).replace(/\s+/g, ' ').trim();
}

function normalizeForComparison(text: string): string[] {
  const comparableText = stripStageDirections(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return comparableText ? comparableText.split(/\s+/).filter(Boolean) : [];
}

function calculateAccuracy(expected: string, spoken: string): number {
  const expectedWords = normalizeForComparison(expected);
  const spokenWords = normalizeForComparison(spoken);

  if (expectedWords.length === 0) {
    return 100;
  }

  let correct = 0;
  let spokenIndex = 0;

  for (const expectedWord of expectedWords) {
    while (spokenIndex < spokenWords.length && spokenWords[spokenIndex] !== expectedWord) {
      spokenIndex += 1;
    }

    if (spokenIndex < spokenWords.length && spokenWords[spokenIndex] === expectedWord) {
      correct += 1;
      spokenIndex += 1;
    }
  }

  return Math.round((correct / expectedWords.length) * 100);
}

function buildPrompt(character: Character, expectedText: string): string {
  const expected = getSpeakableText(expectedText);
  const characters = 'CLOV, HAMM';

  return [
    `This is Italian theatrical dialogue from "${RAW_SCRIPT.title}".`,
    RAW_SCRIPT.author ? `Author: ${RAW_SCRIPT.author}.` : '',
    RAW_SCRIPT.language ? `Language: ${RAW_SCRIPT.language}.` : '',
    `The user is rehearsing as ${character}.`,
    `Character names may include: ${characters}.`,
    'Transcribe the spoken dialogue faithfully.',
    'Ignore stage directions in parentheses and do not over-index on punctuation.',
    `Expected line context: ${expected}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

function normalizeScript(selectedCharacter: Character): PrototypeLine[] {
  return RAW_SCRIPT.lines
    .map((line) => ({
      character: (line.speaker ?? '').trim() as Character,
      text: (line.line ?? '').trim(),
    }))
    .filter((line): line is { character: Character; text: string } => Boolean(line.character && line.text))
    .map((line) => ({
      ...line,
      isUserLine: line.character === selectedCharacter,
    }));
}

async function transcribeRecording(
  apiKey: string,
  character: Character,
  expectedText: string,
  fileUri: string,
): Promise<string> {
  const formData = new FormData();
  formData.append('file', {
    uri: fileUri,
    type: 'audio/m4a',
    name: 'recording.m4a',
  } as never);
  formData.append('model', STT_MODEL);
  formData.append('prompt', buildPrompt(character, expectedText));

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown STT error' } }));
    throw new Error(error.error?.message || `STT failed: ${response.status}`);
  }

  const result = await response.json();
  return String(result.text ?? '');
}

async function synthesizeSpeechToFile(apiKey: string, text: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: DEFAULT_VOICE,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown TTS error' } }));
    throw new Error(error.error?.message || `TTS failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const file = new File(Paths.cache, `prototype-tts-${Date.now()}-${Math.round(Math.random() * 1000)}.mp3`);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  return file.uri;
}

function safelyPausePlayer(player: { pause: () => void }) {
  try {
    player.pause();
  } catch {
    // Expo Go can invalidate the native shared object before cleanup completes.
  }
}

export function CarPrototype({
  appVersion,
  onBack,
}: {
  appVersion: string;
  onBack: () => void;
}) {
  useKeepAwake();

  const playbackPlayer = useAudioPlayer(null, { keepAudioSessionActive: true });
  const playbackStatus = useAudioPlayerStatus(playbackPlayer);
  const beepPlayer = useAudioPlayer(AUDIO_CUE, { keepAudioSessionActive: true });
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 150);

  const [apiKey, setApiKey] = useState('');
  const [selectedCharacter, setSelectedCharacter] = useState<Character>('CLOV');
  const [maxAttemptsInput, setMaxAttemptsInput] = useState('3');
  const [phase, setPhase] = useState<PrototypePhase>('setup');
  const [currentLineIndex, setCurrentLineIndex] = useState<number | null>(null);
  const [currentAttemptIndex, setCurrentAttemptIndex] = useState(0);
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastAccuracy, setLastAccuracy] = useState<number | null>(null);
  const [playbackKind, setPlaybackKind] = useState<PlaybackKind>(null);
  const [attemptHistory, setAttemptHistory] = useState<AttemptRecord[]>([]);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [notes, setNotes] = useState('');
  const [prototypeError, setPrototypeError] = useState<string | null>(null);

  const playbackFinishedRef = useRef(false);
  const processingRef = useRef(false);
  const speechDetectedRef = useRef(false);
  const silenceSinceRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef<number | null>(null);
  const ttsCacheRef = useRef<Map<string, string>>(new Map());
  const lineAdvanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lines = useMemo(() => normalizeScript(selectedCharacter), [selectedCharacter]);
  const maxAttempts = useMemo(() => {
    const parsed = Number.parseInt(maxAttemptsInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  }, [maxAttemptsInput]);

  const currentLine = currentLineIndex === null ? null : lines[currentLineIndex] ?? null;

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

  const clearAdvanceTimeout = useCallback(() => {
    if (lineAdvanceTimeoutRef.current) {
      clearTimeout(lineAdvanceTimeoutRef.current);
      lineAdvanceTimeoutRef.current = null;
    }
  }, []);

  const applyAudioMode = useCallback(
    async (label: 'play-and-record' | 'playback', mode: AudioMode) => {
      await setAudioModeAsync(mode);
      addLog('Prototype Audio Mode Applied', `type=${label}`);
    },
    [addLog],
  );

  const ensureTtsFile = useCallback(
    async (text: string) => {
      const speakable = getSpeakableText(text);
      const cached = ttsCacheRef.current.get(speakable);
      if (cached) {
        return cached;
      }

      const fileUri = await synthesizeSpeechToFile(apiKey, speakable);
      ttsCacheRef.current.set(speakable, fileUri);
      return fileUri;
    },
    [apiKey],
  );

  const endPrototypeSession = useCallback(() => {
    clearAdvanceTimeout();
    recorder.stop().catch(() => undefined);
    safelyPausePlayer(playbackPlayer);
    safelyPausePlayer(beepPlayer);
    setPhase('setup');
    setCurrentLineIndex(null);
    setCurrentAttemptIndex(0);
    setLastTranscript('');
    setLastAccuracy(null);
    setPlaybackKind(null);
    setPrototypeError(null);
    processingRef.current = false;
    speechDetectedRef.current = false;
    silenceSinceRef.current = null;
    recordingStartedAtRef.current = null;
    addLog('Prototype Session Ended');
  }, [addLog, beepPlayer, clearAdvanceTimeout, playbackPlayer, recorder]);

  const playPlaybackUri = useCallback(
    async (kind: Exclude<PlaybackKind, null>, uri: string, details: string) => {
      await applyAudioMode('playback', PLAYBACK_MODE);
      playbackPlayer.replace({ uri });
      playbackPlayer.play();
      playbackFinishedRef.current = false;
      setPlaybackKind(kind);
      addLog(
        kind === 'partner' ? 'Partner Playback Started' : 'Correction Playback Started',
        details,
      );
    },
    [addLog, applyAudioMode, playbackPlayer],
  );

  const stopAndProcessRecording = useCallback(async () => {
    if (processingRef.current || currentLineIndex === null || !currentLine?.isUserLine) {
      return;
    }

    processingRef.current = true;
    setPhase('processing');

    try {
      await recorder.stop();
      const recordingUri = recorder.uri;
      if (!recordingUri) {
        throw new Error('Recorder stopped without a file URI.');
      }

      const recordedFile = new File(recordingUri);
      const transcript = recordedFile.size > 0
        ? await transcribeRecording(apiKey, selectedCharacter, currentLine.text, recordingUri)
        : '';
      const accuracy = calculateAccuracy(currentLine.text, transcript);
      const nextAttemptNumber = currentAttemptIndex + 1;
      const accepted = accuracy >= ACCEPTANCE_THRESHOLD;

      setLastTranscript(transcript);
      setLastAccuracy(accuracy);
      addLog(
        'Prototype Line Scored',
        `line=${currentLineIndex + 1} | attempt=${nextAttemptNumber} | accuracy=${accuracy}% | transcript=${transcript || '(empty)'}`,
      );

      if (accepted) {
        setAttemptHistory((history) => [
          ...history,
          {
            accuracy,
            attempt: nextAttemptNumber,
            lineIndex: currentLineIndex,
            outcome: 'accepted',
            transcript,
          },
        ]);
        addLog('Prototype Line Accepted', `line=${currentLineIndex + 1}`);
        setCurrentAttemptIndex(0);
        setCurrentLineIndex(currentLineIndex + 1);
        clearAdvanceTimeout();
        lineAdvanceTimeoutRef.current = setTimeout(() => {
          setPrototypeError(null);
        }, 10);
        return;
      }

      if (nextAttemptNumber >= maxAttempts) {
        setAttemptHistory((history) => [
          ...history,
          {
            accuracy,
            attempt: nextAttemptNumber,
            lineIndex: currentLineIndex,
            outcome: 'maxed-out',
            transcript,
          },
        ]);
        addLog(
          'Prototype Line Max Attempts Reached',
          `line=${currentLineIndex + 1} | maxAttempts=${maxAttempts}`,
        );
        setCurrentAttemptIndex(0);
        setCurrentLineIndex(currentLineIndex + 1);
        clearAdvanceTimeout();
        lineAdvanceTimeoutRef.current = setTimeout(() => {
          setPrototypeError(null);
        }, 10);
        return;
      }

      setAttemptHistory((history) => [
        ...history,
        {
          accuracy,
          attempt: nextAttemptNumber,
          lineIndex: currentLineIndex,
          outcome: 'retry',
          transcript,
        },
      ]);
      setCurrentAttemptIndex(nextAttemptNumber);
      setPhase('playing-correction');
      const correctionUri = await ensureTtsFile(currentLine.text);
      await playPlaybackUri(
        'correction',
        correctionUri,
        `line=${currentLineIndex + 1} | attempt=${nextAttemptNumber + 1} of ${maxAttempts}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prototype recording flow failed';
      setPrototypeError(message);
      setPhase('error');
      addLog('Prototype Recording Error', message);
    } finally {
      processingRef.current = false;
      speechDetectedRef.current = false;
      silenceSinceRef.current = null;
      recordingStartedAtRef.current = null;
    }
  }, [apiKey, clearAdvanceTimeout, currentAttemptIndex, currentLine, currentLineIndex, ensureTtsFile, maxAttempts, playPlaybackUri, recorder, selectedCharacter]);

  const startUserRecording = useCallback(async () => {
    if (!currentLine?.isUserLine) {
      return;
    }

    try {
      await applyAudioMode('play-and-record', PLAY_AND_RECORD_MODE);
      await recorder.prepareToRecordAsync();
      recorder.record();
      speechDetectedRef.current = false;
      silenceSinceRef.current = null;
      recordingStartedAtRef.current = Date.now();
      setPhase('listening');
      addLog(
        'Prototype Recording Started',
        `line=${(currentLineIndex ?? 0) + 1} | attempt=${currentAttemptIndex + 1} of ${maxAttempts}`,
      );

      try {
        await beepPlayer.seekTo(0);
        beepPlayer.play();
        addLog('Prototype Recording Start Beep Played', `line=${(currentLineIndex ?? 0) + 1}`);
      } catch (error) {
        addLog(
          'Prototype Recording Start Beep Failed',
          error instanceof Error ? error.message : 'unknown failure',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prototype recording could not start';
      setPrototypeError(message);
      setPhase('error');
      addLog('Prototype Recording Start Failed', message);
    }
  }, [addLog, applyAudioMode, beepPlayer, currentAttemptIndex, currentLine, currentLineIndex, maxAttempts, recorder]);

  const startLineFlow = useCallback(
    async (lineIndex: number) => {
      clearAdvanceTimeout();

      if (lineIndex >= lines.length) {
        setPhase('complete');
        setCurrentLineIndex(null);
        addLog('Prototype Session Complete');
        return;
      }

      const line = lines[lineIndex];
      setCurrentLineIndex(lineIndex);
      setLastTranscript('');
      setLastAccuracy(null);

      if (line.isUserLine) {
        addLog('Prototype Waiting For User Line', `line=${lineIndex + 1} | character=${line.character}`);
        void startUserRecording();
        return;
      }

      try {
        setPhase('playing-partner');
        const partnerUri = await ensureTtsFile(line.text);
        await playPlaybackUri('partner', partnerUri, `line=${lineIndex + 1} | character=${line.character}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Partner playback failed';
        setPrototypeError(message);
        setPhase('error');
        addLog('Prototype Partner Playback Failed', message);
      }
    },
    [addLog, clearAdvanceTimeout, ensureTtsFile, lines, playPlaybackUri, startUserRecording],
  );

  const startPrototypeSession = useCallback(async () => {
    if (!apiKey.trim()) {
      setPrototypeError('Paste your OpenAI API key before starting the native car prototype.');
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error(`Microphone permission failed with status=${permission.status}`);
      }

      setAttemptHistory([]);
      setCurrentAttemptIndex(0);
      setPrototypeError(null);
      addLog(
        'Prototype Session Started',
        `character=${selectedCharacter} | maxAttempts=${maxAttempts} | lines=${lines.length}`,
      );
      await startLineFlow(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prototype session could not start';
      setPrototypeError(message);
      setPhase('error');
      addLog('Prototype Session Start Failed', message);
    }
  }, [addLog, apiKey, lines.length, maxAttempts, selectedCharacter, startLineFlow]);

  useEffect(() => {
    if (phase !== 'listening' || !currentLine?.isUserLine || !recorderState.isRecording) {
      return;
    }

    const now = Date.now();
    const level = recorderState.metering ?? -160;
    const startedAt = recordingStartedAtRef.current ?? now;

    if (level > VOICE_METERING_THRESHOLD) {
      speechDetectedRef.current = true;
      silenceSinceRef.current = null;
      return;
    }

    if (!speechDetectedRef.current) {
      if (now - startedAt >= MAX_INITIAL_SILENCE_MS) {
        addLog(
          'Prototype Initial Silence Timeout',
          `line=${(currentLineIndex ?? 0) + 1} | duration=${now - startedAt}ms`,
        );
        void stopAndProcessRecording();
      }
      return;
    }

    if (level <= SILENCE_METERING_THRESHOLD) {
      if (silenceSinceRef.current === null) {
        silenceSinceRef.current = now;
        return;
      }

      if (now - silenceSinceRef.current >= SILENCE_AUTO_STOP_MS) {
        addLog(
          'Prototype Silence Auto Stop',
          `line=${(currentLineIndex ?? 0) + 1} | silence=${now - silenceSinceRef.current}ms`,
        );
        void stopAndProcessRecording();
      }
      return;
    }

    silenceSinceRef.current = null;
  }, [addLog, currentLine, currentLineIndex, phase, recorderState.isRecording, recorderState.metering, stopAndProcessRecording]);

  useEffect(() => {
    if (!playbackStatus.didJustFinish) {
      playbackFinishedRef.current = false;
      return;
    }

    if (playbackFinishedRef.current) {
      return;
    }

    playbackFinishedRef.current = true;
    addLog('Prototype Playback Finished', `kind=${playbackKind ?? 'none'}`);

    if (playbackKind === 'partner') {
      setPlaybackKind(null);
      if (currentLineIndex !== null) {
        clearAdvanceTimeout();
        lineAdvanceTimeoutRef.current = setTimeout(() => {
          setCurrentLineIndex(currentLineIndex + 1);
        }, 180);
      }
      return;
    }

    if (playbackKind === 'correction') {
      setPlaybackKind(null);
      clearAdvanceTimeout();
      lineAdvanceTimeoutRef.current = setTimeout(() => {
        void startUserRecording();
      }, 220);
    }
  }, [addLog, clearAdvanceTimeout, currentLineIndex, playbackKind, playbackStatus.didJustFinish, startUserRecording]);

  useEffect(() => {
    if (phase === 'setup' || phase === 'complete' || phase === 'error') {
      return;
    }

    if (currentLineIndex === null) {
      return;
    }

    const line = lines[currentLineIndex];
    if (!line) {
      setPhase('complete');
      return;
    }

    if (phase === 'playing-partner' || phase === 'playing-correction' || phase === 'listening' || phase === 'processing') {
      return;
    }

    void startLineFlow(currentLineIndex);
  }, [currentLineIndex, lines, phase, startLineFlow]);

  useEffect(() => {
    return () => {
      clearAdvanceTimeout();
      recorder.stop().catch(() => undefined);
      safelyPausePlayer(playbackPlayer);
      safelyPausePlayer(beepPlayer);
    };
  }, [beepPlayer, clearAdvanceTimeout, playbackPlayer, recorder]);

  const reportText = useMemo(() => {
    return [
      'Expo Native Car Prototype Report',
      `Version: ${appVersion}`,
      `Exported: ${formatTimestamp()}`,
      '',
      'Configuration',
      `Character: ${selectedCharacter}`,
      `Max attempts: ${maxAttempts}`,
      `Acceptance threshold: ${ACCEPTANCE_THRESHOLD}%`,
      '',
      'Last Result',
      `Phase: ${phase}`,
      `Last transcript: ${lastTranscript || '(none)'}`,
      `Last accuracy: ${lastAccuracy === null ? 'n/a' : `${lastAccuracy}%`}`,
      '',
      'Attempt History',
      attemptHistory.length > 0
        ? attemptHistory
            .map(
              (attempt) =>
                `line=${attempt.lineIndex + 1} | attempt=${attempt.attempt} | accuracy=${attempt.accuracy}% | outcome=${attempt.outcome} | transcript=${attempt.transcript || '(empty)'}`,
            )
            .join('\n')
        : 'No attempts recorded.',
      '',
      'Notes',
      notes.trim() || 'No tester notes provided.',
      '',
      'Debug Log',
      logEntries
        .map((entry) =>
          entry.details
            ? `[${entry.timestamp}] ${entry.event} — ${entry.details}`
            : `[${entry.timestamp}] ${entry.event}`,
        )
        .join('\n'),
    ].join('\n');
  }, [ACCEPTANCE_THRESHOLD, appVersion, attemptHistory, lastAccuracy, lastTranscript, logEntries, maxAttempts, notes, phase, selectedCharacter]);

  const copyReport = useCallback(async () => {
    await Clipboard.setStringAsync(reportText);
    addLog('Prototype Report Copied');
  }, [addLog, reportText]);

  const shareReport = useCallback(async () => {
    const reportFile = new File(Paths.cache, `expo-native-car-prototype-${Date.now()}.txt`);
    reportFile.create({ intermediates: true, overwrite: true });
    reportFile.write(reportText);

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(reportFile.uri, {
        UTI: 'public.plain-text',
        dialogTitle: 'Share Expo Native Car Prototype Report',
        mimeType: 'text/plain',
      });
      addLog('Prototype Report Shared', reportFile.uri);
      return;
    }

    await Clipboard.setStringAsync(reportText);
    addLog('Prototype Report Shared Fallback', 'Sharing unavailable, copied to clipboard instead.');
  }, [addLog, reportText]);

  const stateLabel = useMemo(() => {
    switch (phase) {
      case 'setup':
        return 'Ready';
      case 'playing-partner':
        return 'Speaking Other Line';
      case 'listening':
        return 'Listening';
      case 'processing':
        return 'Processing';
      case 'playing-correction':
        return 'Correcting';
      case 'complete':
        return 'Complete';
      case 'error':
        return 'Needs Attention';
    }
  }, [phase]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.shell}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>EXPO GO PROTOTYPE</Text>
            <Text style={styles.title}>Native Car Flow</Text>
            <Text style={styles.subtitle}>Version {appVersion}</Text>
          </View>
          <Pressable style={styles.backButton} onPress={onBack}>
            <Text style={styles.backButtonText}>Back To Lab</Text>
          </Pressable>
        </View>

        {phase === 'setup' ? (
          <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
            <Card title="Prototype setup">
              <Text style={styles.bodyText}>
                This native prototype tries the closest version of the dream car flow we can test in Expo Go: auto partner playback, auto record with silence stop, correction retries, and automatic progression.
              </Text>
            </Card>

            <Card title="OpenAI API key">
              <TextInput
                style={styles.input}
                value={apiKey}
                onChangeText={setApiKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="sk-..."
                placeholderTextColor="#8b949e"
              />
              <View style={styles.rowActions}>
                <SecondaryButton
                  label="Paste Key"
                  onPress={() => {
                    void Clipboard.getStringAsync().then((value) => {
                      setApiKey(value.trim());
                    });
                  }}
                />
              </View>
            </Card>

            <Card title="Character">
              <View style={styles.rowActions}>
                <ChoiceButton
                  active={selectedCharacter === 'CLOV'}
                  label="CLOV"
                  onPress={() => setSelectedCharacter('CLOV')}
                />
                <ChoiceButton
                  active={selectedCharacter === 'HAMM'}
                  label="HAMM"
                  onPress={() => setSelectedCharacter('HAMM')}
                />
              </View>
            </Card>

            <Card title="Correction attempts">
              <TextInput
                style={styles.input}
                value={maxAttemptsInput}
                onChangeText={setMaxAttemptsInput}
                keyboardType="number-pad"
                placeholder="3"
                placeholderTextColor="#8b949e"
              />
              <Text style={styles.helperText}>
                If the line is still wrong after this many tries, the prototype skips forward automatically.
              </Text>
            </Card>

            {prototypeError ? (
              <Card title="Setup issue">
                <Text style={styles.errorText}>{prototypeError}</Text>
              </Card>
            ) : null}

            <ActionButton label="Start Native Car Prototype" onPress={() => void startPrototypeSession()} />
          </ScrollView>
        ) : (
          <View style={styles.liveShell}>
            <Card title="Current state">
              <Text style={styles.stateLabel}>{stateLabel}</Text>
              <Text style={styles.stateBody}>
                {currentLine
                  ? `Line ${currentLineIndex! + 1} • ${currentLine.character} • Attempt ${Math.min(currentAttemptIndex + 1, maxAttempts)} of ${maxAttempts}`
                  : 'Session is not currently on a line.'}
              </Text>
              {prototypeError ? <Text style={styles.errorText}>{prototypeError}</Text> : null}
            </Card>

            <Card title="Recent result">
              <InfoRow label="Last accuracy" value={lastAccuracy === null ? 'n/a' : `${lastAccuracy}%`} />
              <InfoRow label="Last transcript" value={lastTranscript || '(none yet)'} />
            </Card>

            <Card title="Controls">
              <View style={styles.rowActions}>
                <ActionButton label="End Session" onPress={endPrototypeSession} tone="dark" />
                <SecondaryButton label="Copy Report" onPress={() => void copyReport()} />
                <SecondaryButton label="Share Report" onPress={() => void shareReport()} />
              </View>
            </Card>

            <Card title="Prototype log">
              <ScrollView style={styles.logArea}>
                <Text style={styles.logText}>
                  {logEntries
                    .slice(-18)
                    .map((entry) =>
                      entry.details
                        ? `[${entry.timestamp}] ${entry.event} — ${entry.details}`
                        : `[${entry.timestamp}] ${entry.event}`,
                    )
                    .join('\n') || 'No logs yet.'}
                </Text>
              </ScrollView>
            </Card>

            {phase === 'complete' ? (
              <Card title="Session complete">
                <TextInput
                  multiline
                  placeholder="Add notes before exporting..."
                  placeholderTextColor="#8b949e"
                  style={styles.notesInput}
                  value={notes}
                  onChangeText={setNotes}
                />
              </Card>
            ) : null}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

function Card({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <View style={styles.cardBody}>{children}</View>
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
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
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
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}
      onPress={onPress}
    >
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function ChoiceButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.choiceButton,
        active && styles.choiceButtonActive,
        pressed && styles.secondaryButtonPressed,
      ]}
      onPress={onPress}
    >
      <Text style={[styles.secondaryButtonText, active && styles.choiceButtonTextActive]}>{label}</Text>
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
    gap: 12,
    justifyContent: 'space-between',
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
  backButton: {
    backgroundColor: '#2a221d',
    borderColor: 'rgba(216, 90, 43, 0.26)',
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  backButtonText: {
    color: '#f3d2bf',
    fontSize: 14,
    fontWeight: '700',
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    gap: 16,
    paddingBottom: 24,
  },
  liveShell: {
    flex: 1,
    gap: 16,
  },
  card: {
    backgroundColor: '#211a15',
    borderColor: 'rgba(255, 247, 239, 0.08)',
    borderRadius: 20,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  cardTitle: {
    color: '#fff7ef',
    fontSize: 20,
    fontWeight: '800',
  },
  cardBody: {
    gap: 12,
  },
  bodyText: {
    color: '#efe2d5',
    fontSize: 16,
    lineHeight: 24,
  },
  helperText: {
    color: '#b4a596',
    fontSize: 14,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 16,
    borderWidth: 1,
    color: '#fff7ef',
    fontSize: 16,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  notesInput: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 16,
    borderWidth: 1,
    color: '#fff7ef',
    fontSize: 15,
    minHeight: 120,
    padding: 16,
    textAlignVertical: 'top',
  },
  rowActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  actionButton: {
    borderRadius: 18,
    minHeight: 56,
    minWidth: 164,
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
    opacity: 0.84,
  },
  actionButtonText: {
    color: '#fff7ef',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  secondaryButton: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 52,
    minWidth: 140,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  secondaryButtonPressed: {
    opacity: 0.82,
  },
  secondaryButtonText: {
    color: '#f3e5d8',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  choiceButton: {
    backgroundColor: '#171311',
    borderColor: 'rgba(255, 247, 239, 0.1)',
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 52,
    minWidth: 120,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  choiceButtonActive: {
    backgroundColor: '#d85a2b',
    borderColor: '#d85a2b',
  },
  choiceButtonTextActive: {
    color: '#fff7ef',
  },
  stateLabel: {
    color: '#fff7ef',
    fontSize: 36,
    fontWeight: '900',
    lineHeight: 40,
  },
  stateBody: {
    color: '#d2c2b2',
    fontSize: 16,
    lineHeight: 24,
  },
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  infoLabel: {
    color: '#b4a596',
    flex: 1,
    fontSize: 14,
  },
  infoValue: {
    color: '#fff7ef',
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  errorText: {
    color: '#ffb4ab',
    fontSize: 15,
    lineHeight: 22,
  },
  logArea: {
    maxHeight: 180,
  },
  logText: {
    color: '#d9ccc0',
    fontFamily: 'Menlo',
    fontSize: 12,
    lineHeight: 18,
  },
});
