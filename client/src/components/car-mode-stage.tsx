import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { RehearsalLine, RehearsalState } from '@/lib/types';
import { ArrowLeft, ArrowRight, CarFront, Mic, Square, Volume2 } from 'lucide-react';

interface CarModeStageProps {
  autoSpeakCorrections: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  currentLine: RehearsalLine | null;
  rehearsalState: RehearsalState;
}

function getStateLabel(rehearsalState: RehearsalState): string {
  switch (rehearsalState) {
    case 'waiting-for-user':
      return 'Listening window ready';
    case 'recording':
      return 'Recording now';
    case 'processing':
      return 'Processing your line';
    case 'playing-tts':
      return 'Playing partner cue';
    case 'playing-correction':
      return 'Reading correction';
    case 'showing-feedback':
      return 'Waiting for your next choice';
    default:
      return 'Preparing rehearsal';
  }
}

function getPrimaryInstruction(
  currentLine: RehearsalLine | null,
  rehearsalState: RehearsalState,
): string {
  if (!currentLine) {
    return 'Begin rehearsal when you are ready.';
  }

  if (rehearsalState === 'recording') {
    return 'Speak the line now. Stop when you finish, or let car mode handle the pause.';
  }

  if (rehearsalState === 'processing') {
    return 'Hold steady while the line is scored and the next cue is prepared.';
  }

  if (!currentLine.isUserLine) {
    return 'Listen for the partner cue. Use previous track to hear the scene again if needed.';
  }

  if (rehearsalState === 'showing-feedback') {
    return 'Use next track to move on, or previous track to revisit the cue.';
  }

  return 'Use the steering-wheel or headset track buttons to repeat or skip when supported.';
}

export function CarModeStage({
  autoSpeakCorrections,
  canGoNext,
  canGoPrevious,
  currentLine,
  rehearsalState,
}: CarModeStageProps) {
  const stateLabel = getStateLabel(rehearsalState);
  const lineLabel = currentLine ? `Line ${currentLine.index + 1} · ${currentLine.character}` : 'Ready';
  const shouldShowScriptText = Boolean(currentLine);
  const helperBadges = currentLine?.correctionPlayed
    ? ['Correction spoken']
    : currentLine?.accuracy !== undefined
    ? [`${currentLine.accuracy}% matched`]
    : [];

  return (
    <div className="flex flex-1 flex-col justify-center gap-4 p-4" data-testid="car-mode-stage">
      <Card className="border-primary/20 bg-gradient-to-br from-background via-background to-primary/5 shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <CarFront className="mr-1 h-3 w-3" />
              Car mode
            </Badge>
            <Badge className="bg-primary/10 text-primary hover:bg-primary/10">
              {stateLabel}
            </Badge>
            {helperBadges.map((badgeLabel) => (
              <Badge key={badgeLabel} variant="secondary">
                {badgeLabel}
              </Badge>
            ))}
          </div>
          <div className="space-y-2">
            <CardDescription className="text-sm uppercase tracking-[0.2em] text-muted-foreground">
              {lineLabel}
            </CardDescription>
            <CardTitle className="text-3xl leading-tight sm:text-4xl">
              {shouldShowScriptText ? currentLine?.text : 'Car mode keeps the screen simple.'}
            </CardTitle>
          </div>
          <p className="max-w-3xl text-base leading-7 text-muted-foreground">
            {getPrimaryInstruction(currentLine, rehearsalState)}
          </p>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Previous track</CardDescription>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ArrowLeft className="h-5 w-5 text-primary" />
              Go back
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {canGoPrevious
              ? 'Replay the previous cue or return to the current line.'
              : 'No earlier line is available yet.'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Current action</CardDescription>
            <CardTitle className="flex items-center gap-2 text-lg">
              {rehearsalState === 'recording' ? (
                <Square className="h-5 w-5 text-destructive" />
              ) : rehearsalState === 'playing-tts' || rehearsalState === 'playing-correction' ? (
                <Volume2 className="h-5 w-5 text-primary" />
              ) : (
                <Mic className="h-5 w-5 text-primary" />
              )}
              {stateLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {autoSpeakCorrections
              ? 'Spoken corrections stay enabled for missed lines.'
              : 'Spoken corrections are off, so you control when to repeat the line.'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Next track</CardDescription>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ArrowRight className="h-5 w-5 text-primary" />
              Move on
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {canGoNext
              ? 'Advance to the next line without touching the screen.'
              : 'The next line unlocks as the current cue finishes.'}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
