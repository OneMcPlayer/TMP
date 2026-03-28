import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  AlertCircle,
  CarFront,
  CheckCircle2,
  Loader2,
  Mic,
  Play,
  Theater,
  Volume2,
} from 'lucide-react';

type DeviceSetupStatus = 'idle' | 'pending' | 'ready' | 'error';

interface DeviceSetupScreenProps {
  apiKeySection: ReactNode;
  characterSection: ReactNode;
  autoSpeakCorrections: boolean;
  canStart: boolean;
  carMode: boolean;
  isDeviceReady: boolean;
  isPreparing: boolean;
  microphoneStatus: DeviceSetupStatus;
  microphoneMessage?: string | null;
  playbackStatus: DeviceSetupStatus;
  playbackMessage?: string | null;
  onAutoSpeakCorrectionsChange: (nextValue: boolean) => void;
  onCarModeChange: (nextValue: boolean) => void;
  onPrepare: () => void;
  onStart: () => void;
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
        'rounded-2xl border p-4 transition-colors',
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

interface ModeCardProps {
  description: string;
  icon: ReactNode;
  isSelected: boolean;
  label: string;
  onSelect: () => void;
  testId: string;
}

function ModeCard({ description, icon, isSelected, label, onSelect, testId }: ModeCardProps) {
  return (
    <button
      data-testid={testId}
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-2xl border p-4 text-left transition-all',
        isSelected
          ? 'border-primary bg-primary/5 shadow-sm'
          : 'border-border bg-background hover:border-primary/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="text-primary">{icon}</span>
            <span>{label}</span>
          </div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {isSelected && <CheckCircle2 className="h-5 w-5 text-primary" />}
      </div>
    </button>
  );
}

export function DeviceSetupScreen({
  apiKeySection,
  characterSection,
  autoSpeakCorrections,
  canStart,
  carMode,
  isDeviceReady,
  isPreparing,
  microphoneStatus,
  microphoneMessage,
  playbackStatus,
  playbackMessage,
  onAutoSpeakCorrectionsChange,
  onCarModeChange,
  onPrepare,
  onStart,
}: DeviceSetupScreenProps) {
  return (
    <div className="flex-1 bg-background">
      <div className="mx-auto flex min-h-[calc(100vh-73px)] w-full max-w-6xl flex-col justify-center gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <Card className="overflow-hidden border-primary/20 bg-gradient-to-br from-background via-background to-primary/5">
            <CardHeader className="space-y-4 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <Theater className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.2em] text-muted-foreground">
                    Rehearsal Partner
                  </p>
                  <CardTitle className="text-3xl sm:text-4xl">Set Up Before You Start</CardTitle>
                </div>
              </div>
              <CardDescription className="max-w-2xl text-base leading-7">
                This first screen unlocks playback, confirms microphone access, and lets you choose
                the rehearsal mode before the scene begins. Once this is ready, the rehearsal view
                stays much simpler.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <Alert className="border-primary/30 bg-primary/5">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>One-time device check</AlertTitle>
                <AlertDescription>
                  No line is recorded or uploaded here. This only verifies that iPhone can play
                  audio and grant microphone access before the rehearsal starts.
                </AlertDescription>
              </Alert>

              <div className="grid gap-4 md:grid-cols-2">
                <ModeCard
                  testId="button-mode-normal"
                  label="Normal mode"
                  icon={<Play className="h-4 w-4" />}
                  isSelected={!carMode}
                  onSelect={() => onCarModeChange(false)}
                  description="Richer on-screen feedback, manual recording, and the familiar line-by-line rehearsal flow."
                />
                <ModeCard
                  testId="button-mode-car"
                  label="Car mode"
                  icon={<CarFront className="h-4 w-4" />}
                  isSelected={carMode}
                  onSelect={() => onCarModeChange(true)}
                  description="Large state-driven UI with media next and previous controls for safer repeat and skip actions."
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <SetupCheckCard
                  title="Microphone"
                  description={
                    carMode
                      ? 'Checks microphone access before entering the simplified drive-friendly rehearsal flow.'
                      : 'Requests microphone permission up front so your first line does not stall.'
                  }
                  status={microphoneStatus}
                  message={microphoneMessage}
                  icon={<Mic className="h-4 w-4" />}
                />
                <SetupCheckCard
                  title="Playback"
                  description="Unlocks browser audio early so partner lines and corrections can play more reliably."
                  status={playbackStatus}
                  message={playbackMessage}
                  icon={<Volume2 className="h-4 w-4" />}
                />
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  data-testid="button-prepare-device"
                  type="button"
                  size="lg"
                  onClick={onPrepare}
                  disabled={isPreparing}
                  className="flex-1 gap-2 text-base"
                >
                  {isPreparing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Mic className="h-5 w-5" />}
                  {isPreparing ? 'Checking microphone and audio…' : 'Run device check'}
                </Button>
                <Button
                  data-testid="button-start-rehearsal"
                  type="button"
                  size="lg"
                  variant={isDeviceReady ? 'default' : 'outline'}
                  disabled={!canStart}
                  onClick={onStart}
                  className="flex-1 gap-2 text-base"
                >
                  <Play className="h-5 w-5" />
                  Begin Rehearsal
                </Button>
              </div>

              <div className="rounded-2xl border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
                {isDeviceReady
                  ? 'Device check complete. You can begin immediately, or run the check again if you changed headphones, route, or permissions.'
                  : 'Run the device check first. The rehearsal start button stays locked until microphone and playback are ready.'}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            {apiKeySection}
            {characterSection}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Playback Options</CardTitle>
                <CardDescription>
                  Keep the rehearsal focused on cueing instead of configuration.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="spoken-corrections">Speak the correct line when I miss it</Label>
                    <p className="text-sm text-muted-foreground">
                      {carMode
                        ? 'Car mode keeps spoken corrections optional so you can choose between a quieter drive or more guidance.'
                        : 'After a mismatch, the app can read the expected line aloud before you continue.'}
                    </p>
                  </div>
                  <Switch
                    id="spoken-corrections"
                    checked={autoSpeakCorrections}
                    onCheckedChange={onAutoSpeakCorrectionsChange}
                  />
                </div>

                <div className="rounded-2xl bg-muted/60 p-4 text-sm text-muted-foreground">
                  {carMode
                    ? 'In car mode, the rehearsal view becomes a single status-driven screen. Use steering-wheel, headset, or lock-screen track controls to move back or forward when supported.'
                    : 'In normal mode, recording stays manual. Partner playback and correction playback can still run automatically when Safari allows it.'}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
