import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ApiKeyInput } from '@/components/api-key-input';
import { CharacterSelector } from '@/components/character-selector';
import { RehearsalTimeline } from '@/components/rehearsal-timeline';
import { RehearsalControls } from '@/components/rehearsal-controls';
import { ScriptHeader } from '@/components/script-header';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAudioRecorder } from '@/hooks/use-audio-recorder';
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
import {
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
import { APP_VERSION, fetchLatestVersion, isUpdateAvailable } from '@/lib/version';
import { AlertCircle, CarFront, Copy, Download, Settings, Theater } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const PREFERENCES_STORAGE_KEY = 'rehearsal_preferences';

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
  const [debugLogEntries, setDebugLogEntries] = useState<DebugLogEntry[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [isCheckingVersion, setIsCheckingVersion] = useState(false);
  const [versionCheckedAt, setVersionCheckedAt] = useState<string | null>(null);

  const rehearsalLinesRef = useRef<RehearsalLine[]>([]);
  const currentLineIndexRef = useRef(-1);
  const isStartingRef = useRef(false);

  useEffect(() => {
    rehearsalLinesRef.current = rehearsalLines;
  }, [rehearsalLines]);

  useEffect(() => {
    currentLineIndexRef.current = currentLineIndex;
  }, [currentLineIndex]);

  const addDebugLog = useCallback((event: string, details?: string) => {
    setDebugLogEntries((entries) =>
      appendDebugLogEntry(entries, createDebugLogEntry(event, details)),
    );
  }, []);

  const debugLogText = serializeDebugLogEntries(debugLogEntries);
  const updateAvailable = isUpdateAvailable(APP_VERSION, latestVersion);
  const hasVersionData = Boolean(latestVersion);

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
      setRehearsalState('idle');
    }
  }, [script, selectedCharacter]);

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

  const speakExpectedLine = useCallback(
    async (lineIndex: number = currentLineIndexRef.current) => {
      const line = rehearsalLinesRef.current[lineIndex];
      if (!line) {
        return;
      }

      const expectedText = getSpeakableText(line.text);
      if (!expectedText) {
        setRehearsalState('showing-feedback');
        return;
      }

      setRehearsalState('playing-correction');
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
        setRehearsalState('showing-feedback');
      }
    },
    [addDebugLog, toast],
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
        setRehearsalState('idle');
      }
      return;
    }

    if (!line.isUserLine) {
      setRehearsalState('playing-tts');
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
        setRehearsalState('idle');
      }
    } else {
      addDebugLog('Waiting For User Line', `Line ${lineIndex + 1} (${line.character})`);
      setRehearsalState('waiting-for-user');
    }
  }, [addDebugLog, toast]);

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
      });
    } finally {
      isStartingRef.current = false;
    }
  }, [addDebugLog, hasApiKey, processLine, rehearsalLinesRef, script, selectedCharacter, toast]);

  const handleStartRecording = useCallback(async () => {
    try {
      await primeAudioPlayback().catch(() => undefined);
      await startRecording();
      setRehearsalState('recording');
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
    }
  }, [addDebugLog, startRecording, toast]);

  const handleStopRecording = useCallback(async () => {
    if (isStoppingRecordingRef.current) {
      return;
    }
    isStoppingRecordingRef.current = true;
    setRehearsalState('processing');
    addDebugLog('Recording Stopped', 'Processing user audio');
    
    try {
      await primeAudioPlayback().catch(() => undefined);
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
        setRehearsalState('showing-feedback');
      }
    } catch (err) {
      addDebugLog(
        'Transcription Error',
        err instanceof Error ? err.message : 'Failed to transcribe audio',
      );
      toast({
        variant: 'destructive',
        title: 'Transcription Error',
        description: err instanceof Error ? err.message : 'Failed to transcribe audio',
      });
      setRehearsalState('waiting-for-user');
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
    if (
      !carMode ||
      !hasStarted ||
      isComplete ||
      rehearsalState !== 'waiting-for-user' ||
      isRecording ||
      isAutoStartingRecordingRef.current ||
      isStoppingRecordingRef.current
    ) {
      return;
    }

    isAutoStartingRecordingRef.current = true;
    addDebugLog('Car Mode Auto-Start', 'Automatically restarting recording');
    void handleStartRecording().finally(() => {
      isAutoStartingRecordingRef.current = false;
    });
  }, [addDebugLog, carMode, handleStartRecording, hasStarted, isComplete, isRecording, rehearsalState]);

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
    setRehearsalState('waiting-for-user');
    addDebugLog('Retry Line', `Line ${idx + 1}`);
  }, [addDebugLog]);

  const handleNext = useCallback(() => {
    const idx = currentLineIndexRef.current;
    const lines = rehearsalLinesRef.current;
    const nextIndex = idx + 1;
    if (nextIndex < lines.length) {
      setCurrentLineIndex(nextIndex);
      addDebugLog('Moved To Next Line', `Line ${nextIndex + 1}`);
      processLine(nextIndex);
    } else {
      addDebugLog('Rehearsal Complete', 'Reached end of script');
      setIsComplete(true);
      setRehearsalState('idle');
    }
  }, [addDebugLog, processLine]);

  const handleSkipLine = useCallback(() => {
    const idx = currentLineIndexRef.current;
    const line = rehearsalLinesRef.current[idx];
    if (!line || !line.isUserLine) {
      return;
    }

    setRehearsalLines((previousLines) =>
      previousLines.map((rehearsalLine, index) =>
        index === idx ? buildSkippedUserLine(rehearsalLine) : rehearsalLine,
      ),
    );
    addDebugLog('Line Skipped', `Line ${idx + 1} (${line.character})`);
    setRehearsalState('showing-feedback');
  }, [addDebugLog]);

  const handleRestart = useCallback(() => {
    setShowSetup(true);
    addDebugLog('Session Restarted');
    if (script && selectedCharacter) {
      const lines = buildRehearsalLines(script, selectedCharacter);
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      setRehearsalState('idle');
    }
  }, [addDebugLog, script, selectedCharacter]);

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
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card/50 sticky top-0 z-50">
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

      <main className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
        {showSetup && (
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
                  Copy or download this ready-to-paste log when you need help debugging.
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
                    ? 'An update is available. Refresh after deployment to load it.'
                    : 'You are using the latest version.'}
                </p>
                {versionCheckedAt && (
                  <p className="text-muted-foreground">
                    Last checked: {new Date(versionCheckedAt).toLocaleString()}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={isCheckingVersion}
                  onClick={() => void handleCheckVersion()}
                >
                  {isCheckingVersion ? 'Checking…' : 'Check for updates'}
                </Button>
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
        />

        <RehearsalTimeline
          lines={rehearsalLines}
          currentLineIndex={currentLineIndex}
        />

        <div className="sticky bottom-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="p-4">
            <RehearsalControls
              state={rehearsalState}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              onNext={handleNext}
              onStart={handleStart}
              onRestart={handleRestart}
              onReplayExpectedLine={handleReplayExpectedLine}
              onRetryLine={handleRetryLine}
              onSkipLine={handleSkipLine}
              hasStarted={hasStarted}
              isComplete={isComplete}
              carMode={carMode}
              canReplayExpectedLine={canReplayExpectedLine}
              canRetryLine={canRetryLine}
              disabled={!hasApiKey || !selectedCharacter}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
