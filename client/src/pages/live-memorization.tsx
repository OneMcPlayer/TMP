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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useRealtimeClientLogSync } from '@/hooks/use-realtime-client-log-sync';
import { buildAppRouteHref } from '@/lib/app-route';
import {
  buildLiveMemorizationPreviewLines,
  clampLiveMemorizationAttempts,
  clampLiveMemorizationStartLine,
  serializeLiveMemorizationReport,
  type LiveMemorizationReport,
  type LiveMemorizationOptions,
} from '@/lib/live-memorization';
import { normalizeScript } from '@/lib/script-utils';
import { APP_VERSION } from '@/lib/version';
import {
  appendDebugLogEntry,
  createDebugLogEntry,
  type DebugLogEntry,
} from '@/lib/debug-log';
import {
  playAudioBlob,
  primeAudioPlayback,
} from '@/lib/openai';
import {
  consumeQueuedPwaDebugLogs,
  capturePwaRuntimeDiagnostics,
  requestServiceWorkerDebugSnapshot,
  subscribeToPwaDebugLogs,
} from '@/lib/pwa-debug';
import {
  getRealtimeResponseLifecycleUpdate,
  normalizeRealtimeCallLabBackendUrl,
  summarizeRealtimeEvent,
  REALTIME_CALL_LAB_BACKEND_STORAGE_KEY,
  type RealtimeServerLogEntry,
} from '@/lib/realtime-call-lab';
import type { RawScript, Script } from '@/lib/types';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  AudioLines,
  Copy,
  Download,
  Loader2,
  Mic,
  Radio,
  RefreshCw,
  Server,
  SkipForward,
  Sparkles,
  Wifi,
} from 'lucide-react';

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
  model: string;
  mode?: string;
  sessionId: string;
  voice: string;
}

interface LiveMemorizationSpeechEvent {
  seq: number;
  timestamp: string;
  purpose: string;
  text: string;
}

const DEFAULT_BACKEND_PLACEHOLDER = 'https://your-codespace-8787.your-forwarding-domain';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_VOICE = 'alloy';
const BACKEND_LOG_POLL_INTERVAL_MS = 1500;
const LIVE_MEMORIZATION_STATE_POLL_INTERVAL_MS = 350;
const ICE_GATHERING_TIMEOUT_MS = 1500;
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

