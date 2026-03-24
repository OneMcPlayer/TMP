import { Badge } from '@/components/ui/badge';
import { CarFront, Clapperboard, FileText, Smartphone, Volume2 } from 'lucide-react';

type WakeLockStatus = 'active' | 'requesting' | 'inactive' | 'unavailable' | 'error';

interface ScriptHeaderProps {
  title: string;
  author?: string;
  totalLines: number;
  completedLines: number;
  userCharacter: string | null;
  carMode?: boolean;
  autoSpeakCorrections?: boolean;
  wakeLockStatus?: WakeLockStatus;
  showWakeLockStatus?: boolean;
}

export function ScriptHeader({
  title,
  author,
  totalLines,
  completedLines,
  userCharacter,
  carMode = false,
  autoSpeakCorrections = false,
  wakeLockStatus = 'inactive',
  showWakeLockStatus = false,
}: ScriptHeaderProps) {
  const progress = totalLines > 0 ? Math.round((completedLines / totalLines) * 100) : 0;
  const wakeLockBadge = showWakeLockStatus
    ? wakeLockStatus === 'active'
      ? {
          label: 'Screen awake',
          className:
            'text-xs border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
        }
      : wakeLockStatus === 'requesting'
      ? {
          label: 'Waking screen',
          className: 'text-xs border-primary/30 text-primary',
        }
      : wakeLockStatus === 'unavailable' || wakeLockStatus === 'error'
      ? {
          label: 'Keep phone unlocked',
          className:
            'text-xs border-amber-500/30 text-amber-700 dark:text-amber-300',
        }
      : null
    : null;

  return (
    <div className="p-4 border-b border-border bg-card/50">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Clapperboard className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-serif font-semibold break-words">{title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <FileText className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {totalLines} lines total
              </span>
              {author && (
                <span className="text-sm text-muted-foreground">{author}</span>
              )}
              {userCharacter && (
                <Badge variant="secondary" className="text-xs">
                  Playing as {userCharacter}
                </Badge>
              )}
              {carMode && (
                <Badge variant="outline" className="text-xs">
                  <CarFront className="w-3 h-3 mr-1" />
                  Car mode
                </Badge>
              )}
              {autoSpeakCorrections && (
                <Badge variant="outline" className="text-xs">
                  <Volume2 className="w-3 h-3 mr-1" />
                  Spoken corrections
                </Badge>
              )}
              {wakeLockBadge && (
                <Badge variant="outline" className={wakeLockBadge.className}>
                  <Smartphone className="w-3 h-3 mr-1" />
                  {wakeLockBadge.label}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-2xl font-bold text-primary">{progress}%</p>
            <p className="text-xs text-muted-foreground">Complete</p>
          </div>
          <div className="w-16 h-16">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className="text-muted/30"
              />
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeDasharray={`${progress} 100`}
                strokeLinecap="round"
                className="text-primary transition-all duration-500"
              />
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
