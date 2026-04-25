import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CharacterSelector } from '@/components/character-selector';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { useRealtimeClientLogSync } from '@/hooks/use-realtime-client-log-sync';
import { buildAppRouteHref } from '@/lib/app-route';
import { appendDebugLogEntry, createDebugLogEntry, serializeDebugLogEntries, type DebugLogEntry } from '@/lib/debug-log';
import { clampLiveMemorizationStartLine } from '@/lib/live-memorization';
import { playAudioBlob, primeAudioPlayback } from '@/lib/openai';
import {
  buildRealtimeSessionLogsUrl,
  buildRealtimeSessionsUrl,
} from '@/lib/realtime-client-logs';
import { REALTIME_CALL_LAB_BACKEND_STORAGE_KEY, normalizeRealtimeCallLabBackendUrl, serializeRealtimeServerLogs, summarizeRealtimeEvent, type RealtimeServerLogEntry } from '@/lib/realtime-call-lab';
import { normalizeScript } from '@/lib/script-utils';
import { buildTapUserTurnKey, canOpenTapUserTurn, shouldStartTapCoachCueGate } from '@/lib/tap-rehearsal-turn';
import type { RawScript, Script } from '@/lib/types';
import { APP_VERSION } from '@/lib/version';
import { AlertCircle, ArrowLeft, Check, Download, Loader2, Mic, Server, SkipForward, Square, Theater, Wifi } from 'lucide-react';

type SessionStatus =
  | 'idle'
  | 'checking-backend'
  | 'requesting-mic'
  | 'negotiating'
  | 'connected'
  | 'stopping'
  | 'stopped'
  | 'error';

interface BackendHealthSnapshot {
  checkedAt: string;
  ok: boolean;
  openAiConfigured: boolean;
  uptimeSeconds: number;
}

interface RealtimeCallResponse {
  answerSdp: string;
  callId: string | null;
  mode?: string;
  model: string;
  sessionId: string;
  voice: string;
}

interface TapRehearsalCurrentLine {
  character: string;
  isUserLine: boolean;
  lineNumber: number;
}

interface TapRehearsalCorrection {
  accuracy: number;
  attempts: number;
  expectedText: string;
  lineNumber: number;
  spokenText: string;
  timestamp: string;
}

interface LiveMemorizationSpeechEvent {
  seq: number;
  timestamp: string;
  purpose: string;
  text: string;
}

interface TapRehearsalStateResponse {
  callId?: string | null;
  correction?: TapRehearsalCorrection | null;
  currentLine?: TapRehearsalCurrentLine | null;
  speech?: LiveMemorizationSpeechEvent[];
  status?: string;
  turnCommitMode?: string;
}

const DEFAULT_BACKEND_PLACEHOLDER = 'https://your-codespace-8787.your-forwarding-domain';
const DEFAULT_VOICE = 'alloy';
const ICE_GATHERING_TIMEOUT_MS = 1500;
const BACKEND_LOG_POLL_INTERVAL_MS = 1500;
const TAP_STATE_POLL_INTERVAL_MS = 350;
const REHEARSAL_PREFERENCES_STORAGE_KEY = 'rehearsal_preferences';

function getStatusVariant(
  status: SessionStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'connected':
      return 'default';
    case 'checking-backend':
    case 'requesting-mic':
    case 'negotiating':
    case 'stopping':
      return 'secondary';
    case 'error':
      return 'destructive';
    default:
      return 'outline';
  }
}

function downloadFile(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

async function readResponseErrorMessage(response: Response): Promise<string> {
  const responseText = await response.text();

  if (!responseText.trim()) {
    return `Request failed with status ${response.status}.`;
  }

  try {
    const payload = JSON.parse(responseText) as {
      error?: string | { message?: string };
      message?: string;
    };

    if (typeof payload.error === 'string') {
      return payload.error;
    }

    if (typeof payload.error?.message === 'string') {
      return payload.error.message;
    }

    if (typeof payload.message === 'string') {
      return payload.message;
    }
  } catch {
    // Plain-text backend and OpenAI errors are returned as-is.
  }

  return responseText;
}

async function waitForIceGatheringComplete(
  peerConnection: RTCPeerConnection,
  timeoutMs: number,
): Promise<'complete' | 'timeout'> {
  if (peerConnection.iceGatheringState === 'complete') {
    return 'complete';
  }

  return new Promise<'complete' | 'timeout'>((resolve) => {
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      peerConnection.removeEventListener('icegatheringstatechange', handleChange);
    };

    const handleChange = () => {
      if (settled || peerConnection.iceGatheringState !== 'complete') {
        return;
      }

      settled = true;
      cleanup();
      resolve('complete');
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve('timeout');
    }, timeoutMs);

    peerConnection.addEventListener('icegatheringstatechange', handleChange);
  });
}

function loadPreferredCharacter(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawPreferences = localStorage.getItem(REHEARSAL_PREFERENCES_STORAGE_KEY);
    if (!rawPreferences) {
      return null;
    }

    const parsedPreferences = JSON.parse(rawPreferences) as { selectedCharacter?: unknown };
    return typeof parsedPreferences.selectedCharacter === 'string'
      ? parsedPreferences.selectedCharacter
      : null;
  } catch {
    return null;
  }
}

function persistPreferredCharacter(selectedCharacter: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const rawPreferences = localStorage.getItem(REHEARSAL_PREFERENCES_STORAGE_KEY);
    const parsedPreferences =
      rawPreferences ? (JSON.parse(rawPreferences) as Record<string, unknown>) : {};

    localStorage.setItem(
      REHEARSAL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        ...parsedPreferences,
        selectedCharacter,
      }),
    );
  } catch {
    // Preference persistence is best-effort only.
  }
}

