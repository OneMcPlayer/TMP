import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import type { RehearsalLine, RehearsalState } from '@/lib/types';
import { Mic, Square, Volume2 } from 'lucide-react';

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
      return 'Listening';
    case 'recording':
      return 'Recording';
    case 'processing':
      return 'Checking';
    case 'playing-tts':
      return 'Speaking';
    case 'playing-correction':
      return 'Correction';
    case 'showing-feedback':
      return 'Ready';
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
    return 'Speak your line now.';
  }

  if (rehearsalState === 'processing') {
    return 'Checking your last line.';
  }

  if (!currentLine.isUserLine) {
    return 'Speaking the other line.';
  }

  if (rehearsalState === 'showing-feedback') {
    return 'Use next to continue or back to replay.';
  }

  if (currentLine.isUserLine) {
    return 'Press Tap To Speak, or use play or next to start.';
  }

  return 'Use play, back, or next controls when supported.';
}

function getStateIcon(rehearsalState: RehearsalState) {
  if (rehearsalState === 'recording') {
    return <Square className="h-7 w-7 text-destructive" />;
  }

  if (rehearsalState === 'playing-tts' || rehearsalState === 'playing-correction') {
    return <Volume2 className="h-7 w-7 text-primary" />;
  }

  return <Mic className="h-7 w-7 text-primary" />;
}

export function CarModeStage({
  currentLine,
  rehearsalState,
}: CarModeStageProps) {
  const stateLabel = getStateLabel(rehearsalState);
  const primaryInstruction = getPrimaryInstruction(currentLine, rehearsalState);

  return (
    <div
      className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden px-4 py-3"
      data-testid="car-mode-stage"
    >
      <Card className="flex min-h-0 flex-1 overflow-hidden border-primary/20 bg-gradient-to-br from-background via-background to-primary/5 shadow-sm">
        <CardContent className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-8 text-center">
          <Badge variant="outline" className="px-4 py-1 text-sm">
            Car mode
          </Badge>
          <div className="rounded-full border border-primary/20 bg-primary/10 p-5 text-primary">
            {getStateIcon(rehearsalState)}
          </div>
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-[0.35em] text-muted-foreground">
              Active State
            </p>
            <h2 className="text-5xl font-semibold leading-none sm:text-6xl">
              {stateLabel}
            </h2>
          </div>
          <p className="max-w-xs text-lg leading-snug text-muted-foreground sm:text-xl">
            {primaryInstruction}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
