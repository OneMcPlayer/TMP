import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useRealtimeClientLogSync } from '@/hooks/use-realtime-client-log-sync';
import { buildAppRouteHref } from '@/lib/app-route';
import { APP_VERSION } from '@/lib/version';
import {
  appendDebugLogEntry,
  createDebugLogEntry,
  serializeDebugLogEntries,
  type DebugLogEntry,
} from '@/lib/debug-log';
import {
  capturePwaRuntimeDiagnostics,
  consumeQueuedPwaDebugLogs,
  requestServiceWorkerDebugSnapshot,
  subscribeToPwaDebugLogs,
} from '@/lib/pwa-debug';
import {
  REALTIME_CALL_LAB_BACKEND_STORAGE_KEY,
  getRealtimeResponseLifecycleUpdate,
  normalizeRealtimeCallLabBackendUrl,
  serializeRealtimeCallLabReport,
  summarizeRealtimeEvent,
  type RealtimeCallLabReport,
  type RealtimeServerLogEntry,
} from '@/lib/realtime-call-lab';
import {
  Activity,
  ArrowLeft,
  AudioLines,
  Copy,
  Download,
  Mic,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Send,
  Server,
  Wifi,
} from 'lucide-react';

type LabStatus =
  | 'idle'
  | 'checking-backend'
  | 'requesting-mic'
  | 'negotiating'
  | 'connected'
  | 'stopping'
  | 'stopped'
  | 'error';

type TurnDetectionMode = 'disabled' | 'server_vad';

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
  sessionId: string;
  voice: string;
}

const DEFAULT_BACKEND_PLACEHOLDER = 'https://your-codespace-8787.your-forwarding-domain';
const DEFAULT_INSTRUCTIONS =
  'You are a concise voice rehearsal assistant. Keep replies short, natural, and easy to hear while driving.';
const DEFAULT_GREETING_PROMPT =
  'Say a short hello and confirm that the realtime browser call is connected.';
const DEFAULT_RESPONSE_PROMPT =
  'Say one short line confirming that the audio pipeline is still alive.';
const DEFAULT_VOICE = 'alloy';
const ICE_GATHERING_TIMEOUT_MS = 1500;
const BACKEND_LOG_POLL_INTERVAL_MS = 1500;

