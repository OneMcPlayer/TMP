import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RehearsalLineComponent } from './rehearsal-line';
import type { RehearsalLine } from '@/lib/types';

interface RehearsalTimelineProps {
  lines: RehearsalLine[];
  currentLineIndex: number;
}

export function RehearsalTimeline({ lines, currentLineIndex }: RehearsalTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    const currentLineElement = lineRefs.current.get(currentLineIndex);
    if (currentLineElement) {
      currentLineElement.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [currentLineIndex]);

  const visibleLines = lines.filter(line => line.state !== 'pending' || line.index === currentLineIndex);

  if (visibleLines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <p>Press "Begin Rehearsal" to start</p>
      </div>
    );
  }

  return (
    // Keep timeline sizing unchanged until we revisit the narrow-screen overflow issue.
    <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
      <div className="space-y-3 p-4">
        {visibleLines.map((line) => (
          <div
            key={line.index}
            ref={(el) => {
              if (el) lineRefs.current.set(line.index, el);
            }}
          >
            <RehearsalLineComponent
              line={line}
              isCurrentLine={line.index === currentLineIndex}
            />
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