function downloadFile(filename: string, contents: string | Blob, type?: string): void {
  const blob = contents instanceof Blob ? contents : new Blob([contents], { type });
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
    // Non-JSON responses are returned as raw text.
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

export default function LiveMemorizationPage() {
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
  const [maxAttemptsPerLine, setMaxAttemptsPerLine] = useState(DEFAULT_MAX_ATTEMPTS);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | 'closed'>('closed');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'closed'>(
    'closed',
  );
  const [iceGatheringState, setIceGatheringState] = useState<RTCIceGatheringState>('new');
  const [signalingState, setSignalingState] = useState<RTCSignalingState | 'closed'>('closed');
  const [dataChannelState, setDataChannelState] = useState<RTCDataChannelState | 'closed'>(
    'closed',
  );
  const [remoteAudioAttached, setRemoteAudioAttached] = useState(false);
  const [remoteAudioPlaying, setRemoteAudioPlaying] = useState(false);
  const [coachAudioPlaying, setCoachAudioPlaying] = useState(false);
  const [activeResponseId, setActiveResponseId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [localLogs, setLocalLogs] = useState<DebugLogEntry[]>([]);
  const [serverLogs, setServerLogs] = useState<RealtimeServerLogEntry[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const activeBackendBaseUrlRef = useRef<string | null>(null);
  const lastServerSeqRef = useRef(0);
  const lastSpeechSeqRef = useRef(0);
  const serverLogPollIntervalRef = useRef<number | null>(null);
  const liveMemorizationStatePollIntervalRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastBackendPollErrorRef = useRef<string | null>(null);
  const isStartingSessionRef = useRef(false);
  const activeResponseIdRef = useRef<string | null>(null);
  const speechQueueRef = useRef<LiveMemorizationSpeechEvent[]>([]);
  const speechAudioCacheRef = useRef<Map<number, Blob>>(new Map());
  const speechAudioFetchRef = useRef<Map<number, Promise<Blob>>>(new Map());
  const currentSpeechRef = useRef<LiveMemorizationSpeechEvent | null>(null);
  const currentSpeechAbortControllerRef = useRef<AbortController | null>(null);
  const isDrainingSpeechQueueRef = useRef(false);

  const normalizedBackendUrl = useMemo(
    () => normalizeRealtimeCallLabBackendUrl(backendUrlInput),
    [backendUrlInput],
  );

  useRealtimeClientLogSync({
    backendBaseUrl: activeBackendBaseUrlRef.current,
    entries: localLogs,
    sessionId,
    source: 'live-memorization',
  });

  const characters = useMemo(
    () => (script ? Array.from(new Set(script.lines.map((line) => line.character))) : []),
    [script],
  );
  const clampedStartLineNumber = useMemo(
    () => clampLiveMemorizationStartLine(startLineNumber, script?.lines.length ?? 0),
    [script?.lines.length, startLineNumber],
  );
  const clampedMaxAttemptsPerLine = useMemo(
    () => clampLiveMemorizationAttempts(maxAttemptsPerLine),
    [maxAttemptsPerLine],
  );
  const memorizationOptions = useMemo<LiveMemorizationOptions | null>(() => {
    if (!script || !selectedCharacter) {
      return null;
    }

    return {
      maxAttemptsPerLine: clampedMaxAttemptsPerLine,
      script,
      selectedCharacter,
      startLineNumber: clampedStartLineNumber,
    };
  }, [clampedMaxAttemptsPerLine, clampedStartLineNumber, script, selectedCharacter]);
  const previewLines = useMemo(
    () => (memorizationOptions ? buildLiveMemorizationPreviewLines(memorizationOptions, 14) : []),
    [memorizationOptions],
  );
  const deterministicPlanSummary = useMemo(() => {
    if (!memorizationOptions) {
      return '';
    }

    return [
      `Character under rehearsal: ${memorizationOptions.selectedCharacter}`,
      `Starting line: ${memorizationOptions.startLineNumber}`,
      `Max attempts before reveal: ${memorizationOptions.maxAttemptsPerLine}`,
      '',
      'Backend-owned loop:',
      '- Server VAD commits each spoken turn without creating an automatic model reply.',
      '- Backend transcription is checked against the next expected line deterministically.',
      '- Partner cues, retries, reveals, and continue prompts are emitted server-side as exact speech events.',
      '- Exact spoken output is rendered through backend TTS, not by asking the realtime model to improvise.',
    ].join('\n');
  }, [memorizationOptions]);
  const canStartSession = Boolean(memorizationOptions && normalizedBackendUrl);

  const addLocalLog = useCallback((event: string, details?: string) => {
    setLocalLogs((entries) => appendDebugLogEntry(entries, createDebugLogEntry(event, details)));
  }, []);

  useEffect(() => {
    activeResponseIdRef.current = activeResponseId;
  }, [activeResponseId]);

  const syncPeerConnectionSnapshot = useCallback((peerConnection: RTCPeerConnection | null) => {
    setConnectionState(peerConnection?.connectionState ?? 'closed');
    setIceConnectionState(peerConnection?.iceConnectionState ?? 'closed');
    setIceGatheringState(peerConnection?.iceGatheringState ?? 'new');
    setSignalingState(peerConnection?.signalingState ?? 'closed');
  }, []);

  const clearServerLogPolling = useCallback(() => {
    if (serverLogPollIntervalRef.current !== null) {
      window.clearInterval(serverLogPollIntervalRef.current);
      serverLogPollIntervalRef.current = null;
    }

    if (liveMemorizationStatePollIntervalRef.current !== null) {
      window.clearInterval(liveMemorizationStatePollIntervalRef.current);
      liveMemorizationStatePollIntervalRef.current = null;
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

  const fetchSpeechAudio = useCallback(
    async (speechEvent: LiveMemorizationSpeechEvent): Promise<Blob> => {
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
        throw new Error('Live memorization session is not ready for backend speech audio.');
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
    },
    [],
  );

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
        if (!speechEvent) {
          continue;
        }

        const abortController = new AbortController();
        currentSpeechRef.current = speechEvent;
        currentSpeechAbortControllerRef.current = abortController;
        setCoachAudioPlaying(true);
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

      for (const speechEvent of freshSpeechEvents) {
        addLocalLog(
          'Backend Speech Received',
          `seq=${speechEvent.seq} | purpose=${speechEvent.purpose} | text=${speechEvent.text}`,
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

      if (payload.status === 'error' && status === 'connected') {
        setStatus('error');
        setErrorMessage(
          'The backend session reported an error. Export the memorization report for details.',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend polling error';

      if (lastBackendPollErrorRef.current === message) {
        return;
      }

      lastBackendPollErrorRef.current = message;
      addLocalLog('Backend Log Poll Failed', message);
    }
  }, [addLocalLog, appendServerLogs, status]);

  const fetchLiveMemorizationState = useCallback(async () => {
    const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
    const activeSessionId = sessionIdRef.current;

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

      const payload = (await response.json()) as {
        callId?: string | null;
        speech?: LiveMemorizationSpeechEvent[];
        status?: string;
      };

      lastBackendPollErrorRef.current = null;
      if (typeof payload.callId === 'string') {
        setCallId(payload.callId);
      }

      appendSpeechEvents(payload.speech ?? []);

      if (payload.status === 'error' && status === 'connected') {
        setStatus('error');
        setErrorMessage(
          'The backend session reported an error. Export the memorization report for details.',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend state polling error';

      if (lastBackendPollErrorRef.current === message) {
        return;
      }

      lastBackendPollErrorRef.current = message;
      addLocalLog('Backend State Poll Failed', message);
    }
  }, [addLocalLog, appendSpeechEvents, status]);

  const startServerLogPolling = useCallback(() => {
    clearServerLogPolling();
    void fetchServerLogs();
    void fetchLiveMemorizationState();
    serverLogPollIntervalRef.current = window.setInterval(() => {
      void fetchServerLogs();
    }, BACKEND_LOG_POLL_INTERVAL_MS);
    liveMemorizationStatePollIntervalRef.current = window.setInterval(() => {
      void fetchLiveMemorizationState();
    }, LIVE_MEMORIZATION_STATE_POLL_INTERVAL_MS);
  }, [clearServerLogPolling, fetchLiveMemorizationState, fetchServerLogs]);

  const cleanupActiveSession = useCallback(
    async (options?: { notifyBackend?: boolean }) => {
      clearServerLogPolling();
      interruptCoachAudioPlayback('session-cleanup');
      speechQueueRef.current = [];
      speechAudioCacheRef.current.clear();
      speechAudioFetchRef.current.clear();
      lastSpeechSeqRef.current = 0;

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
        // Closing an already-gone data channel is safe to ignore.
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
          // Sender access varies while a peer connection is shutting down.
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

      remoteStreamRef.current = null;

      const audioElement = audioRef.current;
      if (audioElement) {
        try {
          audioElement.pause();
        } catch {
          // Browsers can reject pause if the element is already detached.
        }
        audioElement.srcObject = null;
      }

      setRemoteAudioAttached(false);
      setRemoteAudioPlaying(false);
      setCoachAudioPlaying(false);
      setActiveResponseId(null);

      activeBackendBaseUrlRef.current = null;
      sessionIdRef.current = null;
      currentSpeechRef.current = null;
      setSessionId(null);
      setCallId(null);
    },
    [addLocalLog, clearServerLogPolling, interruptCoachAudioPlayback, syncPeerConnectionSnapshot],
  );

  const checkBackendHealth = useCallback(async () => {
    if (!normalizedBackendUrl) {
      const message = 'Enter a valid HTTP(S) backend URL before checking health.';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Backend Health Check Failed', message);
      toast({
        title: 'Backend URL needed',
        description: message,
        variant: 'destructive',
      });
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
      addLocalLog(
        'Backend Health Check Succeeded',
        `ok=${snapshot.ok ? 'yes' : 'no'} | openai=${
          snapshot.openAiConfigured ? 'yes' : 'no'
        } | uptime=${snapshot.uptimeSeconds}s`,
      );
      setStatus((currentStatus) =>
        currentStatus === 'checking-backend' ? 'idle' : currentStatus,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown backend health error';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Backend Health Check Failed', message);
      toast({
        title: 'Backend check failed',
        description: message,
        variant: 'destructive',
      });
    }
  }, [addLocalLog, normalizedBackendUrl, toast]);

  const sendControlCommand = useCallback(
    async (
      command: 'continue' | 'repeat' | 'reveal',
      buttonLabel: string,
      successDescription: string,
    ) => {
      const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
      const activeSessionId = sessionIdRef.current;

      if (!activeBackendBaseUrl || !activeSessionId) {
        toast({
          title: 'Session not ready',
          description: 'Start the live memorization session first.',
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

        const payload = (await response.json()) as {
          queuedResponses?: number;
        };

        addLocalLog(
          'Control Command Sent',
          `${buttonLabel} | command=${command} | queued=${payload.queuedResponses ?? 0}`,
        );
        toast({
          title: buttonLabel,
          description: activeResponseIdRef.current
            ? `${successDescription} It was queued safely on the backend.`
            : successDescription,
        });
        void fetchServerLogs();
        void fetchLiveMemorizationState();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown control-command error';
        addLocalLog('Control Command Failed', `${buttonLabel} | ${message}`);
        toast({
          title: `${buttonLabel} failed`,
          description: message,
          variant: 'destructive',
        });
      }
    },
    [addLocalLog, fetchLiveMemorizationState, fetchServerLogs, toast],
  );

  const handleStartSession = useCallback(async () => {
    if (isStartingSessionRef.current) {
      return;
    }

    if (!normalizedBackendUrl || !memorizationOptions) {
      const message = 'Choose your character and backend before starting live memorization.';
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
    setRemoteAudioAttached(false);
    setRemoteAudioPlaying(false);
    setCoachAudioPlaying(false);
    setServerLogs([]);
    lastServerSeqRef.current = 0;
    lastSpeechSeqRef.current = 0;
    lastBackendPollErrorRef.current = null;
    addLocalLog(
      'Memorization Session Start Requested',
      `backend=${normalizedBackendUrl} | line=${memorizationOptions.startLineNumber} | attempts=${memorizationOptions.maxAttemptsPerLine}`,
    );

    try {
      await cleanupActiveSession({ notifyBackend: true });
      await capturePwaRuntimeDiagnostics(APP_VERSION, 'Live Memorization Start Snapshot', true);
      await requestServiceWorkerDebugSnapshot();
      await primeAudioPlayback();
      addLocalLog('Coach Audio Ready', 'Local playback primed for exact backend speech');

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
      peerConnection.addEventListener('icecandidate', (event) => {
        if (!event.candidate) {
          addLocalLog('ICE Candidate Complete');
          return;
        }

        addLocalLog(
          'ICE Candidate Gathered',
          `mid=${event.candidate.sdpMid ?? 'none'} | type=${event.candidate.type ?? 'unknown'}`,
        );
      });
      peerConnection.addEventListener('track', (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        remoteStreamRef.current = remoteStream;
        setRemoteAudioAttached(true);
        addLocalLog(
          'Remote Track Received',
          `kind=${event.track.kind} | streams=${event.streams.length}`,
        );

        const audioElement = audioRef.current;
        if (audioElement) {
          audioElement.srcObject = remoteStream;
        }
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
            (payload as { type?: string }).type === 'input_audio_buffer.speech_started'
          ) {
            interruptCoachAudioPlayback('microphone-activity');
          }

          const lifecycleUpdate = getRealtimeResponseLifecycleUpdate(payload);
          if (lifecycleUpdate?.state === 'started') {
            setActiveResponseId(lifecycleUpdate.responseId);
          } else if (lifecycleUpdate?.state === 'finished') {
            setActiveResponseId((currentResponseId) => {
              if (!currentResponseId) {
                return null;
              }

              if (!lifecycleUpdate.responseId || lifecycleUpdate.responseId === currentResponseId) {
                return null;
              }

              return currentResponseId;
            });
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
          maxAttemptsPerLine: memorizationOptions.maxAttemptsPerLine,
          offerSdp: peerConnection.localDescription?.sdp ?? offer.sdp ?? '',
          script: memorizationOptions.script,
          selectedCharacter: memorizationOptions.selectedCharacter,
          startLineNumber: memorizationOptions.startLineNumber,
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
      addLocalLog(
        'Live Memorization Call Created',
        `session=${payload.sessionId} | call=${payload.callId ?? 'none'} | model=${payload.model} | mode=${payload.mode ?? 'default'}`,
      );

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: payload.answerSdp,
      });
      addLocalLog('Remote Answer Applied', `sdpLength=${payload.answerSdp.length}`);

      startServerLogPolling();
      setStatus('connected');
      toast({
        title: 'Live memorization connected',
        description: 'The backend now checks lines and plays exact cues through deterministic TTS.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown realtime-session error';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Live Memorization Failed', message);
      await cleanupActiveSession({ notifyBackend: true });
      toast({
        title: 'Live memorization failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      isStartingSessionRef.current = false;
    }
  }, [
    addLocalLog,
    cleanupActiveSession,
    interruptCoachAudioPlayback,
    memorizationOptions,
    normalizedBackendUrl,
    startServerLogPolling,
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
    toast({
      title: 'Live memorization stopped',
      description: 'The browser call and script coach were cleaned up.',
    });
  }, [addLocalLog, cleanupActiveSession, toast]);

  const handleCopyReport = useCallback(async () => {
    const report = serializeLiveMemorizationReport({
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
      selectedCharacter: selectedCharacter ?? 'not selected',
      startLineNumber: clampedStartLineNumber,
      maxAttemptsPerLine: clampedMaxAttemptsPerLine,
      sessionId,
      callId,
      status,
      connectionState,
      iceConnectionState,
      iceGatheringState,
      signalingState,
      dataChannelState,
      remoteAudioAttached,
      remoteAudioPlaying,
      coachAudioPlaying,
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    });

    try {
      await navigator.clipboard.writeText(report);
      addLocalLog('Live Memorization Report Copied');
      toast({
        title: 'Report copied',
        description: 'The full memorization log is now in the clipboard.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown clipboard error';
      addLocalLog('Live Memorization Report Copy Failed', message);
      toast({
        title: 'Copy failed',
        description: message,
        variant: 'destructive',
      });
    }
  }, [
    activeResponseId,
    addLocalLog,
    backendUrlInput,
    callId,
    coachAudioPlaying,
    clampedMaxAttemptsPerLine,
    clampedStartLineNumber,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    remoteAudioAttached,
    remoteAudioPlaying,
    selectedCharacter,
    serverLogs,
    sessionId,
    signalingState,
    status,
    toast,
  ]);

  const handleDownloadTextReport = useCallback(() => {
    const report = serializeLiveMemorizationReport({
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
      selectedCharacter: selectedCharacter ?? 'not selected',
      startLineNumber: clampedStartLineNumber,
      maxAttemptsPerLine: clampedMaxAttemptsPerLine,
      sessionId,
      callId,
      status,
      connectionState,
      iceConnectionState,
      iceGatheringState,
      signalingState,
      dataChannelState,
      remoteAudioAttached,
      remoteAudioPlaying,
      coachAudioPlaying,
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    });

    downloadFile(`live-memorization-${APP_VERSION}.txt`, report, 'text/plain;charset=utf-8');
    addLocalLog('Live Memorization Text Report Downloaded');
  }, [
    activeResponseId,
    addLocalLog,
    backendUrlInput,
    callId,
    coachAudioPlaying,
    clampedMaxAttemptsPerLine,
    clampedStartLineNumber,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    remoteAudioAttached,
    remoteAudioPlaying,
    selectedCharacter,
    serverLogs,
    sessionId,
    signalingState,
    status,
  ]);

  const handleDownloadJsonReport = useCallback(() => {
    const payload: LiveMemorizationReport = {
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
      selectedCharacter: selectedCharacter ?? 'not selected',
      startLineNumber: clampedStartLineNumber,
      maxAttemptsPerLine: clampedMaxAttemptsPerLine,
      sessionId,
      callId,
      status,
      connectionState,
      iceConnectionState,
      iceGatheringState,
      signalingState,
      dataChannelState,
      remoteAudioAttached,
      remoteAudioPlaying,
      coachAudioPlaying,
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    };

    downloadFile(
      `live-memorization-${APP_VERSION}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    addLocalLog('Live Memorization JSON Report Downloaded');
  }, [
    activeResponseId,
    addLocalLog,
    backendUrlInput,
    callId,
    coachAudioPlaying,
    clampedMaxAttemptsPerLine,
    clampedStartLineNumber,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    remoteAudioAttached,
    remoteAudioPlaying,
    selectedCharacter,
    serverLogs,
    sessionId,
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
    const queuedEntries = consumeQueuedPwaDebugLogs();
    if (queuedEntries.length > 0) {
      setLocalLogs((entries) => {
        let nextEntries = entries;
        for (const entry of queuedEntries) {
          nextEntries = appendDebugLogEntry(nextEntries, entry);
        }
        return nextEntries;
      });
    }

    void capturePwaRuntimeDiagnostics(APP_VERSION, 'Live Memorization Opened Snapshot', true);
    void requestServiceWorkerDebugSnapshot();
    addLocalLog('Live Memorization Opened', `version=${APP_VERSION}`);

    const unsubscribe = subscribeToPwaDebugLogs((entry) => {
      setLocalLogs((entries) => appendDebugLogEntry(entries, entry));
    });

    return unsubscribe;
  }, [addLocalLog]);

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    const handleLoadedMetadata = () => {
      addLocalLog('Remote Audio Metadata Loaded');
    };
    const handlePlaying = () => {
      setRemoteAudioPlaying(true);
      addLocalLog('Remote Audio Playing');
    };
    const handlePause = () => {
      setRemoteAudioPlaying(false);
      addLocalLog('Remote Audio Paused');
    };
    const handleEnded = () => {
      setRemoteAudioPlaying(false);
      addLocalLog('Remote Audio Ended');
    };
    const handleError = () => {
      const mediaError = audioElement.error;
      addLocalLog(
        'Remote Audio Element Error',
        mediaError ? `code=${mediaError.code}` : 'Unknown audio-element error',
      );
    };

    audioElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    audioElement.addEventListener('playing', handlePlaying);
    audioElement.addEventListener('pause', handlePause);
    audioElement.addEventListener('ended', handleEnded);
    audioElement.addEventListener('error', handleError);

    return () => {
      audioElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audioElement.removeEventListener('playing', handlePlaying);
      audioElement.removeEventListener('pause', handlePause);
      audioElement.removeEventListener('ended', handleEnded);
      audioElement.removeEventListener('error', handleError);
    };
  }, [addLocalLog]);

  useEffect(() => {
    return () => {
      void cleanupActiveSession({ notifyBackend: true });
    };
  }, [cleanupActiveSession]);

  return (
    <div data-testid="live-memorization-page" className="min-h-screen bg-background text-foreground">
      <audio ref={audioRef} playsInline className="hidden" />

      <header className="border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.25em] text-muted-foreground">
              Live Memorization
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Realtime Script Coach</h1>
            <p className="text-sm text-muted-foreground">
              Hybrid WebRTC plus backend TTS flow for stricter, line-locked memorization.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <a href={buildAppRouteHref('rehearsal')}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back
              </a>
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6">
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

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Scene Setup
              </CardTitle>
              <CardDescription>
                Choose the role, the entry point in the script, and how strict the coach should be.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="live-memorization-backend-url">Backend URL</Label>
                <Input
                  id="live-memorization-backend-url"
                  data-testid="input-live-memorization-backend-url"
                  placeholder={DEFAULT_BACKEND_PLACEHOLDER}
                  value={backendUrlInput}
                  onChange={(event) => setBackendUrlInput(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This reuses the backend-assisted realtime path that is already working in the PWA.
                </p>
              </div>

              <CharacterSelector
                characters={characters}
                selectedCharacter={selectedCharacter}
                onSelect={setSelectedCharacter}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="live-memorization-start-line">Start Line</Label>
                  <Input
                    id="live-memorization-start-line"
                    data-testid="input-live-memorization-start-line"
                    type="number"
                    min={1}
                    max={script?.lines.length ?? 1}
                    value={clampedStartLineNumber}
                    onChange={(event) =>
                      setStartLineNumber(Number.parseInt(event.target.value, 10) || 1)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="live-memorization-attempts">Max Attempts Per Line</Label>
                  <Input
                    id="live-memorization-attempts"
                    data-testid="input-live-memorization-attempts"
                    type="number"
                    min={1}
                    max={5}
                    value={clampedMaxAttemptsPerLine}
                    onChange={(event) =>
                      setMaxAttemptsPerLine(Number.parseInt(event.target.value, 10) || DEFAULT_MAX_ATTEMPTS)
                    }
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Voice commands the backend should understand</p>
                <p className="mt-2">
                  Say <span className="font-medium text-foreground">repeat</span> to hear the cue
                  again, <span className="font-medium text-foreground">skip</span> to move on, or{' '}
                  <span className="font-medium text-foreground">line please</span> if you want the
                  answer revealed once.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Session State
              </CardTitle>
              <CardDescription>
                Start the realtime coach, then let the backend queue and arbitrate every scripted
                step.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant={getStatusVariant(status)}>{status}</Badge>
                <Badge variant={coachAudioPlaying ? 'default' : 'outline'}>
                  coach audio {coachAudioPlaying ? 'playing' : 'idle'}
                </Badge>
                <Badge variant={remoteAudioAttached ? 'secondary' : 'outline'}>
                  rtc stream {remoteAudioAttached ? 'attached' : 'idle'}
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Wifi className="h-4 w-4 text-primary" />
                    Backend
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {backendHealth
                      ? `ok=${backendHealth.ok ? 'yes' : 'no'} | openai=${
                          backendHealth.openAiConfigured ? 'yes' : 'no'
                        } | uptime=${backendHealth.uptimeSeconds}s`
                      : 'Not checked yet'}
                  </p>
                </div>
                <div className="rounded-2xl border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Radio className="h-4 w-4 text-primary" />
                    Call
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {sessionId ? `session=${sessionId}` : 'No active session'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {callId ? `call=${callId}` : 'Call ID not assigned yet'}
                  </p>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  data-testid="button-live-memorization-check-backend"
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
                  data-testid="button-live-memorization-start"
                  type="button"
                  onClick={() => {
                    void handleStartSession();
                  }}
                  disabled={!canStartSession || status === 'requesting-mic' || status === 'negotiating'}
                >
                  {status === 'requesting-mic' || status === 'negotiating' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Mic className="mr-2 h-4 w-4" />
                  )}
                  Start Session
                </Button>
                <Button
                  data-testid="button-live-memorization-stop"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void handleStopSession();
                  }}
                  disabled={!sessionId && status !== 'connected'}
                >
                  <AudioLines className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <Button
                  data-testid="button-live-memorization-repeat"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void sendControlCommand(
                      'repeat',
                      'Repeat cue',
                      'The coach was asked to repeat the current scripted cue.',
                    )
                  }
                  disabled={status !== 'connected'}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Repeat Cue
                </Button>
                <Button
                  data-testid="button-live-memorization-reveal"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void sendControlCommand(
                      'reveal',
                      'Reveal next line',
                      'The coach was asked to reveal the next expected user line once.',
                    )
                  }
                  disabled={status !== 'connected'}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  Reveal Line
                </Button>
                <Button
                  data-testid="button-live-memorization-continue"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void sendControlCommand(
                      'continue',
                      'Continue',
                      'The coach was asked to continue from the current place in the scene.',
                    )
                  }
                  disabled={status !== 'connected'}
                >
                  <SkipForward className="mr-2 h-4 w-4" />
                  Continue
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>Backend Guardrails</CardTitle>
              <CardDescription>
                This run is now backend-controlled: the script cursor, retries, reveals, and
                continue logic all live on the server side.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="live-memorization-guardrails">Deterministic Session Plan</Label>
                <Textarea
                  id="live-memorization-guardrails"
                  value={deterministicPlanSummary}
                  readOnly
                  className="min-h-[220px] font-mono text-xs"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Starting Window</CardTitle>
              <CardDescription>
                First lines from the chosen start point, with the model’s role marked explicitly.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[470px] pr-4">
                <div className="space-y-3">
                  {previewLines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Load the script and choose a character to preview the live memorization plan.
                    </p>
                  ) : (
                    previewLines.map((line) => {
                      const isUserLine = line.includes('[USER]');
                      return (
                        <div
                          key={line}
                          className={`rounded-2xl border p-3 text-sm ${
                            isUserLine
                              ? 'border-primary/40 bg-primary/5'
                              : 'border-border/60 bg-muted/20'
                          }`}
                        >
                          {line}
                        </div>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Debug And Export</CardTitle>
            <CardDescription>
              Keep the logs detailed so we can understand where the coaching loop works and where it
              still drifts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="live-memorization-notes">Tester Notes</Label>
              <Textarea
                id="live-memorization-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What felt good? Did the model stay on script? Did the corrections help?"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void handleCopyReport()}>
                <Copy className="mr-2 h-4 w-4" />
                Copy Report
              </Button>
              <Button type="button" variant="outline" onClick={handleDownloadTextReport}>
                <Download className="mr-2 h-4 w-4" />
                Download Text
              </Button>
              <Button type="button" variant="outline" onClick={handleDownloadJsonReport}>
                <Download className="mr-2 h-4 w-4" />
                Download JSON
              </Button>
            </div>

            <ScrollArea className="h-[360px] rounded-2xl border bg-muted/20 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {serializeLiveMemorizationReport({
                  version: APP_VERSION,
                  exportedAt: new Date().toISOString(),
                  backendBaseUrl:
                    activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
                  selectedCharacter: selectedCharacter ?? 'not selected',
                  startLineNumber: clampedStartLineNumber,
                  maxAttemptsPerLine: clampedMaxAttemptsPerLine,
                  sessionId,
                  callId,
                  status,
                  connectionState,
                  iceConnectionState,
                  iceGatheringState,
                  signalingState,
                  dataChannelState,
                  remoteAudioAttached,
                  remoteAudioPlaying,
                  coachAudioPlaying,
                  activeResponseId,
                  notes,
                  localLogs,
                  serverLogs,
                })}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
