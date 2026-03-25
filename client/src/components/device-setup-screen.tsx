import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  Volume2,
} from 'lucide-react';

type DeviceSetupStatus = 'idle' | 'pending' | 'ready' | 'error';

interface DeviceSetupScreenProps {
  isPreparing: boolean;
  microphoneStatus: DeviceSetupStatus;
  microphoneMessage?: string | null;
  playbackStatus: DeviceSetupStatus;
  playbackMessage?: string | null;
  onPrepare: () => void;
}

function getStatusLabel(status: DeviceSetupStatus): string {
  switch (status) {
    case 'pending':
      return 'Preparing';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Needs attention';
    default:
      return 'Not checked yet';
  }
}

function StatusIcon({ status }: { status: DeviceSetupStatus }) {
  if (status === 'pending') {
    return <Loader2 className="h-5 w-5 animate-spin text-primary" />;
  }

  if (status === 'ready') {
    return <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />;
  }

  if (status === 'error') {
    return <AlertCircle className="h-5 w-5 text-destructive" />;
  }

  return <div className="h-5 w-5 rounded-full border border-dashed border-muted-foreground/40" />;
}

interface SetupCheckCardProps {
  title: string;
  description: string;
  status: DeviceSetupStatus;
  message?: string | null;
  icon: ReactNode;
}

function SetupCheckCard({
  title,
  description,
  status,
  message,
  icon,
}: SetupCheckCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-colors',
        status === 'ready' && 'border-green-500/40 bg-green-500/5',
        status === 'error' && 'border-destructive/40 bg-destructive/5',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="text-primary">{icon}</span>
            <span>{title}</span>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <StatusIcon status={status} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span
          className={cn(
            'font-medium',
            status === 'ready' && 'text-green-700 dark:text-green-300',
            status === 'error' && 'text-destructive',
            status === 'idle' && 'text-muted-foreground',
          )}
        >
          {getStatusLabel(status)}
        </span>
        {message && (
          <span className={cn('text-right text-xs', status === 'error' && 'text-destructive')}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}

export function DeviceSetupScreen({
  isPreparing,
  microphoneStatus,
  microphoneMessage,
  playbackStatus,
  playbackMessage,
  onPrepare,
}: DeviceSetupScreenProps) {
  return (
    <div className="p-4">
      <Card className="mx-auto max-w-3xl">
        <CardHeader className="space-y-3">
          <CardTitle className="text-2xl">Prepare Your Device First</CardTitle>
          <CardDescription className="text-base">
            This quick check asks for microphone access and unlocks audio playback now, so the
            rehearsal itself feels smoother once you begin.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>What this does</AlertTitle>
            <AlertDescription>
              No line is recorded or sent yet. This only warms up the browser’s microphone and
              speaker permissions ahead of the actual rehearsal.
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 md:grid-cols-2">
            <SetupCheckCard
              title="Microphone"
              description="Requests microphone permission up front so your first line does not stall."
              status={microphoneStatus}
              message={microphoneMessage}
              icon={<Mic className="h-4 w-4" />}
            />
            <SetupCheckCard
              title="Playback"
              description="Unlocks browser audio early so partner lines and corrections can play reliably."
              status={playbackStatus}
              message={playbackMessage}
              icon={<Volume2 className="h-4 w-4" />}
            />
          </div>

          <div className="flex justify-center">
            <Button
              data-testid="button-prepare-device"
              type="button"
              size="lg"
              onClick={onPrepare}
              disabled={isPreparing}
              className="w-full max-w-xl gap-2 text-base sm:text-lg"
            >
              {isPreparing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
              {isPreparing ? 'Preparing your device…' : 'Prepare microphone and audio'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
