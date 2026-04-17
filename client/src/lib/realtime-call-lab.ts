import { serializeDebugLogEntries, type DebugLogEntry } from './debug-log';

export interface RealtimeServerLogEntry {
  seq: number;
  timestamp: string;
  level: 'error' | 'info';
  event: string;
  details?: string;
}

export interface RealtimeCallLabReport {
  version: string;
  exportedAt: string;
  backendBaseUrl: string;
  sessionId?: string | null;
  callId?: string | null;
  status: string;
  connectionState: string;
  iceConnectionState: string;
  iceGatheringState: string;
  signalingState: string;
  dataChannelState: string;
  remoteAudioAttached: boolean;
  remoteAudioPlaying: boolean;
  notes?: string;
  localLogs: DebugLogEntry[];
  serverLogs: RealtimeServerLogEntry[];
}

export const REALTIME_CALL_LAB_BACKEND_STORAGE_KEY = 'realtime_call_lab_backend_url';

export function normalizeRealtimeCallLabBackendUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function summarizeRealtimeEvent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return 'Unrecognized realtime event payload';
  }

  const event = payload as {
    error?: { message?: string; type?: string };
    event_id?: string;
    response?: { id?: string };
    session?: { id?: string };
    type?: string;
  };

  const parts = [
    typeof event.type === 'string' ? `type=${event.type}` : null,
    typeof event.event_id === 'string' ? `event=${event.event_id}` : null,
    typeof event.session?.id === 'string' ? `session=${event.session.id}` : null,
    typeof event.response?.id === 'string' ? `response=${event.response.id}` : null,
    typeof event.error?.type === 'string' ? `errorType=${event.error.type}` : null,
    typeof event.error?.message === 'string' ? `error=${event.error.message}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' | ') : 'Realtime event received';
}

export function serializeRealtimeServerLogs(entries: RealtimeServerLogEntry[]): string {
  if (entries.length === 0) {
    return 'No backend logs recorded yet.';
  }

  return entries
    .map((entry) => {
      const prefix = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.event}`;
      return entry.details ? `${prefix} — ${entry.details}` : prefix;
    })
    .join('\n');
}

export function serializeRealtimeCallLabReport(
  report: RealtimeCallLabReport,
): string {
  return [
    'Realtime Browser Call Lab Report',
    `Version: ${report.version}`,
    `Exported: ${report.exportedAt}`,
    `Backend: ${report.backendBaseUrl || 'not configured'}`,
    `Session ID: ${report.sessionId ?? 'none'}`,
    `Call ID: ${report.callId ?? 'none'}`,
    '',
    'State',
    `Status: ${report.status}`,
    `Peer connection: ${report.connectionState}`,
    `ICE connection: ${report.iceConnectionState}`,
    `ICE gathering: ${report.iceGatheringState}`,
    `Signaling: ${report.signalingState}`,
    `Data channel: ${report.dataChannelState}`,
    `Remote audio attached: ${report.remoteAudioAttached ? 'yes' : 'no'}`,
    `Remote audio playing: ${report.remoteAudioPlaying ? 'yes' : 'no'}`,
    '',
    'Notes',
    report.notes?.trim() || 'No tester notes provided.',
    '',
    'Local Log',
    serializeDebugLogEntries(report.localLogs),
    '',
    'Backend Log',
    serializeRealtimeServerLogs(report.serverLogs),
  ].join('\n');
}