function getStatusVariant(status: LabStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
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
    // Some responses are plain-text SDP or non-JSON server errors.
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

export default function RealtimeCallLabPage() {
  const { toast } = useToast();
  const [backendUrlInput, setBackendUrlInput] = useState(() => {
    if (typeof window === 'undefined') {
      return '';
    }

    return localStorage.getItem(REALTIME_CALL_LAB_BACKEND_STORAGE_KEY) ?? '';
  });
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [greetingPrompt, setGreetingPrompt] = useState(DEFAULT_GREETING_PROMPT);
  const [responsePrompt, setResponsePrompt] = useState(DEFAULT_RESPONSE_PROMPT);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [turnDetection, setTurnDetection] = useState<TurnDetectionMode>('server_vad');
  const [status, setStatus] = useState<LabStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState | 'closed'>('closed');
  const [iceConnectionState, setIceConnectionState] = useState<RTCIceConnectionState | 'closed'>('closed');
  const [iceGatheringState, setIceGatheringState] = useState<RTCIceGatheringState>('new');
  const [signalingState, setSignalingState] = useState<RTCSignalingState | 'closed'>('closed');
  const [dataChannelState, setDataChannelState] = useState<RTCDataChannelState | 'closed'>('closed');
  const [remoteAudioAttached, setRemoteAudioAttached] = useState(false);
  const [remoteAudioPlaying, setRemoteAudioPlaying] = useState(false);
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
  const serverLogPollIntervalRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastBackendPollErrorRef = useRef<string | null>(null);
  const isStartingSessionRef = useRef(false);
  const activeResponseIdRef = useRef<string | null>(null);

  const normalizedBackendUrl = useMemo(
    () => normalizeRealtimeCallLabBackendUrl(backendUrlInput),
    [backendUrlInput],
  );

  useRealtimeClientLogSync({
    backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl,
    entries: localLogs,
    sessionId,
    source: 'realtime-call-lab',
  });

  const addLocalLog = useCallback((event: string, details?: string) => {
    setLocalLogs((entries) =>
      appendDebugLogEntry(entries, createDebugLogEntry(event, details)),
    );
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
  }, []);

  const appendServerLogs = useCallback((incomingLogs: RealtimeServerLogEntry[]) => {
    const freshLogs = incomingLogs.filter((entry) => entry.seq > lastServerSeqRef.current);
    if (freshLogs.length === 0) {
      return;
    }

    lastServerSeqRef.current = freshLogs[freshLogs.length - 1].seq;
    setServerLogs((entries) => [...entries, ...freshLogs]);
  }, []);

  const fetchServerLogs = useCallback(async () => {
    const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
    const activeSessionId = sessionIdRef.current;

    if (!activeBackendBaseUrl || !activeSessionId) {
      return;
    }

    try {
      const response = await fetch(
        `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(activeSessionId)}/logs?after=${lastServerSeqRef.current}`,
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
        setErrorMessage('The backend session reported an error. Export the report for details.');
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

  const startServerLogPolling = useCallback(() => {
    clearServerLogPolling();
    void fetchServerLogs();
    serverLogPollIntervalRef.current = window.setInterval(() => {
      void fetchServerLogs();
    }, BACKEND_LOG_POLL_INTERVAL_MS);
  }, [clearServerLogPolling, fetchServerLogs]);

  const cleanupActiveSession = useCallback(
    async (options?: { notifyBackend?: boolean }) => {
      clearServerLogPolling();

      const activeBackendBaseUrl = activeBackendBaseUrlRef.current;
      const activeSessionId = sessionIdRef.current;

      if (options?.notifyBackend && activeBackendBaseUrl && activeSessionId) {
        try {
          const response = await fetch(
            `${activeBackendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(activeSessionId)}/end`,
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
      setActiveResponseId(null);

      activeBackendBaseUrlRef.current = null;
      sessionIdRef.current = null;
      setSessionId(null);
      setCallId(null);
    },
    [addLocalLog, clearServerLogPolling, syncPeerConnectionSnapshot],
  );

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
      title: 'Realtime session stopped',
      description: 'The browser call experiment has been cleaned up.',
    });
  }, [addLocalLog, cleanupActiveSession, toast]);

  const captureManualSnapshot = useCallback(async () => {
    await capturePwaRuntimeDiagnostics(APP_VERSION, 'Realtime Lab Manual Snapshot', true);
    await requestServiceWorkerDebugSnapshot();
    addLocalLog('Realtime Lab Snapshot Requested');
  }, [addLocalLog]);

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
        `ok=${snapshot.ok ? 'yes' : 'no'} | openai=${snapshot.openAiConfigured ? 'yes' : 'no'} | uptime=${snapshot.uptimeSeconds}s`,
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

  const handleSendPrompt = useCallback(() => {
    const dataChannel = dataChannelRef.current;
    const prompt = responsePrompt.trim();

    if (!prompt) {
      toast({
        title: 'Prompt needed',
        description: 'Enter a short manual prompt before sending it to the realtime session.',
        variant: 'destructive',
      });
      return;
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
      toast({
        title: 'Data channel not ready',
        description: 'Start the realtime session and wait for the data channel to open first.',
        variant: 'destructive',
      });
      return;
    }

    if (activeResponseIdRef.current) {
      const message = 'Wait for the current spoken response to finish before sending another prompt.';
      addLocalLog('Realtime Prompt Blocked', `active=${activeResponseIdRef.current} | ${prompt}`);
      toast({
        title: 'Assistant is still speaking',
        description: message,
      });
      return;
    }

    dataChannel.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions: prompt,
        },
      }),
    );

    addLocalLog('Realtime Prompt Sent', prompt);
    toast({
      title: 'Prompt sent',
      description: 'The client data channel asked the model to speak again.',
    });
  }, [addLocalLog, responsePrompt, toast]);

  const handleStartSession = useCallback(async () => {
    if (isStartingSessionRef.current) {
      return;
    }

    if (!normalizedBackendUrl) {
      const message = 'Enter a valid backend URL before starting the realtime test.';
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
    setServerLogs([]);
    lastServerSeqRef.current = 0;
    lastBackendPollErrorRef.current = null;
    addLocalLog(
      'Realtime Session Start Requested',
      `backend=${normalizedBackendUrl} | turnDetection=${turnDetection} | voice=${voice.trim() || DEFAULT_VOICE}`,
    );

    try {
      await cleanupActiveSession({ notifyBackend: true });
      await capturePwaRuntimeDiagnostics(APP_VERSION, 'Realtime Lab Start Snapshot', true);
      await requestServiceWorkerDebugSnapshot();

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
          void audioElement.play().catch((error) => {
            addLocalLog(
              'Remote Audio Play Failed',
              error instanceof Error ? error.message : 'Unknown remote-audio play error',
            );
          });
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

      const response = await fetch(`${normalizedBackendUrl}/api/realtime-webrtc/calls`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          greetingPrompt,
          instructions,
          offerSdp: peerConnection.localDescription?.sdp ?? offer.sdp ?? '',
          turnDetection,
          voice: voice.trim() || DEFAULT_VOICE,
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
        'Realtime Call Created',
        `session=${payload.sessionId} | call=${payload.callId ?? 'none'} | model=${payload.model}`,
      );

      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: payload.answerSdp,
      });
      addLocalLog('Remote Answer Applied', `sdpLength=${payload.answerSdp.length}`);

      startServerLogPolling();
      setStatus('connected');
      toast({
        title: 'Realtime session connected',
        description: 'The browser call experiment is live. Watch the state cards and logs below.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown realtime-session error';
      setStatus('error');
      setErrorMessage(message);
      addLocalLog('Realtime Session Failed', message);
      await cleanupActiveSession({ notifyBackend: true });
      toast({
        title: 'Realtime session failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      isStartingSessionRef.current = false;
    }
  }, [
    addLocalLog,
    cleanupActiveSession,
    greetingPrompt,
    instructions,
    normalizedBackendUrl,
    startServerLogPolling,
    syncPeerConnectionSnapshot,
    toast,
    turnDetection,
    voice,
  ]);

  const handleCopyReport = useCallback(async () => {
    const report = serializeRealtimeCallLabReport({
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
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
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    });

    try {
      await navigator.clipboard.writeText(report);
      addLocalLog('Realtime Lab Report Copied');
      toast({
        title: 'Report copied',
        description: 'The full browser and backend call log is now in the clipboard.',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown clipboard error';
      addLocalLog('Realtime Lab Report Copy Failed', message);
      toast({
        title: 'Copy failed',
        description: message,
        variant: 'destructive',
      });
    }
  }, [
    addLocalLog,
    backendUrlInput,
    callId,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    activeResponseId,
    remoteAudioAttached,
    remoteAudioPlaying,
    serverLogs,
    sessionId,
    signalingState,
    status,
    toast,
  ]);

  const handleDownloadTextReport = useCallback(() => {
    const report = serializeRealtimeCallLabReport({
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
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
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    });

    downloadFile(`realtime-call-lab-${APP_VERSION}.txt`, report, 'text/plain;charset=utf-8');
    addLocalLog('Realtime Lab Text Report Downloaded');
  }, [
    addLocalLog,
    backendUrlInput,
    callId,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    activeResponseId,
    remoteAudioAttached,
    remoteAudioPlaying,
    serverLogs,
    sessionId,
    signalingState,
    status,
  ]);

  const handleDownloadJsonReport = useCallback(() => {
    const payload: RealtimeCallLabReport = {
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      backendBaseUrl: activeBackendBaseUrlRef.current ?? normalizedBackendUrl ?? backendUrlInput.trim(),
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
      activeResponseId,
      notes,
      localLogs,
      serverLogs,
    };

    downloadFile(
      `realtime-call-lab-${APP_VERSION}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    addLocalLog('Realtime Lab JSON Report Downloaded');
  }, [
    addLocalLog,
    backendUrlInput,
    callId,
    connectionState,
    dataChannelState,
    iceConnectionState,
    iceGatheringState,
    localLogs,
    normalizedBackendUrl,
    notes,
    activeResponseId,
    remoteAudioAttached,
    remoteAudioPlaying,
    serverLogs,
    sessionId,
    signalingState,
    status,
  ]);

  const handleClearLogs = useCallback(() => {
    lastServerSeqRef.current = 0;
    setLocalLogs([]);
    setServerLogs([]);
    addLocalLog('Realtime Lab Logs Cleared');
  }, [addLocalLog]);

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

    void capturePwaRuntimeDiagnostics(APP_VERSION, 'Realtime Lab Opened Snapshot', true);
    void requestServiceWorkerDebugSnapshot();
    addLocalLog('Realtime Lab Opened', `version=${APP_VERSION}`);

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
    <div
      data-testid="realtime-call-lab-page"
      className="min-h-screen bg-background text-foreground"
    >
      <header className="border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.35em] text-primary/80">
              Realtime Browser Lab
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              WebRTC Call Spike
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              A side experiment for a real browser call architecture: one tap, live microphone,
              remote audio stream, and backend session logging.
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

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-xl">
              <PhoneCall className="h-5 w-5 text-primary" />
              Why This Experiment Exists
            </CardTitle>
            <CardDescription className="text-base leading-7">
              The PWA path already tested delayed playback, warm microphone streams, and media
              controls. This page changes the shape completely: browser WebRTC to a backend, plus
              a sideband server log, so we can learn whether a true call session behaves more like
              Jitsi or Talk and less like a fragile upload / playback chain.
            </CardDescription>
          </CardHeader>
        </Card>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Server className="h-5 w-5 text-primary" />
                Session Controls
              </CardTitle>
              <CardDescription>
                Point the page at the separate backend, start one realtime call, then export both
                the browser trace and the backend-side session log.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="realtime-backend-url">Backend URL</Label>
                <Input
                  id="realtime-backend-url"
                  data-testid="input-realtime-backend-url"
                  value={backendUrlInput}
                  onChange={(event) => setBackendUrlInput(event.target.value)}
                  placeholder={DEFAULT_BACKEND_PLACEHOLDER}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  Use a forwarded local backend such as a Codespaces public port for
                  `experiments/realtime-webrtc-lab/server.ts`.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="realtime-voice">Voice</Label>
                  <Input
                    id="realtime-voice"
                    value={voice}
                    onChange={(event) => setVoice(event.target.value)}
                    placeholder={DEFAULT_VOICE}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Turn Detection</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant={turnDetection === 'server_vad' ? 'default' : 'outline'}
                      onClick={() => setTurnDetection('server_vad')}
                    >
                      Server VAD
                    </Button>
                    <Button
                      type="button"
                      variant={turnDetection === 'disabled' ? 'default' : 'outline'}
                      onClick={() => setTurnDetection('disabled')}
                    >
                      Disabled
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="realtime-instructions">Session Instructions</Label>
                <Textarea
                  id="realtime-instructions"
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  rows={4}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="realtime-greeting">Startup Greeting Prompt</Label>
                <Textarea
                  id="realtime-greeting"
                  value={greetingPrompt}
                  onChange={(event) => setGreetingPrompt(event.target.value)}
                  rows={3}
                />
                <p className="text-xs text-muted-foreground">
                  This prompt is sent by the backend right after the sideband session opens, so we
                  can test immediate remote speech without another tap.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  data-testid="button-realtime-health"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void checkBackendHealth();
                  }}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Check Backend
                </Button>
                <Button
                  data-testid="button-realtime-snapshot"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void captureManualSnapshot();
                  }}
                >
                  <Activity className="mr-2 h-4 w-4" />
                  Snapshot
                </Button>
                <Button
                  data-testid="button-realtime-start"
                  type="button"
                  onClick={() => {
                    void handleStartSession();
                  }}
                  disabled={status === 'requesting-mic' || status === 'negotiating' || status === 'stopping'}
                >
                  <PhoneCall className="mr-2 h-4 w-4" />
                  Start Session
                </Button>
                <Button
                  data-testid="button-realtime-stop"
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    void handleStopSession();
                  }}
                  disabled={status === 'idle' || status === 'stopped' || status === 'checking-backend'}
                >
                  <PhoneOff className="mr-2 h-4 w-4" />
                  Stop Session
                </Button>
              </div>

              <div className="space-y-2 rounded-2xl border p-4">
                <Label htmlFor="realtime-manual-prompt">Manual Realtime Prompt</Label>
                <Textarea
                  id="realtime-manual-prompt"
                  value={responsePrompt}
                  onChange={(event) => setResponsePrompt(event.target.value)}
                  rows={3}
                />
                <div className="flex flex-wrap gap-3">
                  <Button
                    data-testid="button-realtime-send-prompt"
                    type="button"
                    variant="outline"
                    onClick={handleSendPrompt}
                    disabled={status !== 'connected' || Boolean(activeResponseId)}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Send Prompt
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    This goes through the client data channel only while the assistant is idle.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wifi className="h-5 w-5 text-primary" />
                  Live Status
                </CardTitle>
                <CardDescription>
                  These are the local browser connection signals we care about most during the next
                  iPhone run.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={getStatusVariant(status)}>{status}</Badge>
                  <Badge variant="outline">version {APP_VERSION}</Badge>
                  <Badge variant={activeResponseId ? 'secondary' : 'outline'}>
                    {activeResponseId ? 'assistant busy' : 'assistant idle'}
                  </Badge>
                  {sessionId && <Badge variant="outline">session {sessionId}</Badge>}
                  {callId && <Badge variant="outline">call {callId}</Badge>}
                </div>

                {errorMessage && (
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                    {errorMessage}
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Peer
                    </p>
                    <p className="mt-2 text-sm font-medium">{connectionState}</p>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Signaling
                    </p>
                    <p className="mt-2 text-sm font-medium">{signalingState}</p>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      ICE Connection
                    </p>
                    <p className="mt-2 text-sm font-medium">{iceConnectionState}</p>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      ICE Gathering
                    </p>
                    <p className="mt-2 text-sm font-medium">{iceGatheringState}</p>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Data Channel
                    </p>
                    <p className="mt-2 text-sm font-medium">{dataChannelState}</p>
                  </div>
                  <div className="rounded-2xl border p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                      Remote Audio
                    </p>
                    <p className="mt-2 text-sm font-medium">
                      {remoteAudioAttached ? 'attached' : 'not attached'}
                      {remoteAudioPlaying ? ' · playing' : ''}
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border p-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <AudioLines className="h-4 w-4 text-primary" />
                    Remote Audio Monitor
                  </div>
                  <audio
                    ref={audioRef}
                    autoPlay
                    controls
                    playsInline
                    className="mt-3 w-full"
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mic className="h-5 w-5 text-primary" />
                  Backend Snapshot
                </CardTitle>
                <CardDescription>
                  A quick way to confirm the local server is reachable from the phone and actually
                  has an OpenAI key configured.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="rounded-2xl border p-4">
                  <p className="font-medium">
                    {backendHealth
                      ? backendHealth.ok
                        ? 'Backend reachable'
                        : 'Backend returned a non-ok result'
                      : 'No health snapshot yet'}
                  </p>
                  <p className="mt-2 text-muted-foreground">
                    {backendHealth
                      ? `checked=${backendHealth.checkedAt} | openai=${backendHealth.openAiConfigured ? 'yes' : 'no'} | uptime=${backendHealth.uptimeSeconds}s`
                      : 'Run “Check Backend” once before the phone test starts.'}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saved backend URL: {normalizedBackendUrl ?? 'not configured yet'}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Local Browser Log</CardTitle>
              <CardDescription>
                PWA snapshot events, peer connection state, ICE changes, data channel messages, and
                audio-element state all land here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScrollArea className="h-80 rounded-2xl border bg-muted/20 p-4">
                <pre
                  data-testid="realtime-local-log"
                  className="whitespace-pre-wrap break-words text-xs leading-6"
                >
                  {serializeDebugLogEntries(localLogs)}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Backend Session Log</CardTitle>
              <CardDescription>
                These logs come from the local helper server and include call creation, sideband
                websocket events, and backend-side realtime responses.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScrollArea className="h-80 rounded-2xl border bg-muted/20 p-4">
                <pre
                  data-testid="realtime-server-log"
                  className="whitespace-pre-wrap break-words text-xs leading-6"
                >
                  {serverLogs.length === 0
                    ? 'No backend logs recorded yet.'
                    : serverLogs
                        .map((entry) =>
                          entry.details
                            ? `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.event} — ${entry.details}`
                            : `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.event}`,
                        )
                        .join('\n')}
                </pre>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Export And Notes</CardTitle>
            <CardDescription>
              Add anything the phone test felt like and export the full report so the next change is
              based on evidence, not memory.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="realtime-notes">Tester Notes</Label>
              <Textarea
                id="realtime-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                placeholder="What happened on the phone? Did the remote voice play? Did audio stay alive after you spoke?"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                data-testid="button-realtime-copy-report"
                type="button"
                variant="outline"
                onClick={() => {
                  void handleCopyReport();
                }}
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy Report
              </Button>
              <Button
                data-testid="button-realtime-download-text"
                type="button"
                variant="outline"
                onClick={handleDownloadTextReport}
              >
                <Download className="mr-2 h-4 w-4" />
                Download Text
              </Button>
              <Button
                data-testid="button-realtime-download-json"
                type="button"
                variant="outline"
                onClick={handleDownloadJsonReport}
              >
                <Download className="mr-2 h-4 w-4" />
                Download JSON
              </Button>
              <Button
                data-testid="button-realtime-clear-logs"
                type="button"
                variant="ghost"
                onClick={handleClearLogs}
              >
                Clear Logs
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
