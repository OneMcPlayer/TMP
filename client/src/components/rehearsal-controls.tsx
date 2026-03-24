import { Button } from '@/components/ui/button';
import type { RehearsalState } from '@/lib/types';
import {
  ArrowRight,
  CarFront,
  Loader2,
  Mic,
  MicVocal,
  Play,
  RotateCcw,
  Square,
  Volume2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface RehearsalControlsProps {
  state: RehearsalState;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onNext: () => void;
  onStart: () => void;
  onRestart: () => void;
  onReplayExpectedLine: () => void;
  onRetryLine: () => void;
  onSkipLine: () => void;
  onRecoverPreparation: () => void;
  hasStarted: boolean;
  isComplete: boolean;
  carMode?: boolean;
  canReplayExpectedLine?: boolean;
  canRetryLine?: boolean;
  disabled?: boolean;
  showSlowPreparationHint?: boolean;
  slowPreparationSeconds?: number;
  showPreparationRecoveryAction?: boolean;
}

export function RehearsalControls({
  state,
  onStartRecording,
  onStopRecording,
  onNext,
  onStart,
  onRestart,
  onReplayExpectedLine,
  onRetryLine,
  onSkipLine,
  onRecoverPreparation,
  hasStarted,
  isComplete,
  carMode = false,
  canReplayExpectedLine = false,
  canRetryLine = false,
  disabled = false,
  showSlowPreparationHint = false,
  slowPreparationSeconds = 0,
  showPreparationRecoveryAction = false,
}: RehearsalControlsProps) {
  const actionButtonClass = carMode
    ? 'h-24 w-full rounded-3xl text-xl font-semibold shadow-lg'
    : 'gap-2';

  if (isComplete) {
    return (
      <div className="flex flex-col items-center gap-4 p-6 bg-card rounded-lg">
        <div className="text-center">
          <h3 className="text-xl font-semibold mb-1">Rehearsal Complete!</h3>
          <p className="text-muted-foreground">Great job practicing your lines</p>
        </div>
        <Button
          data-testid="button-restart"
          onClick={onRestart}
          size="lg"
          className="gap-2"
        >
          <RotateCcw className="w-5 h-5" />
          Start Over
        </Button>
      </div>
    );
  }

  if (!hasStarted) {
    return (
      <div className="flex justify-center p-6">
        <Button
          data-testid="button-start-rehearsal"
          onClick={onStart}
          size="lg"
          className={cn(
            'gap-2 text-lg px-8',
            carMode && 'h-20 w-full max-w-xl rounded-3xl text-xl shadow-lg',
          )}
          disabled={disabled}
        >
          <Play className="w-5 h-5" />
          Begin Rehearsal
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'p-4 bg-card rounded-lg',
        carMode ? 'space-y-4' : 'flex items-center justify-center gap-4',
      )}
    >
      {carMode && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <CarFront className="w-4 h-4" />
          <span>Car mode uses larger controls and stronger microphone input cleanup.</span>
        </div>
      )}

      {state === 'waiting-for-user' && (
        <div className={cn('flex gap-3', carMode && 'flex-col')}>
          <Button
            data-testid="button-record"
            onClick={onStartRecording}
            size="lg"
            className={actionButtonClass}
          >
            {carMode ? <MicVocal className="w-8 h-8" /> : <Mic className="w-5 h-5" />}
            {carMode ? 'Tap To Speak' : 'Record Your Line'}
          </Button>
          <Button
            data-testid="button-skip-line"
            type="button"
            variant="outline"
            onClick={onSkipLine}
            size="lg"
            className={carMode ? actionButtonClass : 'gap-2'}
          >
            <ArrowRight className="w-5 h-5" />
            Skip Line
          </Button>
        </div>
      )}

      {state === 'recording' && (
        <Button
          data-testid="button-stop-recording"
          onClick={onStopRecording}
          size="lg"
          variant="destructive"
          className={cn(actionButtonClass, 'animate-pulse-recording')}
        >
          <Square className={cn(carMode ? 'w-8 h-8' : 'w-5 h-5')} />
          Stop Recording
        </Button>
      )}

      {state === 'processing' && (
        <Button size="lg" disabled className={actionButtonClass}>
          <Loader2 className="w-5 h-5 animate-spin" />
          Processing...
        </Button>
      )}

      {state === 'playing-tts' && (
        <Button size="lg" disabled className={actionButtonClass}>
          <Volume2 className="w-5 h-5" />
          Speaking...
        </Button>
      )}

      {state === 'playing-correction' && (
        <Button size="lg" disabled className={actionButtonClass}>
          <Volume2 className="w-5 h-5" />
          Reading Correct Line...
        </Button>
      )}

      {state === 'showing-feedback' && (
        <div className={cn('flex gap-3', carMode && 'flex-col')}>
          {canReplayExpectedLine && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={onReplayExpectedLine}
              className={carMode ? actionButtonClass : 'gap-2'}
            >
              <Volume2 className="w-5 h-5" />
              Hear Correct Line
            </Button>
          )}

          {canRetryLine && (
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={onRetryLine}
              className={carMode ? actionButtonClass : 'gap-2'}
            >
              <RotateCcw className="w-5 h-5" />
              Retry Line
            </Button>
          )}

          <Button
            data-testid="button-next"
            onClick={onNext}
            size="lg"
            className={carMode ? actionButtonClass : 'gap-2'}
          >
            <ArrowRight className="w-5 h-5" />
            Next Line
          </Button>
        </div>
      )}

      {state === 'idle' && hasStarted && (
        <div className={cn('flex items-center gap-3', carMode && 'flex-col items-stretch')}>
          <div className="text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {showSlowPreparationHint
              ? `Preparing next line... (${slowPreparationSeconds}s so far, this can happen on mobile networks)`
              : 'Preparing next line...'}
          </div>
          {showPreparationRecoveryAction && (
            <Button type="button" variant="outline" onClick={onRecoverPreparation}>
              Retry now
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
