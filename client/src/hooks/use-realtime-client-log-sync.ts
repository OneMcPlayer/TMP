import { useEffect, useRef } from 'react';
import type { DebugLogEntry } from '@/lib/debug-log';
import {
  MAX_REALTIME_CLIENT_LOG_BATCH_SIZE,
  postRealtimeClientLogs,
} from '@/lib/realtime-client-logs';

interface RealtimeClientLogSyncOptions {
  backendBaseUrl: string | null;
  entries: DebugLogEntry[];
  sessionId: string | null;
  source: string;
}

export function useRealtimeClientLogSync({
  backendBaseUrl,
  entries,
  sessionId,
  source,
}: RealtimeClientLogSyncOptions): void {
  const entriesRef = useRef(entries);
  const syncedCountRef = useRef(0);
  const activeSessionKeyRef = useRef<string | null>(null);
  const isSyncingRef = useRef(false);

  entriesRef.current = entries;

  useEffect(() => {
    const nextSessionKey = backendBaseUrl
      ? `${backendBaseUrl}::${sessionId ?? 'pre-session'}`
      : null;
    if (activeSessionKeyRef.current !== nextSessionKey) {
      activeSessionKeyRef.current = nextSessionKey;
      syncedCountRef.current = 0;
    }
  }, [backendBaseUrl, sessionId]);

  useEffect(() => {
    if (!backendBaseUrl || isSyncingRef.current) {
      return;
    }

    if (entries.length < syncedCountRef.current) {
      syncedCountRef.current = 0;
    }

    if (entries.length <= syncedCountRef.current) {
      return;
    }

    isSyncingRef.current = true;

    async function syncPendingLogs() {
      try {
        while (true) {
          const nextBatch = entriesRef.current.slice(
            syncedCountRef.current,
            syncedCountRef.current + MAX_REALTIME_CLIENT_LOG_BATCH_SIZE,
          );

          if (nextBatch.length === 0) {
            return;
          }

          const acceptedCount = await postRealtimeClientLogs({
            backendBaseUrl,
            entries: nextBatch,
            sessionId,
            source,
          });

          if (acceptedCount <= 0) {
            return;
          }

          syncedCountRef.current += Math.min(acceptedCount, nextBatch.length);
        }
      } catch {
        // Leave the synced counter unchanged so the next local log update retries.
      } finally {
        isSyncingRef.current = false;
      }
    }

    void syncPendingLogs();
  }, [backendBaseUrl, entries, sessionId, source]);
}
