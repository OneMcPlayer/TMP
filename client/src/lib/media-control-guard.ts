export interface MediaControlGuardState {
  action: string | null;
  timestamp: number;
}

export function shouldIgnoreDuplicateMediaControlAction({
  debounceMs,
  lastAction,
  lastScope,
  lastTimestamp,
  nextAction,
  nextScope,
  now,
}: {
  debounceMs: number;
  lastAction: string | null;
  lastScope?: string | null;
  lastTimestamp: number;
  nextAction: string;
  nextScope?: string | null;
  now: number;
}): boolean {
  if (lastAction !== nextAction) {
    return false;
  }

  if (
    typeof lastScope === 'string' &&
    typeof nextScope === 'string' &&
    lastScope !== nextScope
  ) {
    return false;
  }

  return now - lastTimestamp < debounceMs;
}
