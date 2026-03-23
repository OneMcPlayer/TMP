export interface DebugLogEntry {
  timestamp: string;
  event: string;
  details?: string;
}

export const MAX_DEBUG_LOG_ENTRIES = 400;

export function createDebugLogEntry(
  event: string,
  details?: string,
  timestamp: string = new Date().toISOString(),
): DebugLogEntry {
  return {
    timestamp,
    event,
    details,
  };
}

export function appendDebugLogEntry(
  entries: DebugLogEntry[],
  entry: DebugLogEntry,
  maxEntries: number = MAX_DEBUG_LOG_ENTRIES,
): DebugLogEntry[] {
  if (maxEntries <= 0) {
    return [];
  }

  const nextEntries = [...entries, entry];
  if (nextEntries.length <= maxEntries) {
    return nextEntries;
  }

  return nextEntries.slice(nextEntries.length - maxEntries);
}

export function serializeDebugLogEntries(entries: DebugLogEntry[]): string {
  if (entries.length === 0) {
    return 'No debug events recorded yet.';
  }

  return entries
    .map((entry) =>
      entry.details
        ? `[${entry.timestamp}] ${entry.event} — ${entry.details}`
        : `[${entry.timestamp}] ${entry.event}`,
    )
    .join('\n');
}