function buildTapRehearsalReport(options: {
  backendBaseUrl: string;
  callId: string | null;
  connectionState: string;
  correction: TapRehearsalCorrection | null;
  currentLine: TapRehearsalCurrentLine | null;
  dataChannelState: string;
  exportedAt: string;
  iceConnectionState: string;
  iceGatheringState: string;
  isControlStatePending: boolean;
  isCommittingTurn: boolean;
  isTurnReady: boolean;
  isWaitingForCoachCue: boolean;
  localLogs: DebugLogEntry[];
  selectedCharacter: string;
  serverLogs: RealtimeServerLogEntry[];
  sessionId: string | null;
  signalingState: string;
  startLineNumber: number;
  status: string;
}): string {
  return [
    'Tap Rehearsal Report',
    `Version: ${APP_VERSION}`,
    `Exported: ${options.exportedAt}`,
    `Backend: ${options.backendBaseUrl || 'not configured'}`,
    `Recent Sessions URL: ${
      options.backendBaseUrl ? buildRealtimeSessionsUrl(options.backendBaseUrl) : 'not available'
    }`,
    `Session Logs URL: ${
      options.backendBaseUrl && options.sessionId
        ? buildRealtimeSessionLogsUrl(options.backendBaseUrl, options.sessionId)
        : 'not available'
    }`,
    `Character: ${options.selectedCharacter}`,
    `Start Line: ${options.startLineNumber}`,
    `Session ID: ${options.sessionId ?? 'none'}`,
    `Call ID: ${options.callId ?? 'none'}`,
    '',
    'State',
    `Status: ${options.status}`,
    `Peer connection: ${options.connectionState}`,
    `ICE connection: ${options.iceConnectionState}`,
    `ICE gathering: ${options.iceGatheringState}`,
    `Signaling: ${options.signalingState}`,
    `Data channel: ${options.dataChannelState}`,
    `Current line: ${options.currentLine ? `${options.currentLine.lineNumber} ${options.currentLine.character}` : 'done'}`,
    `Control state pending: ${options.isControlStatePending ? 'yes' : 'no'}`,
    `Coach cue pending: ${options.isWaitingForCoachCue ? 'yes' : 'no'}`,
    `Turn ready: ${options.isTurnReady ? 'yes' : 'no'}`,
    `Turn committing: ${options.isCommittingTurn ? 'yes' : 'no'}`,
    `Correction: ${options.correction ? `${options.correction.lineNumber} at ${options.correction.accuracy}%` : 'none'}`,
    '',
    'Local Log',
    serializeDebugLogEntries(options.localLogs),
    '',
    'Backend Log',
    serializeRealtimeServerLogs(options.serverLogs),
  ].join('\n');
}

