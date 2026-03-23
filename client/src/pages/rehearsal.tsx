import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { ApiKeyInput } from '@/components/api-key-input';
import { CharacterSelector } from '@/components/character-selector';
import { RehearsalTimeline } from '@/components/rehearsal-timeline';
import { RehearsalControls } from '@/components/rehearsal-controls';
import { ScriptHeader } from '@/components/script-header';
import { ThemeToggle } from '@/components/theme-toggle';
import { useAudioRecorder } from '@/hooks/use-audio-recorder';
import { textToSpeech, speechToText, playAudioBlob, getApiKey } from '@/lib/openai';
import { computeWordDiff, calculateAccuracy } from '@/lib/word-diff';
import { buildTranscriptionPrompt, getSpeakableText, normalizeScript } from '@/lib/script-utils';
import type { RawScript, RehearsalLine, RehearsalState, Script } from '@/lib/types';
import { AlertCircle, CarFront, Settings, Theater } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

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
  const { startRecording, stopRecording } = useAudioRecorder({ carMode });

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

  const rehearsalLinesRef = useRef<RehearsalLine[]>([]);
  const currentLineIndexRef = useRef(-1);

  useEffect(() => {
    rehearsalLinesRef.current = rehearsalLines;
  }, [rehearsalLines]);

  useEffect(() => {
    currentLineIndexRef.current = currentLineIndex;
  }, [currentLineIndex]);

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
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load script');
      }
    }

    void loadScript();
  }, []);

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
    if (script && selectedCharacter) {
      const lines: RehearsalLine[] = script.lines.map((line, index) => ({
        index,
        character: line.character,
        text: line.text,
        isUserLine: line.character === selectedCharacter,
        state: 'pending',
      }));
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
        toast({
          variant: 'destructive',
          title: 'Correction Playback Error',
          description: err instanceof Error ? err.message : 'Failed to read the correct line',
        });
      } finally {
        setRehearsalState('showing-feedback');
      }
    },
    [toast],
  );

  const processLine = useCallback(async (lineIndex: number) => {
    const lines = rehearsalLinesRef.current;
    const line = lines[lineIndex];
    if (!line) {
      setIsComplete(true);
      return;
    }

    setRehearsalLines(prev => prev.map((l, i) => 
      i === lineIndex ? { ...l, state: 'active' } : l
    ));

    const speakableText = getSpeakableText(line.text);

    if (!speakableText) {
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
        setIsComplete(true);
        setRehearsalState('idle');
      }
      return;
    }

    if (!line.isUserLine) {
      setRehearsalState('playing-tts');
      try {
        const audioBlob = await textToSpeech(speakableText, {
          voice: getVoiceForCharacter(line.character),
        });
        await playAudioBlob(audioBlob);
      } catch (err) {
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
        setIsComplete(true);
        setRehearsalState('idle');
      }
    } else {
      setRehearsalState('waiting-for-user');
    }
  }, [toast]);

  const handleStart = useCallback(() => {
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

    setShowSetup(false);
    setHasStarted(true);
    setCurrentLineIndex(0);
    processLine(0);
  }, [hasApiKey, selectedCharacter, processLine, toast]);

  const handleStartRecording = useCallback(async () => {
    try {
      await startRecording();
      setRehearsalState('recording');
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Microphone Error',
        description: 'Please allow microphone access to record your lines',
      });
    }
  }, [startRecording, toast]);

  const handleStopRecording = useCallback(async () => {
    setRehearsalState('processing');
    
    try {
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
        await speakExpectedLine(idx);
      } else {
        setRehearsalState('showing-feedback');
      }
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Transcription Error',
        description: err instanceof Error ? err.message : 'Failed to transcribe audio',
      });
      setRehearsalState('waiting-for-user');
    }
  }, [
    autoSpeakCorrections,
    script,
    selectedCharacter,
    speakExpectedLine,
    stopRecording,
    toast,
  ]);

  const handleReplayExpectedLine = useCallback(() => {
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
  }, []);

  const handleNext = useCallback(() => {
    const idx = currentLineIndexRef.current;
    const lines = rehearsalLinesRef.current;
    const nextIndex = idx + 1;
    if (nextIndex < lines.length) {
      setCurrentLineIndex(nextIndex);
      processLine(nextIndex);
    } else {
      setIsComplete(true);
      setRehearsalState('idle');
    }
  }, [processLine]);

  const handleRestart = useCallback(() => {
    setShowSetup(true);
    if (script && selectedCharacter) {
      const lines: RehearsalLine[] = script.lines.map((line, index) => ({
        index,
        character: line.character,
        text: line.text,
        isUserLine: line.character === selectedCharacter,
        state: 'pending',
      }));
      setRehearsalLines(lines);
      setCurrentLineIndex(-1);
      setHasStarted(false);
      setIsComplete(false);
      setRehearsalState('idle');
    }
  }, [script, selectedCharacter]);

  const handleToggleSetup = useCallback(() => {
    setShowSetup(prev => !prev);
  }, []);

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
