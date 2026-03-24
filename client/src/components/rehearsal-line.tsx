import { cn } from '@/lib/utils';
import type { RehearsalLine as RehearsalLineType, WordDiff } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Bot, CheckCircle2, Clock, Mic, User, Volume2 } from 'lucide-react';

interface RehearsalLineProps {
  line: RehearsalLineType;
  isCurrentLine: boolean;
}

function ScriptText({ text }: { text: string }) {
  const parts = text.split(/(\([^()]*\))/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        const isStageDirection = part.startsWith('(') && part.endsWith(')');

        return (
          <span
            key={`${part}-${index}`}
            className={cn(isStageDirection && 'text-muted-foreground italic')}
          >
            {part}
            {index < parts.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </>
  );
}

function DiffDisplay({ diff }: { diff: WordDiff[] }) {
  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {diff.map((item, index) => (
        <span
          key={index}
          className={cn(
            'max-w-full break-words px-1 py-0.5 rounded text-sm font-medium',
            item.status === 'correct' && 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
            item.status === 'missing' && 'bg-red-100 text-red-800 line-through dark:bg-red-900/30 dark:text-red-300',
            item.status === 'extra' && 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
          )}
        >
          {item.word}
        </span>
      ))}
    </div>
  );
}

export function RehearsalLineComponent({ line, isCurrentLine }: RehearsalLineProps) {
  const showPlaceholder = line.isUserLine && line.state !== 'completed';
  const showResults = line.isUserLine && line.state === 'completed' && Boolean(line.spokenText);
  const hasErrors = Boolean(line.diff?.some((item) => item.status !== 'correct'));

  return (
    <div
      data-testid={`line-${line.index}`}
      className={cn(
        'p-4 rounded-lg transition-all duration-300 animate-fade-in-up',
        isCurrentLine && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        line.state === 'pending' && 'opacity-40',
        line.state === 'active' && 'bg-card',
        line.state === 'completed' && 'bg-card/50'
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cn(
          'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
          line.isUserLine 
            ? 'bg-primary/10 text-primary' 
            : 'bg-accent/30 text-accent-foreground'
        )}>
          {line.isUserLine ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn(
              'font-semibold text-sm',
              line.isUserLine ? 'text-primary' : 'text-muted-foreground'
            )}>
              {line.character}
            </span>
            
            {line.isUserLine && (
              <Badge variant="outline" className="text-xs">
                You
              </Badge>
            )}
            
            {line.state === 'active' && line.isUserLine && (
              <Badge className="text-xs bg-primary/10 text-primary border-primary/20">
                <Mic className="w-3 h-3 mr-1" />
                Your turn
              </Badge>
            )}
            
            {line.state === 'active' && !line.isUserLine && (
              <Badge className="text-xs bg-accent/20 text-accent-foreground border-accent/30">
                <Clock className="w-3 h-3 mr-1" />
                Speaking...
              </Badge>
            )}
            
            {line.state === 'completed' && line.accuracy !== undefined && (
              <Badge 
                className={cn(
                  'text-xs',
                  line.accuracy >= 80 && 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
                  line.accuracy >= 50 && line.accuracy < 80 && 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
                  line.accuracy < 50 && 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                )}
              >
                <CheckCircle2 className="w-3 h-3 mr-1" />
                {line.accuracy}%
              </Badge>
            )}

            {line.correctionPlayed && (
              <Badge variant="outline" className="text-xs">
                <Volume2 className="w-3 h-3 mr-1" />
                Correction spoken
              </Badge>
            )}
          </div>
          
          {showPlaceholder ? (
            <div className="flex items-center gap-2 text-muted-foreground italic">
              <span className="text-base">Recall your line...</span>
            </div>
          ) : (
            <>
              <p className={cn(
                'text-base leading-relaxed break-words',
                line.state === 'completed' && line.isUserLine && 'font-medium'
              )}>
                <ScriptText text={line.text} />
              </p>
              
              {showResults && (
                <div className="mt-3 pt-3 border-t border-border/50">
                  <p className="text-xs text-muted-foreground mb-1">Transcribed</p>
                  <p className="text-sm leading-relaxed break-words">{line.spokenText}</p>

                  {hasErrors && line.diff && (
                    <>
                      <p className="text-xs text-muted-foreground mt-3 mb-2">Comparison</p>
                      <DiffDisplay diff={line.diff} />
                    </>
                  )}

                  <p className="text-xs text-muted-foreground mt-3">
                    Comparison ignores punctuation and stage directions in parentheses.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