export default function TapRehearsalPage() {
  const { toast } = useToast();
  const [backendUrlInput, setBackendUrlInput] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }

    return localStorage.getItem(REALTIME_CALL_LAB_BACKEND_STORAGE_KEY) ?? '';
  });
  const [script, setScript] = useState<Script | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<string | null>(() =>
    loadPreferredCharacter(),
  );
  const [startLineNumber, setStartLineNumber] = useState(1);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [lastCallId, setLastCallId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | 'closed'>('closed');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'closed'>('closed');
  const [iceGatheringState, setIceGatheringState] = useState<RTCIceGatheringState>('new');
  const [signalingState, setSignalingState] = useState<RTCSignalingState | 'closed'>('closed');
  const [dataChannelState, setDataChannelState] = useState<RTCDataChannelState | 'closed'>('closed');
  const [currentLine, setCurrentLine] = useState<TapRehearsalCurrentLine | null>(null);
  const [correction, setCorrection] = useState<TapRehearsalCorrection | null>(null);
  const [coachAudioPlaying, setCoachAudioPlaying] = useState(false);
  const [speechQueueLength, setSpeechQueueLength] = useState(0);
  const [isControlStatePending, setIsControlStatePending] = useState(false);
  const [isWaitingForCoachCue, setIsWaitingForCoachCue] = useState(false);
  const [isTurnReady, setIsTurnReady] = useState(false);
  const [isCommittingTurn, setIsCommittingTurn] = useState(false);
  const [localLogs, setLocalLogs] = useState<DebugLogEntry[]>([]);
  const [serverLogs, setServerLogs] = useState<RealtimeServerLogEntry[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeBackendBaseUrlRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastServerSeqRef = useRef(0);
  const lastSpeechSeqRef = useRef(0);
  const serverLogPollIntervalRef = useRef<number | null>(null);
  const statePollIntervalRef = useRef<number | null>(null);
  const lastBackendPollErrorRef = useRef<string | null>(null);
  const stateGenerationRef = useRef(0);
  const isStartingSessionRef = useRef(false);
  const speechQueueRef = useRef<LiveMemorizationSpeechEvent[]>([]);
  const speechAudioCacheRef = useRef<Map<number, Blob>>(new Map());
  const speechAudioFetchRef = useRef<Map<number, Promise<Blob>>>(new Map());
  const currentSpeechAbortControllerRef = useRef<AbortController | null>(null);
  const currentSpeechRef = useRef<LiveMemorizationSpeechEvent | null>(null);
  const isDrainingSpeechQueueRef = useRef(false);
  const lastOpenedTurnKeyRef = useRef<string | null>(null);
  const pendingCoachCueTurnKeyRef = useRef<string | null>(null);
  const completedCoachCueTurnKeyRef = useRef<string | null>(null);
  const didReceivePendingCoachSpeechRef = useRef(false);
  const isOpeningTurnRef = useRef(false);
  const committedLineNumberRef = useRef<number | null>(null);

  const normalizedBackendUrl = useMemo(
    () => normalizeRealtimeCallLabBackendUrl(backendUrlInput),
    [backendUrlInput],
  );

  useRealtimeClientLogSync({
    backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl,
    entries: localLogs,
    sessionId,
    source: 'tap-rehearsal',
  });

  const characters = useMemo(
    () => (script ? Array.from(new Set(script.lines.map((line) => line.character))) : []),
    [script],
  );
  const clampedStartLineNumber = useMemo(
    () => clampLiveMemorizationStartLine(startLineNumber, script?.lines.length ?? 0),
    [script?.lines.length, startLineNumber],
  );
  const canStartSession = Boolean(script && selectedCharacter && normalizedBackendUrl);
  const isBusyStarting = status === 'requesting-mic' || status === 'negotiating';
  const isLineDoneDisabled = !isTurnReady || isCommittingTurn || status !== 'connected';
  const reportSessionId = sessionId ?? lastSessionId;
  const reportCallId = callId ?? lastCallId;

  const addLocalLog = useCallback((event: string, details?: string) => {
    setLocalLogs((entries) => appendDebugLogEntry(entries, createDebugLogEntry(event, details)));
  }, []);

  const syncPeerConnectionSnapshot = useCallback((peerConnection: RTCPeerConnection | null) => {
    setConnectionState(peerConnection?.connectionState ?? 'closed');
    setIceConnectionState(peerConnection?.iceConnectionState ?? 'closed');
    setIceGatheringState(peerConnection?.iceGatheringState ?? 'new');
    setSignalingState(peerConnection?.signalingState ?? 'closed');
  }, []);

  const clearPolling = useCallback(() => {
    if (serverLogPollIntervalRef.current !== null) {
      window.clearInterval(serverLogPollIntervalRef.current);
      serverLogPollIntervalRef.current = null;
    }

    if (statePollIntervalRef.current !== null) {
      window.clearInterval(statePollIntervalRef.current);
      statePollIntervalRef.current = null;
    }
  }, []);

  const appendServerLogs = useCallback((incomingLogs: RealtimeServerLogEntry[]) => {
    const freshLogs = incomingLogs.filter((entry) => entry.seq > lastServerSeqRef.current);
    if (freshLogs.length === 0) {
      return;
    }

    lastServerSeqRef.current = freshLogs[freshLogs.length - 1].seq;
    setServerLogs((entries) => [...entries, ...freshLogs]);
  }, []);

  const fetchSpeechAudio = useCallback(async (speechEvent: LiveMemorizationSpeechEvent): Promise<Blob> => {
    const cachedAudio = speechAudioCacheRef.current.get(speechEvent.seq);
    if (cachedAudio) {
      return cachedAudio;
    }

    const inFlightRequest = speechAudioFetchRef.current.get(speechEvent.seq);
    if (inFlightRequest) {
      return inFlightRequest;
    }

    const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
    const activeSessionId = sessionIdRef.current;
    if (!activeBackendBaseUrl || !activeSessionId) {
      throw new Error('Tap rehearsal session is not ready for backend speech audio.');
    }

    const requestPromise = (async () => {
      const response = await fetch(
        `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
          activeSessionId,
        )}/live-memorization/speech/${speechEvent.seq}/audio`,
      );

      if (!response.ok) {
        throw new Error(await readResponseErrorMessage(response));
      }

      const audioBlob = await response.blob();
      speechAudioCacheRef.current.set(speechEvent.seq, audioBlob);
      return audioBlob;
    })();

    speechAudioFetchRef.current.set(speechEvent.seq, requestPromise);

    try {
      return await requestPromise;
    } finally {
      speechAudioFetchRef.current.delete(speechEvent.seq);
    }
  }, []);

  const interruptCoachAudioPlayback = useCallback(
    (reason: string) => {
      const currentSpeech = currentSpeechRef.current;
      const abortController = currentSpeechAbortControllerRef.current;

      if (!currentSpeech || !abortController) {
        return;
      }

      addLocalLog(
        'Coach Audio Interrupted',
        `seq=${currentSpeech.seq} | purpose=${currentSpeech.purpose} | reason=${reason}`,
      );
      abortController.abort();
      currentSpeechAbortControllerRef.current = null;
    },
    [addLocalLog],
  );

  const drainSpeechQueue = useCallback(async () => {
    if (isDrainingSpeechQueueRef.current) {
      return;
    }

    isDrainingSpeechQueueRef.current = true;

    try {
      while (speechQueueRef.current.length > 0) {
        const speechEvent = speechQueueRef.current.shift();
        setSpeechQueueLength(speechQueueRef.current.length);
        if (!speechEvent) {
          continue;
        }

        const abortController = new AbortController();
        currentSpeechRef.current = speechEvent;
        currentSpeechAbortControllerRef.current = abortController;
        setCoachAudioPlaying(true);
        setIsTurnReady(false);
        addLocalLog(
          'Coach Audio Started',
          `seq=${speechEvent.seq} | purpose=${speechEvent.purpose}`,
        );

        try {
          const audioBlob = await fetchSpeechAudio(speechEvent);
          await playAudioBlob(audioBlob, {
            signal: abortController.signal,
          });
          addLocalLog(
            'Coach Audio Finished',
            `seq=${speechEvent.seq} | purpose=${speechEvent.purpose}`,
          );
        } catch (error) {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            addLocalLog(
              'Coach Audio Failed',
              `seq=${speechEvent.seq} | ${
                error instanceof Error ? error.message : 'Unknown coach-audio error'
              }`,
            );
          }
        } finally {
          if (currentSpeechRef.current?.seq === speechEvent.seq) {
            currentSpeechRef.current = null;
          }

          if (currentSpeechAbortControllerRef.current === abortController) {
            currentSpeechAbortControllerRef.current = null;
          }

          setCoachAudioPlaying(false);
        }
      }
    } finally {
      isDrainingSpeechQueueRef.current = false;
      setSpeechQueueLength(speechQueueRef.current.length);
      if (
        pendingCoachCueTurnKeyRef.current &&
        didReceivePendingCoachSpeechRef.current &&
        speechQueueRef.current.length === 0
      ) {
        addLocalLog('Coach Cue Completed', `turn=${pendingCoachCueTurnKeyRef.current}`);
        completedCoachCueTurnKeyRef.current = pendingCoachCueTurnKeyRef.current;
        pendingCoachCueTurnKeyRef.current = null;
        didReceivePendingCoachSpeechRef.current = false;
        setIsWaitingForCoachCue(false);
      }
    }
  }, [addLocalLog, fetchSpeechAudio]);

  const appendSpeechEvents = useCallback(
    (incomingSpeechEvents: LiveMemorizationSpeechEvent[]) => {
      const freshSpeechEvents = incomingSpeechEvents.filter(
        (event) => event.seq > lastSpeechSeqRef.current,
      );

      if (freshSpeechEvents.length === 0) {
        return;
      }

      lastSpeechSeqRef.current = freshSpeechEvents[freshSpeechEvents.length - 1].seq;
      speechQueueRef.current.push(...freshSpeechEvents);
      setSpeechQueueLength(speechQueueRef.current.length);
      if (pendingCoachCueTurnKeyRef.current) {
        didReceivePendingCoachSpeechRef.current = true;
        setIsWaitingForCoachCue(true);
      }

      for (const speechEvent of freshSpeechEvents) {
        addLocalLog(
          'Backend Speech Received',
          `seq=${speechEvent.seq} | purpose=${speechEvent.purpose}`,
        );
        void fetchSpeechAudio(speechEvent);
      }

      void drainSpeechQueue();
    },
    [addLocalLog, drainSpeechQueue, fetchSpeechAudio],
  );

  const fetchServerLogs = useCallback(async () => {
    const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
    const activeSessionId = sessionIdRef.current;

    if (!activeBackendBaseUrl || !activeSessionId) {
      return;
    }

    try {
      const response = await fetch(
        `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
          activeSessionId,
        )}/logs?after=${lastServerSeqRef.current}`,
      );

      if (!response.ok) {
        throw new Error(await readResponseErrorMessage(response));
      }

      const payload = (await response.json()) as {
        callId?: string | null;
        logs?: RealtimeServerLogEntry[];
        status?: string;
      };

      lastBackendPollErrorRef.current = null;
      if (typeof payload.callId === 'string') {
        setCallId(payload.callId);
      }
      appendServerLogs(payload.logs ?? []);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend polling error';
      if (lastBackendPollErrorRef.current === message) {
        return;
      }

      lastBackendPollErrorRef.current = message;
      addLocalLog('Backend Log Poll Failed', message);
    }
  }, [addLocalLog, appendServerLogs]);

  const fetchTapRehearsalState = useCallback(async () => {
    const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
    const activeSessionId = sessionIdRef.current;
    const requestStateGeneration = stateGenerationRef.current;

    if (!activeBackendBaseUrl || !activeSessionId) {
      return;
    }

    try {
      const response = await fetch(
        `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
          activeSessionId,
        )}/live-memorization/state?afterSpeechSeq=${lastSpeechSeqRef.current}`,
      );

      if (!response.ok) {
        throw new Error(await readResponseErrorMessage(response));
      }

      const payload = (await response.json()) as TapRehearsalStateResponse;
      if (requestStateGeneration !== stateGenerationRef.current) {
        return;
      }

      lastBackendPollErrorRef.current = null;

      if (typeof payload.callId === 'string') {
        setCallId(payload.callId);
      }

      const nextLine = payload.currentLine ?? null;
      const nextCorrection = payload.correction ?? null;
      const nextTurnKey = buildTapUserTurnKey(nextLine, nextCorrection);
      if (
        shouldStartTapCoachCueGate({
          completedCoachCueTurnKey: completedCoachCueTurnKeyRef.current,
          lastOpenedTurnKey: lastOpenedTurnKeyRef.current,
          pendingCoachCueTurnKey: pendingCoachCueTurnKeyRef.current,
          turnKey: nextTurnKey,
        })
      ) {
        pendingCoachCueTurnKeyRef.current = nextTurnKey;
        didReceivePendingCoachSpeechRef.current = false;
        setIsWaitingForCoachCue(true);
        setIsTurnReady(false);
        addLocalLog('Waiting For Coach Cue', `turn=${nextTurnKey}`);
      } else if (!nextTurnKey) {
        pendingCoachCueTurnKeyRef.current = null;
        didReceivePendingCoachSpeechRef.current = false;
        setIsWaitingForCoachCue(false);
      }

      setCurrentLine(nextLine);
      setCorrection(nextCorrection);
      setIsControlStatePending(false);
      appendSpeechEvents(payload.speech ?? []);

      if (
        isCommittingTurn &&
        (!nextLine ||
          Boolean(payload.correction) ||
          (committedLineNumberRef.current !== null &&
            nextLine.lineNumber !== committedLineNumberRef.current))
      ) {
        setIsCommittingTurn(false);
        committedLineNumberRef.current = null;
        lastOpenedTurnKeyRef.current = null;
      }

      if (!nextLine) {
        setIsTurnReady(false);
        setIsCommittingTurn(false);
      }

      if (payload.status === 'error' && status === 'connected') {
        setStatus('error');
        setErrorMessage('The backend session reported an error. Download the report for details.');
      }
    } catch (error) {
      if (requestStateGeneration !== stateGenerationRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown backend state polling error';
      if (lastBackendPollErrorRef.current === message) {
        return;
      }

      lastBackendPollErrorRef.current = message;
      addLocalLog('Backend State Poll Failed', message);
    }
  }, [addLocalLog, appendSpeechEvents, isCommittingTurn, status]);

  const startPolling = useCallback(() => {
    clearPolling();
    void fetchServerLogs();
    void fetchTapRehearsalState();
    serverLogPollIntervalRef.current = window.setInterval(() => {
      void fetchServerLogs();
    }, BACKEND_LOG_POLL_INTERVAL_MS);
    statePollIntervalRef.current = window.setInterval(() => {
      void fetchTapRehearsalState();
    }, TAP_STATE_POLL_INTERVAL_MS);
  }, [clearPolling, fetchServerLogs, fetchTapRehearsalState]);

  const cleanupActiveSession = useCallback(
    async (options?: { notifyBackend?: boolean }) => {
      clearPolling();
      stateGenerationRef.current += 1;
      interruptCoachAudioPlayback('session-cleanup');
      speechQueueRef.current = [];
      speechAudioCacheRef.current.clear();
      speechAudioFetchRef.current.clear();
      lastSpeechSeqRef.current = 0;
      lastOpenedTurnKeyRef.current = null;
      pendingCoachCueTurnKeyRef.current = null;
      completedCoachCueTurnKeyRef.current = null;
      didReceivePendingCoachSpeechRef.current = false;
      committedLineNumberRef.current = null;

      const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
      const activeSessionId = sessionIdRef.current;

      if (options?.notifyBackend && activeBackendBaseUrl && activeSessionId) {
        try {
          const response = await fetch(
            `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
              activeSessionId,
            )}/end`,
            { method: 'POST' },
          );

          if (!response.ok) {
            throw new Error(await readResponseErrorMessage(response));
          }

          addLocalLog('Backend Session Ended', `session=${activeSessionId}`);
        } catch (error) {
          addLocalLog(
            'Backend Session End Failed',
            error instanceof Error ? error.message : 'Unknown session-end error',
          );
        }
      }

      try {
        dataChannelRef.current?.close();
      } catch {
        // Already-closed channels are safe to ignore.
      }
      dataChannelRef.current = null;
      setDataChannelState('closed');

      const peerConnection = peerConnectionRef.current;
      if (peerConnection) {
        try {
          peerConnection.getSenders().forEach((sender) => {
            sender.track?.stop();
          });
        } catch {
          // Sender access varies during shutdown.
        }

        try {
          peerConnection.close();
        } catch {
          // Closing a dead peer connection is safe to ignore.
        }
      }
      peerConnectionRef.current = null;
      syncPeerConnectionSnapshot(null);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
      }
      localStreamRef.current = null;

      const audioElement = audioRef.current;
      if (audioElement) {
        try {
          audioElement.pause();
        } catch {
          // Ignore detached audio element errors.
        }
        audioElement.srcObject = null;
      }

      activeBackendBaseUrlRef.current = null;
      sessionIdRef.current = null;
      currentSpeechRef.current = null;
      setSessionId(null);
      setCallId(null);
      setCurrentLine(null);
      setCorrection(null);
      setCoachAudioPlaying(false);
      setSpeechQueueLength(0);
      setIsControlStatePending(false);
      setIsWaitingForCoachCue(false);
      setIsTurnReady(false);
      setIsCommittingTurn(false);
    },
    [addLocalLog, clearPolling, interruptCoachAudioPlayback, syncPeerConnectionSnapshot],
  );

  const sendRealtimeEvent = useCallback(
    (event: Record<string, unknown>, logEvent: string): boolean => {
      const dataChannel = dataChannelRef.current;
      if (!dataChannel || dataChannel.readyState !== 'open') {
        addLocalLog(`${logEvent} Failed`, 'Realtime data channel is not open.');
        return false;
      }

      dataChannel.send(JSON.stringify(event));
      addLocalLog(logEvent, `type=${String(event.type ?? 'unknown')}`);
      return true;
    },
    [addLocalLog],
  );

  const openCurrentUserTurn = useCallback(() => {
    if (
      !canOpenTapUserTurn({
        coachAudioPlaying,
        currentLine,
        dataChannelState,
        isControlStatePending,
        isCommittingTurn,
        isOpeningTurn: isOpeningTurnRef.current,
        isWaitingForCoachCue,
        speechQueueLength,
        status,
      })
    ) {
      return;
    }

    const turnKey = buildTapUserTurnKey(currentLine, correction);
    if (!turnKey || lastOpenedTurnKeyRef.current === turnKey) {
      return;
    }

    isOpeningTurnRef.current = true;
    try {
      if (
        sendRealtimeEvent(
          {
            type: 'input_audio_buffer.clear',
          },
          'User Turn Opened',
        )
      ) {
        lastOpenedTurnKeyRef.current = turnKey;
        setIsTurnReady(true);
      }
    } finally {
      isOpeningTurnRef.current = false;
    }
  }, [
    coachAudioPlaying,
    correction?.timestamp,
    currentLine,
    dataChannelState,
    isControlStatePending,
    isCommittingTurn,
    isWaitingForCoachCue,
    sendRealtimeEvent,
    speechQueueLength,
    status,
  ]);

  const handleLineDone = useCallback(() => {
    if (!currentLine?.isUserLine || isLineDoneDisabled) {
      return;
    }

    const didCommit = sendRealtimeEvent(
      {
        type: 'input_audio_buffer.commit',
      },
      'User Line Committed',
    );

    if (!didCommit) {
      toast({
        title: 'Line was not sent',
        description: 'The realtime connection is not ready. Try again after reconnecting.',
        variant: 'destructive',
      });
      return;
    }

    committedLineNumberRef.current = currentLine.lineNumber;
    setIsTurnReady(false);
    setIsCommittingTurn(true);
    setCorrection(null);
  }, [currentLine, isLineDoneDisabled, sendRealtimeEvent, toast]);

  const sendControlCommand = useCallback(
    async (command: 'skip' | 'repeat' | 'reveal') => {
      const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
      const activeSessionId = sessionIdRef.current;

      if (!activeBackendBaseUrl || !activeSessionId) {
        toast({
          title: 'Session not ready',
          description: 'Start tap rehearsal first.',
          variant: 'destructive',
        });
        return;
      }

      try {
        const response = await fetch(
          `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
            activeSessionId,
          )}/live-memorization/control`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ command }),
          },
        );

        if (!response.ok) {
          throw new Error(await readResponseErrorMessage(response));
        }

        if (command === 'skip') {
          stateGenerationRef.current += 1;
          setIsTurnReady(false);
          setIsCommittingTurn(false);
          setIsControlStatePending(true);
          setIsWaitingForCoachCue(true);
          setCurrentLine(null);
          setCorrection(null);
          lastOpenedTurnKeyRef.current = null;
          pendingCoachCueTurnKeyRef.current = null;
          completedCoachCueTurnKeyRef.current = null;
          didReceivePendingCoachSpeechRef.current = false;
        }

        addLocalLog('Control Command Sent', command);
        void fetchServerLogs();
        void fetchTapRehearsalState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown control-command error';
        addLocalLog('Control Command Failed', `${command} | ${message}`);
        toast({
          title: 'Control failed',
          description: message,
          variant: 'destructive',
        });
      }
    },
    [addLocalLog, fetchServerLogs, fetchTapRehearsalState, toast],
  );

  const checkBackendHealth = useCallback(async () => {
    if (!normalizedBackendUrl) {
      const message = 'Enter a valid HTTP(S) backend URL before checking health.';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Backend Health Check Failed', message);
      return;
    }

    setErrorMessage(null);
    setStatus((currentStatus) =>
      currentStatus === 'connected' ? currentStatus : 'checking-backend',
    );
    addLocalLog('Backend Health Check Started', normalizedBackendUrl);

    try {
      const response = await fetch(`${normalizedBackendUrl}/health`);
      if (!response.ok) {
        throw new Error(await readResponseErrorMessage(response));
      }

      const payload = (await response.json()) as {
        ok: boolean;
        openAiConfigured: boolean;
        uptimeSeconds: number;
      };

      const snapshot: BackendHealthSnapshot = {
        checkedAt: new Date().toISOString(),
        ok: Boolean(payload.ok),
        openAiConfigured: Boolean(payload.openAiConfigured),
        uptimeSeconds: Number.isFinite(payload.uptimeSeconds) ? payload.uptimeSeconds : 0,
      };

      setBackendHealth(snapshot);
      setStatus((currentStatus) =>
        currentStatus === 'checking-backend' ? 'idle' : currentStatus,
      );
      addLocalLog(
        'Backend Health Check Succeeded',
        `ok=${snapshot.ok ? 'yes' : 'no'} | openai=${
          snapshot.openAiConfigured ? 'yes' : 'no'
        } | uptime=${snapshot.uptimeSeconds}s`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend health error';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Backend Health Check Failed', message);
    }
  }, [addLocalLog, normalizedBackendUrl]);

  const handleStartSession = useCallback(async () => {
    if (isStartingSessionRef.current) {
      return;
    }

    if (!normalizedBackendUrl || !script || !selectedCharacter) {
      const message = 'Choose a backend, script role, and start line before starting.';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Session Start Blocked', message);
      return;
    }

    if (typeof window.RTCPeerConnection !== 'function') {
      const message = 'RTCPeerConnection is not supported in this browser.';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Session Start Failed', message);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      const message = 'getUserMedia is not supported in this browser.';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Session Start Failed', message);
      return;
    }

    isStartingSessionRef.current = true;
    setErrorMessage(null);
    setServerLogs([]);
    setCurrentLine(null);
    setCorrection(null);
    setIsTurnReady(false);
    setIsCommittingTurn(false);
    lastServerSeqRef.current = 0;
    lastSpeechSeqRef.current = 0;
    lastOpenedTurnKeyRef.current = null;
    lastBackendPollErrorRef.current = null;
    addLocalLog(
      'Tap Rehearsal Start Requested',
      `backend=${normalizedBackendUrl} | line=${clampedStartLineNumber} | character=${selectedCharacter}`,
    );

    try {
      await cleanupActiveSession({ notifyBackend: true });
      await primeAudioPlayback();
      addLocalLog('Coach Audio Ready', 'Local playback primed for backend speech');

      setStatus('requesting-mic');
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      localStreamRef.current = localStream;
      addLocalLog(
        'Local Microphone Ready',
        `tracks=${localStream.getAudioTracks().length} | constraints=echoCancellation,noiseSuppression,autoGainControl`,
      );

      setStatus('negotiating');
      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;
      syncPeerConnectionSnapshot(peerConnection);

      peerConnection.addEventListener('connectionstatechange', () => {
        setConnectionState(peerConnection.connectionState);
        addLocalLog('Peer Connection State Changed', `state=${peerConnection.connectionState}`);
      });
      peerConnection.addEventListener('iceconnectionstatechange', () => {
        setIceConnectionState(peerConnection.iceConnectionState);
        addLocalLog('ICE Connection State Changed', `state=${peerConnection.iceConnectionState}`);
      });
      peerConnection.addEventListener('icegatheringstatechange', () => {
        setIceGatheringState(peerConnection.iceGatheringState);
        addLocalLog('ICE Gathering State Changed', `state=${peerConnection.iceGatheringState}`);
      });
      peerConnection.addEventListener('signalingstatechange', () => {
        setSignalingState(peerConnection.signalingState);
        addLocalLog('Signaling State Changed', `state=${peerConnection.signalingState}`);
      });
      peerConnection.addEventListener('track', (event) => {
        const audioElement = audioRef.current;
        if (audioElement) {
          audioElement.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        }
        addLocalLog('Remote Track Received', `kind=${event.track.kind}`);
      });

      const dataChannel = peerConnection.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;
      setDataChannelState(dataChannel.readyState);
      addLocalLog('Data Channel Created', `label=${dataChannel.label}`);

      dataChannel.addEventListener('open', () => {
        setDataChannelState(dataChannel.readyState);
        addLocalLog('Data Channel Opened', `label=${dataChannel.label}`);
      });
      dataChannel.addEventListener('close', () => {
        setDataChannelState(dataChannel.readyState);
        addLocalLog('Data Channel Closed', `label=${dataChannel.label}`);
      });
      dataChannel.addEventListener('error', () => {
        setDataChannelState(dataChannel.readyState);
        addLocalLog('Data Channel Error', `state=${dataChannel.readyState}`);
      });
      dataChannel.addEventListener('message', (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as unknown;
          addLocalLog('Realtime Client Event', summarizeRealtimeEvent(payload));

          if (
            payload &&
            typeof payload === 'object' &&
            (payload as { type?: string }).type === 'error'
          ) {
            setIsCommittingTurn(false);
            committedLineNumberRef.current = null;
            lastOpenedTurnKeyRef.current = null;
            setIsTurnReady(false);
          }
        } catch {
          addLocalLog(
            'Realtime Client Event',
            `non-json payload (${String(event.data).length} chars)`,
          );
        }
      });

      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
        addLocalLog('Local Track Added', `kind=${track.kind} | id=${track.id}`);
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      addLocalLog('Local Offer Created', `sdpLength=${offer.sdp?.length ?? 0}`);

      const iceGatheringOutcome = await waitForIceGatheringComplete(
        peerConnection,
        ICE_GATHERING_TIMEOUT_MS,
      );
      addLocalLog('ICE Gathering Wait Finished', `outcome=${iceGatheringOutcome}`);

      const response = await fetch(`${normalizedBackendUrl}/api/realtime-webrtc/live-memorization/calls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          correctionMode: 'reveal-and-retry',
          maxAttemptsPerLine: 5,
          offerSdp: peerConnection.localDescription?.sdp ?? offer.sdp ?? '',
          script,
          selectedCharacter,
          startLineNumber: clampedStartLineNumber,
          turnCommitMode: 'manual',
          voice: DEFAULT_VOICE,
        }),
      });

      if (!response.ok) {
        throw new Error(await readResponseErrorMessage(response));
      }

      const payload = (await response.json()) as RealtimeCallResponse;
      activeBackendBaseUrlRef.current = normalizedBackendUrl;
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      setCallId(payload.callId);
      setLastSessionId(payload.sessionId);
      setLastCallId(payload.callId);
      addLocalLog(
        'Tap Rehearsal Call Created',
        `session=${payload.sessionId} | call=${payload.callId ?? 'none'} | model=${payload.model} | mode=${payload.mode ?? 'default'}`,
      );

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: payload.answerSdp,
      });
      addLocalLog('Remote Answer Applied', `sdpLength=${payload.answerSdp.length}`);

      startPolling();
      setStatus('connected');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown tap-rehearsal error';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Tap Rehearsal Failed', message);
      await cleanupActiveSession({ notifyBackend: true });
      toast({
        title: 'Tap rehearsal failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      isStartingSessionRef.current = false;
    }
  }, [
    addLocalLog,
    cleanupActiveSession,
    clampedStartLineNumber,
    normalizedBackendUrl,
    script,
    selectedCharacter,
    startPolling,
    syncPeerConnectionSnapshot,
    toast,
  ]);

  const handleStopSession = useCallback(async () => {
    if (!peerConnectionRef.current && !sessionIdRef.current) {
      setStatus('stopped');
      return;
    }

    setStatus('stopping');
    setErrorMessage(null);
    addLocalLog('Session Stop Requested');
    await cleanupActiveSession({ notifyBackend: true });
    setStatus('stopped');
    addLocalLog('Session Stopped');
  }, [addLocalLog, cleanupActiveSession]);

  const handleDownloadReport = useCallback(() => {
    const report = buildTapRehearsalReport({
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
      callId: reportCallId,
      connectionState,
      correction,
      currentLine,
      dataChannelState,
      exportedAt: new Date().toISOString(),
      iceConnectionState,
      iceGatheringState,
      isControlStatePending,
      isCommittingTurn,
      isWaitingForCoachCue,
      isTurnReady,
      localLogs,
      selectedCharacter: selectedCharacter ?? 'not selected',
      serverLogs,
      sessionId: reportSessionId,
      signalingState,
      startLineNumber: clampedStartLineNumber,
      status,
    });

    downloadFile(`tap-rehearsal-${APP_VERSION}.txt`, report, 'text/plain;charset=utf-8');
    addLocalLog('Tap Rehearsal Report Downloaded');
  }, [
    addLocalLog,
    backendUrlInput,
    clampedStartLineNumber,
    connectionState,
    correction,
    currentLine,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    isControlStatePending,
    isCommittingTurn,
    isWaitingForCoachCue,
    isTurnReady,
    reportCallId,
    reportSessionId,
    localLogs,
    normalizedBackendUrl,
    selectedCharacter,
    serverLogs,
    signalingState,
    status,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const normalizedValue = normalizeRealtimeCallLabBackendUrl(backendUrlInput);
    if (normalizedValue) {
      localStorage.setItem(REALTIME_CALL_LAB_BACKEND_STORAGE_KEY, normalizedValue);
      return;
    }

    if (!backendUrlInput.trim()) {
      localStorage.removeItem(REALTIME_CALL_LAB_BACKEND_STORAGE_KEY);
    }
  }, [backendUrlInput]);

  useEffect(() => {
    persistPreferredCharacter(selectedCharacter);
  }, [selectedCharacter]);

  useEffect(() => {
    if (!script) {
      return;
    }

    const availableCharacters = Array.from(new Set(script.lines.map((line) => line.character)));
    if (
      availableCharacters.length > 0 &&
      (!selectedCharacter || !availableCharacters.includes(selectedCharacter))
    ) {
      setSelectedCharacter(availableCharacters[0]);
    }

    setStartLineNumber((currentLineNumber) =>
      clampLiveMemorizationStartLine(currentLineNumber, script.lines.length),
    );
  }, [script, selectedCharacter]);

  useEffect(() => {
    async function loadScript() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}script.json`);
        if (!response.ok) {
          throw new Error('Failed to load script');
        }

        const rawData = (await response.json()) as RawScript;
        setScript(normalizeScript(rawData));
        addLocalLog('Script Loaded', 'Loaded script.json successfully');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load script';
        setLoadError(message);
        addLocalLog('Script Load Error', message);
      }
    }

    void loadScript();
  }, [addLocalLog]);

  useEffect(() => {
    openCurrentUserTurn();
  }, [openCurrentUserTurn]);

  useEffect(() => {
    return () => {
      void cleanupActiveSession({ notifyBackend: true });
    };
  }, [cleanupActiveSession]);

  const sessionLabel = useMemo(() => {
    if (isControlStatePending) {
      return 'Preparing';
    }

    if (!currentLine) {
      return status === 'connected' ? 'Complete' : 'Not started';
    }

    if (coachAudioPlaying || speechQueueLength > 0) {
      return 'Listen';
    }

    if (isWaitingForCoachCue) {
      return 'Preparing';
    }

    if (!currentLine.isUserLine) {
      return 'Advancing';
    }

    if (isCommittingTurn) {
      return 'Checking';
    }

    return isTurnReady ? 'Your turn' : 'Preparing';
  }, [
    coachAudioPlaying,
    currentLine,
    isControlStatePending,
    isCommittingTurn,
    isTurnReady,
    isWaitingForCoachCue,
    speechQueueLength,
    status,
  ]);

  return (
    <div data-testid="tap-rehearsal-page" className="min-h-screen bg-background text-foreground">
      <audio ref={audioRef} playsInline className="hidden" />

      <header className="border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Theater className="h-6 w-6 text-primary" />
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Tap Rehearsal
              </p>
              <h1 className="text-xl font-semibold tracking-tight">Stage Mode Prototype</h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={buildAppRouteHref('rehearsal')}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </a>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6">
        {loadError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Script load failed</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Session issue</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        )}

        {status !== 'connected' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_0.75fr]">
            <Card>
              <CardHeader>
                <CardTitle>Setup</CardTitle>
                <CardDescription>
                  The script text stays hidden once the session starts.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="tap-rehearsal-backend-url">Backend URL</Label>
                  <Input
                    id="tap-rehearsal-backend-url"
                    data-testid="input-tap-rehearsal-backend-url"
                    placeholder={DEFAULT_BACKEND_PLACEHOLDER}
                    value={backendUrlInput}
                    onChange={(event) => setBackendUrlInput(event.target.value)}
                  />
                </div>

                <CharacterSelector
                  characters={characters}
                  selectedCharacter={selectedCharacter}
                  onSelect={setSelectedCharacter}
                />

                <div className="space-y-2">
                  <Label htmlFor="tap-rehearsal-start-line">Start Line</Label>
                  <Input
                    id="tap-rehearsal-start-line"
                    data-testid="input-tap-rehearsal-start-line"
                    type="number"
                    min={1}
                    max={script?.lines.length ?? 1}
                    value={clampedStartLineNumber}
                    onChange={(event) =>
                      setStartLineNumber(Number.parseInt(event.target.value, 10) || 1)
                    }
                  />
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <Button
                    data-testid="button-tap-rehearsal-check-backend"
                    type="button"
                    variant="outline"
                    onClick={() => {
                      void checkBackendHealth();
                    }}
                  >
                    <Server className="mr-2 h-4 w-4" />
                    Check Backend
                  </Button>
                  <Button
                    data-testid="button-tap-rehearsal-start"
                    type="button"
                    disabled={!canStartSession || isBusyStarting}
                    onClick={() => {
                      void handleStartSession();
                    }}
                  >
                    {isBusyStarting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Mic className="mr-2 h-4 w-4" />
                    )}
                    Start
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Backend</CardTitle>
                <CardDescription>Realtime session health and connection state.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={getStatusVariant(status)}>{status}</Badge>
                  <Badge variant={dataChannelState === 'open' ? 'default' : 'outline'}>
                    data {dataChannelState}
                  </Badge>
                </div>

                <div className="rounded-lg border p-3 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <Wifi className="h-4 w-4 text-primary" />
                    Health
                  </div>
                  <p className="mt-2">
                    {backendHealth
                      ? `ok=${backendHealth.ok ? 'yes' : 'no'} | openai=${
                          backendHealth.openAiConfigured ? 'yes' : 'no'
                        } | uptime=${backendHealth.uptimeSeconds}s`
                      : 'Not checked yet'}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <section className="flex min-h-[calc(100dvh-8rem)] flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="default">{sessionLabel}</Badge>
                <Badge variant="outline">
                  {currentLine ? `Line ${currentLine.lineNumber}` : 'Done'}
                </Badge>
                <Badge variant={coachAudioPlaying ? 'secondary' : 'outline'}>
                  coach {coachAudioPlaying ? 'speaking' : 'silent'}
                </Badge>
                <Badge variant={isWaitingForCoachCue ? 'secondary' : 'outline'}>
                  cue {isWaitingForCoachCue ? 'pending' : 'ready'}
                </Badge>
              </div>

              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleDownloadReport}>
                  <Download className="mr-2 h-4 w-4" />
                  Report
                </Button>
                <Button
                  data-testid="button-tap-rehearsal-stop"
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void handleStopSession();
                  }}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center">
              {correction && (
                <div
                  data-testid="tap-rehearsal-correction"
                  className="w-full max-w-2xl rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-left"
                >
                  <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
                    Correction
                  </p>
                  <p className="mt-2 text-2xl font-semibold leading-snug">
                    {correction.expectedText}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Heard: {correction.spokenText || 'no transcript'}
                  </p>
                </div>
              )}

              <button
                data-testid="button-tap-rehearsal-line-done"
                type="button"
                disabled={isLineDoneDisabled}
                onClick={handleLineDone}
                className="flex aspect-square w-[min(78vw,22rem)] items-center justify-center rounded-full border-4 border-primary bg-primary text-primary-foreground shadow-lg transition active:scale-[0.98] disabled:cursor-not-allowed disabled:border-muted disabled:bg-muted disabled:text-muted-foreground"
              >
                <span className="flex flex-col items-center gap-3">
                  {isCommittingTurn ? (
                    <Loader2 className="h-16 w-16 animate-spin" />
                  ) : (
                    <Check className="h-16 w-16" />
                  )}
                  <span className="text-2xl font-semibold">
                    {isCommittingTurn ? 'Checking' : isTurnReady ? 'Line Done' : sessionLabel}
                  </span>
                </span>
              </button>

              {correction && (
                <Button
                  data-testid="button-tap-rehearsal-skip"
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => {
                    void sendControlCommand('skip');
                  }}
                >
                  <SkipForward className="mr-2 h-5 w-5" />
                  Skip Line
                </Button>
              )}
            </div>
          </section>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Debug</CardTitle>
            <CardDescription>Backend and browser events for this prototype.</CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-60 rounded-lg border bg-muted/20 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {buildTapRehearsalReport({
                  backendBaseUrl:
                    activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
                  callId: reportCallId,
                  connectionState,
                  correction,
                  currentLine,
                  dataChannelState,
                  exportedAt: new Date().toISOString(),
                  iceConnectionState,
                  iceGatheringState,
                  isControlStatePending,
                  isCommittingTurn,
                  isWaitingForCoachCue,
                  isTurnReady,
                  localLogs,
                  selectedCharacter: selectedCharacter ?? 'not selected',
                  serverLogs,
                  sessionId: reportSessionId,
                  signalingState,
                  startLineNumber: clampedStartLineNumber,
                  status,
                })}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
