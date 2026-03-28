import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RehearsalLine, RehearsalState } from '@/lib/types';
import { ArrowLeft, ArrowRight, CarFront, Mic, Square, Volume2 } from 'lucide-react';

interface CarModeStageProps {
  autoSpeakCorrections: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  completedLines: number;
  currentLine: RehearsalLine | null;
  rehearsalState: RehearsalState;
  scriptTitle: string;
  totalLines: number;
  userCharacter: string | null;
}

function getStateLabel(rehearsalState: RehearsalState): string {
  switch (rehearsalState) {
    case 'waiting-for-user':
      return 'Ready to listen';
    case 'recording':
      return 'Recording';
    case 'processing':
      return 'Processing';
    case 'playing-tts':
      return 'Playing cue';
    case 'playing-correction':
      return 'Playing correction';
    case 'showing-feedback':
      return 'Awaiting next action';
    default:
      return 'Preparing';
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
    return 'Speak the line now. Stop when you finish.';
  }

  if (rehearsalState === 'processing') {
    return 'Hold steady while the line is scored.';
  }

  if (!currentLine.isUserLine) {
    return 'Listen to the cue. Use previous track to replay it if needed.';
  }

  if (rehearsalState === 'showing-feedback') {
    return 'Use next track to move on or previous track to revisit the cue.';
  }

  return 'Use steering-wheel or headset track buttons to repeat or skip when supported.';
}

function getStateIcon(rehearsalState: RehearsalState) {
  if (rehearsalState === 'recording') {
    return <Square className="h-5 w-5 text-destructive" />;
  }

  if (rehearsalState === 'playing-tts' || rehearsalState === 'playing-correction') {
    return <Volume2 className="h-5 w-5 text-primary" />;
  }

  return <Mic className="h-5 w-5 text-primary" />;
}

function getProgressLabel(completedLines: number, totalLines: number): string {
  if (totalLines <= 0) {
    return '0%';
  }

  return `${Math.round((completedLines / totalLines) * 100)}%`;
}

export function CarModeStage({
  autoSpeakCorrections,
  canGoNext,
  canGoPrevious,
  completedLines,
  currentLine,
  rehearsalState,
  scriptTitle,
  totalLines,
  userCharacter,
}: CarModeStageProps) {
  const stateLabel = getStateLabel(rehearsalState);
  const progressLabel = getProgressLabel(completedLines, totalLines);
  const lineLabel = currentLine ? `Line ${currentLine.index + 1} · ${currentLine.character}` : 'Ready';
  const statusBadges = currentLine?.correctionPlayed
    ? ['Correction spoken']
    : currentLine?.accuracy !== undefined
    ? [`${currentLine.accuracy}% matched`]
    : [];

  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden px-4 py-3"
      data-testid="car-mode-stage"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
            {scriptTitle}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {userCharacter ? `Playing as ${userCharacter}` : 'Car mode session'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-2xl font-bold text-primary">{progressLabel}</p>
          <p className="text-xs text-muted-foreground">Complete</p>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-primary/20 bg-gradient-to-br from-background via-background to-primary/5 shadow-sm">
        <CardHeader className="space-y-3 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <CarFront className="mr-1 h-3 w-3" />
              Car mode
            </Badge>
            <Badge className="bg-primary/10 text-primary hover:bg-primary/10">
              {stateLabel}
            </Badge>
            {statusBadges.map((badgeLabel) => (
              <Badge key={badgeLabel} variant="secondary" className="max-w-full whitespace-normal break-words">
                {badgeLabel}
              </Badge>
            ))}
          </div>
          <div className="space-y-1">
            <CardDescription className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
              {lineLabel}
            </CardDescription>
            <CardTitle className="text-2xl leading-tight sm:text-3xl">
              <span className="block overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5]">
                {currentLine?.text ?? 'Car mode keeps the active session on one fixed screen.'}
              </span>
            </CardTitle>
          </div>
        </CardHeader>

        <CardContent className="mt-auto space-y-3">
          <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-background/60 px-3 py-3">
            {getStateIcon(rehearsalState)}
            <div className="min-w-0">
              <p className="text-sm font-semibold">{stateLabel}</p>
              <p className="text-sm text-muted-foreground">{getPrimaryInstruction(currentLine, rehearsalState)}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-2xl border border-border/60 bg-background/60 px-2 py-3">
              <ArrowLeft className="mx-auto mb-1 h-4 w-4 text-primary" />
              <p className="text-xs font-semibold">Back</p>
              <p className="text-[11px] text-muted-foreground">
                {canGoPrevious ? 'Replay cue' : 'No earlier line'}
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/60 px-2 py-3">
              {getStateIcon(rehearsalState)}
              <p className="mt-1 text-xs font-semibold">Current</p>
              <p className="text-[11px] text-muted-foreground">
                {autoSpeakCorrections ? 'Corrections on' : 'Corrections off'}
              </p>
            </div>
            <div className="rounded-2xl border border-border/60 bg-background/60 px-2 py-3">
              <ArrowRight className="mx-auto mb-1 h-4 w-4 text-primary" />
              <p className="text-xs font-semibold">Next</p>
              <p className="text-[11px] text-muted-foreground">
                {canGoNext ? 'Skip ahead' : 'Wait for cue'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
