import type { DebugLogEntry } from './debug-log';

export const MAX_REALTIME_CLIENT_LOG_BATCH_SIZE = 50;

interface PostRealtimeClientLogsOptions {
  backendBaseUrl: string | null;
  entries: DebugLogEntry[];
  fetcher?: typeof fetch;
  sessionId: string | null;
  source: string;
}

export function buildRealtimeClientLogsUrl(
  backendBaseUrl: string,
  sessionId: string,
): string {
  return `${backendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
    sessionId,
  )}/client-logs`;
}

export function buildRealtimeSessionsUrl(backendBaseUrl: string): string {
  return `${backendBaseUrl}/api/realtime-webrtc/sessions`;
}

export function buildRealtimeSessionLogsUrl(
  backendBaseUrl: string,
  sessionId: string,
): string {
  return `${backendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(sessionId)}/logs`;
}

export async function postRealtimeClientLogs({
  backendBaseUrl,
  entries,
  fetcher = fetch,
  sessionId,
  source,
}: PostRealtimeClientLogsOptions): Promise<number> {
  if (!backendBaseUrl || !sessionId || entries.length === 0) {
    return 0;
  }

  const batch = entries.slice(0, MAX_REALTIME_CLIENT_LOG_BATCH_SIZE);
  const response = await fetcher(buildRealtimeClientLogsUrl(backendBaseUrl, sessionId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      entries: batch,
      source,
    }),
  });

  if (!response.ok) {
    throw new Error(`Client log sync failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as { accepted?: unknown };
  return typeof payload.accepted === 'number' ? payload.accepted : batch.length;
}
