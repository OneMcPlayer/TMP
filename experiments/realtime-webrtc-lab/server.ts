import crypto from 'node:crypto';
import express from 'express';
import WebSocket from 'ws';

import {
  advancePastCurrentUserLine,
  buildLiveMemorizationController,
  consumeNextAutomaticSpeech,
  getCurrentLiveMemorizationLine,
  getUpcomingUserLine,
  markLiveMemorizationCompletionAnnounced,
  processLiveMemorizationTranscript,
  rememberLiveMemorizationSpeech,
  shouldAnnounceCompletion,
  type LiveMemorizationCommand,
  type LiveMemorizationController,
} from '../../shared/live-memorization-controller';
import {
  buildTranscriptionPrompt,
  normalizeScript,
  type RawScript,
  type Script,
} from '../../shared/rehearsal-core';

type SessionLogLevel = 'error' | 'info';

type SessionLogEntry = {
  seq: number;
  timestamp: string;
  level: SessionLogLevel;
  event: string;
  details?: string;
};

type SessionStatus = 'connecting' | 'connected' | 'ended' | 'error';

type SessionResponseQueueItem = {
  purpose: string;
  text: string;
};

type BaseRealtimeLabSession = {
  id: string;
  createdAt: number;
  callId: string | null;
  model: string;
  status: SessionStatus;
  logs: SessionLogEntry[];
  nextSeq: number;
  sidebandSocket: WebSocket | null;
  activeResponseId: string | null;
  responseQueue: SessionResponseQueueItem[];
  voice: string;
};

type DefaultRealtimeLabSession = BaseRealtimeLabSession & {
  mode: 'default';
};

type LiveMemorizationState = {
  controller: LiveMemorizationController;
  script: Script;
  selectedCharacter: string;
  committedItemIds: string[];
  transcriptsByItemId: Map<string, string>;
};

type LiveMemorizationRealtimeLabSession = BaseRealtimeLabSession & {
  mode: 'live-memorization';
  liveMemorization: LiveMemorizationState;
};

type RealtimeLabSession = DefaultRealtimeLabSession | LiveMemorizationRealtimeLabSession;

type CreateCallBody = {
  greetingPrompt?: string;
  instructions?: string;
  offerSdp?: string;
  turnDetection?: 'disabled' | 'server_vad';
  voice?: string;
};

type CreateLiveMemorizationCallBody = {
  offerSdp?: string;
  voice?: string;
  script?: RawScript;
  selectedCharacter?: string;
  startLineNumber?: number;
  maxAttemptsPerLine?: number;
};

type LiveMemorizationControlBody = {
  command?: LiveMemorizationCommand;
};

const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_TURN_DETECTION: 'disabled' | 'server_vad' = 'server_vad';
const DEFAULT_VOICE = 'alloy';
const MAX_LOGS_PER_SESSION = 800;
const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const LIVE_MEMORIZATION_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

const app = express();
const sessions = new Map<string, RealtimeLabSession>();

app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

function formatTimestamp(date = new Date()): string {
  return date.toISOString();
}

function summarizeRealtimeEvent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return 'Unrecognized realtime event payload';
  }

  const event = payload as {
    audio_end_ms?: number;
    audio_start_ms?: number;
    error?: { message?: string; type?: string };
    event_id?: string;
    item_id?: string;
    response?: { id?: string };
    session?: { id?: string };
    transcript?: string;
    type?: string;
  };

  const parts = [
    typeof event.type === 'string' ? `type=${event.type}` : null,
    typeof event.event_id === 'string' ? `event=${event.event_id}` : null,
    typeof event.session?.id === 'string' ? `session=${event.session.id}` : null,
    typeof event.response?.id === 'string' ? `response=${event.response.id}` : null,
    typeof event.item_id === 'string' ? `item=${event.item_id}` : null,
    typeof event.audio_start_ms === 'number' ? `audioStart=${event.audio_start_ms}` : null,
    typeof event.audio_end_ms === 'number' ? `audioEnd=${event.audio_end_ms}` : null,
    typeof event.error?.type === 'string' ? `errorType=${event.error.type}` : null,
    typeof event.error?.message === 'string' ? `error=${event.error.message}` : null,
    typeof event.transcript === 'string' ? `transcript=${event.transcript}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' | ') : 'Realtime event received';
}

function createBaseSession(model: string, voice: string): BaseRealtimeLabSession {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    callId: null,
    model,
    status: 'connecting',
    logs: [],
    nextSeq: 1,
    sidebandSocket: null,
    activeResponseId: null,
    responseQueue: [],
    voice,
  };
}

function createDefaultSession(model: string, voice: string): DefaultRealtimeLabSession {
  const session: DefaultRealtimeLabSession = {
    ...createBaseSession(model, voice),
    mode: 'default',
  };

  sessions.set(session.id, session);
  return session;
}

function createLiveMemorizationSession(options: {
  maxAttemptsPerLine: number;
  model: string;
  script: Script;
  selectedCharacter: string;
  startLineNumber: number;
  voice: string;
}): LiveMemorizationRealtimeLabSession {
  const session: LiveMemorizationRealtimeLabSession = {
    ...createBaseSession(options.model, options.voice),
    mode: 'live-memorization',
    liveMemorization: {
      controller: buildLiveMemorizationController({
        maxAttemptsPerLine: options.maxAttemptsPerLine,
        script: options.script,
        selectedCharacter: options.selectedCharacter,
        startLineNumber: options.startLineNumber,
      }),
      script: options.script,
      selectedCharacter: options.selectedCharacter,
      committedItemIds: [],
      transcriptsByItemId: new Map<string, string>(),
    },
  };

  sessions.set(session.id, session);
  return session;
}

function appendSessionLog(
  session: RealtimeLabSession,
  level: SessionLogLevel,
  event: string,
  details?: string,
): SessionLogEntry {
  const entry: SessionLogEntry = {
    seq: session.nextSeq,
    timestamp: formatTimestamp(),
    level,
    event,
    details,
  };

  session.nextSeq += 1;
  session.logs = [...session.logs, entry].slice(-MAX_LOGS_PER_SESSION);
  return entry;
}

function closeSidebandSocket(session: RealtimeLabSession): void {
  if (!session.sidebandSocket) {
    return;
  }

  try {
    session.sidebandSocket.close();
  } catch {
    // Ignore shutdown errors in the experiment server.
  }

  session.sidebandSocket = null;
}

function sessionModelForRequest(model: string): string {
  return model;
}

function inferLanguageCode(language?: string): string | undefined {
  const normalizedLanguage = language?.trim().toLowerCase();
  if (!normalizedLanguage) {
    return undefined;
  }

  if (normalizedLanguage.startsWith('it') || normalizedLanguage.includes('ital')) {
    return 'it';
  }

  if (normalizedLanguage.startsWith('en') || normalizedLanguage.includes('engl')) {
    return 'en';
  }

  return undefined;
}

function isLiveMemorizationSession(
  session: RealtimeLabSession,
): session is LiveMemorizationRealtimeLabSession {
  return session.mode === 'live-memorization';
}

function buildDefaultSessionConfiguration(options: {
  instructions?: string;
  turnDetection: 'disabled' | 'server_vad';
  voice: string;
}) {
  return {
    type: 'realtime',
    model: sessionModelForRequest(DEFAULT_MODEL),
    instructions:
      options.instructions?.trim() ||
      'You are a short, friendly voice assistant. Speak clearly and keep replies concise.',
    output_modalities: ['audio'],
    audio: {
      input: {
        ...(options.turnDetection === 'server_vad'
          ? {
              turn_detection: {
                type: 'server_vad',
                create_response: true,
                interrupt_response: true,
              },
            }
          : {}),
      },
      output: {
        voice: options.voice,
      },
    },
  };
}

function buildLiveMemorizationSessionConfiguration(
  session: LiveMemorizationRealtimeLabSession,
) {
  const liveMemorizationState = session.liveMemorization;
  const expectedLine = getUpcomingUserLine(liveMemorizationState.controller)?.speakableText ?? '';
  const language = inferLanguageCode(liveMemorizationState.script.language);

  return {
    type: 'realtime',
    model: sessionModelForRequest(session.model),
    instructions: [
      'You are the audio renderer for a live memorization drill.',
      'Do not improvise or continue the scene on your own.',
      'Only speak when a response.create event explicitly asks you to render exact text.',
      'When you do speak, say exactly that text and nothing else.',
    ].join(' '),
    output_modalities: ['audio'],
    audio: {
      input: {
        transcription: {
          model: LIVE_MEMORIZATION_TRANSCRIPTION_MODEL,
          ...(language ? { language } : {}),
          prompt: buildTranscriptionPrompt(
            liveMemorizationState.script,
            liveMemorizationState.selectedCharacter,
            expectedLine,
          ),
        },
        turn_detection: {
          type: 'server_vad',
          create_response: false,
          interrupt_response: true,
        },
      },
      output: {
        voice: session.voice,
      },
    },
  };
}

function sendSidebandEvent(
  session: RealtimeLabSession,
  event: Record<string, unknown>,
  logEvent: string,
  details?: string,
): boolean {
  const socket = session.sidebandSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendSessionLog(session, 'error', `${logEvent} Failed`, 'Sideband socket is not open.');
    return false;
  }

  socket.send(JSON.stringify(event));
  appendSessionLog(session, 'info', logEvent, details);
  return true;
}

function buildExactSpeechInstructions(text: string): string {
  return [
    'Speak the following text exactly as written.',
    'Do not add introductions, explanations, or speaker labels.',
    'Keep the pacing natural and concise.',
    `Text: ${JSON.stringify(text)}`,
  ].join('\n');
}

function enqueueSessionSpeech(
  session: RealtimeLabSession,
  text: string,
  purpose: string,
): void {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return;
  }

  session.responseQueue.push({
    purpose,
    text: trimmedText,
  });

  appendSessionLog(session, 'info', 'Speech Queued', `purpose=${purpose} | text=${trimmedText}`);
  flushSessionSpeechQueue(session);
}

function flushSessionSpeechQueue(session: RealtimeLabSession): void {
  if (session.activeResponseId) {
    return;
  }

  const nextSpeech = session.responseQueue.shift();
  if (!nextSpeech) {
    return;
  }

  if (isLiveMemorizationSession(session)) {
    rememberLiveMemorizationSpeech(session.liveMemorization.controller, nextSpeech.text);
  }

  session.activeResponseId = 'pending';

  const didSend = sendSidebandEvent(
    session,
    {
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: buildExactSpeechInstructions(nextSpeech.text),
        metadata: {
          purpose: nextSpeech.purpose,
        },
      },
    },
    'Speech Requested',
    `purpose=${nextSpeech.purpose} | text=${nextSpeech.text}`,
  );

  if (!didSend) {
    session.activeResponseId = null;
    session.responseQueue.unshift(nextSpeech);
  }
}

function queueLiveMemorizationCompletionIfNeeded(
  session: LiveMemorizationRealtimeLabSession,
): boolean {
  if (!shouldAnnounceCompletion(session.liveMemorization.controller)) {
    return false;
  }

  markLiveMemorizationCompletionAnnounced(session.liveMemorization.controller);
  enqueueSessionSpeech(session, 'Memorization pass complete.', 'completion');
  return true;
}

function refreshLiveMemorizationSessionConfiguration(
  session: LiveMemorizationRealtimeLabSession,
): void {
  sendSidebandEvent(
    session,
    {
      type: 'session.update',
      session: buildLiveMemorizationSessionConfiguration(session),
    },
    'Live Memorization Session Updated',
    `nextLine=${getCurrentLiveMemorizationLine(session.liveMemorization.controller)?.lineNumber ?? 'done'}`,
  );
}

function queueLiveMemorizationStep(
  session: LiveMemorizationRealtimeLabSession,
  reason: 'kickoff' | 'accepted' | 'continue',
): void {
  const liveMemorizationController = session.liveMemorization.controller;
  const partnerLines: string[] = [];

  while (true) {
    const partnerLine = consumeNextAutomaticSpeech(liveMemorizationController);
    if (!partnerLine) {
      break;
    }

    partnerLines.push(partnerLine.speakableText);
  }

  refreshLiveMemorizationSessionConfiguration(session);

  if (partnerLines.length > 0) {
    enqueueSessionSpeech(session, partnerLines.join(' '), 'partner-cue');
    void queueLiveMemorizationCompletionIfNeeded(session);
    return;
  }

  if (queueLiveMemorizationCompletionIfNeeded(session)) {
    return;
  }

  const currentLine = getCurrentLiveMemorizationLine(liveMemorizationController);
  if (!currentLine?.isUserLine) {
    return;
  }

  enqueueSessionSpeech(
    session,
    reason === 'kickoff' ? 'Your line.' : 'Continue.',
    'user-turn-cue',
  );
}

function handleLiveMemorizationControlCommand(
  session: LiveMemorizationRealtimeLabSession,
  command: LiveMemorizationCommand,
  source: 'button' | 'voice',
): void {
  const controller = session.liveMemorization.controller;
  const currentLine = getCurrentLiveMemorizationLine(controller);

  appendSessionLog(
    session,
    'info',
    'Live Memorization Control',
    `source=${source} | command=${command} | line=${currentLine?.lineNumber ?? 'done'}`,
  );

  if (command === 'repeat') {
    const repeatedText =
      controller.lastSpokenCoachText ??
      (currentLine?.isUserLine ? 'Your line.' : currentLine?.speakableText ?? 'Continue.');
    enqueueSessionSpeech(session, repeatedText, 'repeat');
    return;
  }

  if (command === 'reveal') {
    if (currentLine?.isUserLine) {
      enqueueSessionSpeech(session, `Your line is: ${currentLine.speakableText}`, 'reveal');
      return;
    }

    queueLiveMemorizationStep(session, 'continue');
    return;
  }

  if (currentLine?.isUserLine) {
    advancePastCurrentUserLine(controller);
  }

  queueLiveMemorizationStep(session, 'continue');
}

function flushLiveMemorizationTranscriptions(
  session: LiveMemorizationRealtimeLabSession,
): void {
  const liveMemorizationState = session.liveMemorization;

  while (liveMemorizationState.committedItemIds.length > 0) {
    const itemId = liveMemorizationState.committedItemIds[0];
    const transcript = liveMemorizationState.transcriptsByItemId.get(itemId);

    if (typeof transcript !== 'string') {
      return;
    }

    liveMemorizationState.committedItemIds.shift();
    liveMemorizationState.transcriptsByItemId.delete(itemId);

    const outcome = processLiveMemorizationTranscript(
      liveMemorizationState.controller,
      transcript,
    );

    switch (outcome.type) {
      case 'accepted':
        appendSessionLog(
          session,
          'info',
          'Line Accepted',
          `item=${itemId} | accuracy=${outcome.evaluation.accuracy}% | transcript=${transcript}`,
        );
        queueLiveMemorizationStep(session, 'accepted');
        break;
      case 'retry':
        appendSessionLog(
          session,
          'info',
          'Line Retry Requested',
          `item=${itemId} | accuracy=${outcome.evaluation.accuracy}% | remaining=${outcome.attemptsRemaining} | transcript=${transcript}`,
        );
        enqueueSessionSpeech(
          session,
          outcome.attemptsRemaining === 1 ? 'Almost. One more try.' : 'Not yet. Try again.',
          'retry',
        );
        break;
      case 'reveal-and-advance':
        appendSessionLog(
          session,
          'info',
          'Line Revealed After Max Attempts',
          `item=${itemId} | accuracy=${outcome.evaluation.accuracy}% | transcript=${transcript}`,
        );
        enqueueSessionSpeech(
          session,
          `Your line is: ${outcome.revealText}`,
          'reveal-after-max-attempts',
        );
        queueLiveMemorizationStep(session, 'continue');
        break;
      case 'control':
        appendSessionLog(
          session,
          'info',
          'Voice Control Detected',
          `item=${itemId} | command=${outcome.command} | transcript=${transcript}`,
        );
        handleLiveMemorizationControlCommand(session, outcome.command, 'voice');
        break;
      case 'ignored':
        appendSessionLog(
          session,
          'info',
          'Transcript Ignored',
          `item=${itemId} | reason=${outcome.reason} | transcript=${transcript}`,
        );
        break;
      default:
        break;
    }
  }
}

function handleLiveMemorizationEvent(
  session: LiveMemorizationRealtimeLabSession,
  payload: unknown,
): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = payload as {
    item_id?: string;
    response?: { id?: string };
    transcript?: string;
    type?: string;
  };

  if (event.type === 'input_audio_buffer.committed' && typeof event.item_id === 'string') {
    session.liveMemorization.committedItemIds.push(event.item_id);
    appendSessionLog(session, 'info', 'User Audio Committed', `item=${event.item_id}`);
    flushLiveMemorizationTranscriptions(session);
    return;
  }

  if (
    event.type === 'conversation.item.input_audio_transcription.completed' &&
    typeof event.item_id === 'string' &&
    typeof event.transcript === 'string'
  ) {
    session.liveMemorization.transcriptsByItemId.set(event.item_id, event.transcript.trim());
    appendSessionLog(
      session,
      'info',
      'User Audio Transcribed',
      `item=${event.item_id} | transcript=${event.transcript.trim()}`,
    );
    flushLiveMemorizationTranscriptions(session);
    return;
  }

  if (event.type === 'response.created') {
    session.activeResponseId = typeof event.response?.id === 'string' ? event.response.id : null;
    return;
  }

  if (event.type === 'response.done') {
    if (
      session.activeResponseId === 'pending' ||
      !event.response?.id ||
      event.response.id === session.activeResponseId
    ) {
      session.activeResponseId = null;
    }

    flushSessionSpeechQueue(session);
  }
}

function handleDefaultSessionEvent(session: DefaultRealtimeLabSession, payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = payload as {
    response?: { id?: string };
    type?: string;
  };

  if (event.type === 'response.created') {
    session.activeResponseId = typeof event.response?.id === 'string' ? event.response.id : null;
    return;
  }

  if (event.type === 'response.done') {
    if (
      session.activeResponseId === 'pending' ||
      !event.response?.id ||
      event.response.id === session.activeResponseId
    ) {
      session.activeResponseId = null;
    }

    flushSessionSpeechQueue(session);
  }
}

async function connectSidebandSocket(
  session: RealtimeLabSession,
  options?: {
    greetingPrompt?: string;
    instructions?: string;
    turnDetection?: 'disabled' | 'server_vad';
  },
): Promise<void> {
  if (!session.callId) {
    appendSessionLog(session, 'error', 'Sideband Skipped', 'No call ID was returned by OpenAI.');
    return;
  }

  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${session.callId}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
  });

  session.sidebandSocket = socket;

  socket.on('open', () => {
    session.status = 'connected';
    appendSessionLog(
      session,
      'info',
      'Sideband Connected',
      `callId=${session.callId} | model=${session.model}`,
    );

    if (isLiveMemorizationSession(session)) {
      refreshLiveMemorizationSessionConfiguration(session);
      queueLiveMemorizationStep(session, 'kickoff');
      return;
    }

    const sessionUpdateEvent = {
      type: 'session.update',
      session: buildDefaultSessionConfiguration({
        instructions: options?.instructions,
        turnDetection: options?.turnDetection ?? DEFAULT_TURN_DETECTION,
        voice: session.voice,
      }),
    };

    sendSidebandEvent(
      session,
      sessionUpdateEvent,
      'Sideband Session Update Sent',
      `voice=${session.voice} | turnDetection=${options?.turnDetection ?? DEFAULT_TURN_DETECTION}`,
    );

    if (options?.greetingPrompt?.trim()) {
      enqueueSessionSpeech(session, options.greetingPrompt.trim(), 'initial-greeting');
      appendSessionLog(session, 'info', 'Initial Greeting Requested', options.greetingPrompt.trim());
    }
  });

  socket.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString()) as unknown;
      appendSessionLog(session, 'info', 'Sideband Event', summarizeRealtimeEvent(payload));

      if (
        payload &&
        typeof payload === 'object' &&
        (payload as { type?: string }).type === 'error' &&
        session.activeResponseId === 'pending'
      ) {
        session.activeResponseId = null;
        appendSessionLog(session, 'info', 'Pending Response Cleared After Error');
      }

      if (isLiveMemorizationSession(session)) {
        handleLiveMemorizationEvent(session, payload);
      } else {
        handleDefaultSessionEvent(session, payload);
      }
    } catch {
      appendSessionLog(
        session,
        'info',
        'Sideband Event',
        `non-json payload (${message.toString().length} chars)`,
      );
    }
  });

  socket.on('close', (code, reason) => {
    session.status = session.status === 'ended' ? 'ended' : 'error';
    appendSessionLog(
      session,
      'info',
      'Sideband Closed',
      `code=${code} | reason=${reason.toString() || 'none'}`,
    );
  });

  socket.on('error', (error) => {
    session.status = 'error';
    appendSessionLog(session, 'error', 'Sideband Error', error.message);
  });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    openAiConfigured: Boolean(OPENAI_API_KEY),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.post('/api/realtime-webrtc/calls', async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error: 'OPENAI_API_KEY is not configured on the experiment server.',
    });
    return;
  }

  const {
    greetingPrompt,
    instructions,
    offerSdp,
    turnDetection = DEFAULT_TURN_DETECTION,
    voice = DEFAULT_VOICE,
  } = (req.body ?? {}) as CreateCallBody;

  if (typeof offerSdp !== 'string' || !offerSdp.trim()) {
    res.status(400).json({
      error: 'offerSdp is required.',
    });
    return;
  }

  const session = createDefaultSession(DEFAULT_MODEL, voice);
  appendSessionLog(
    session,
    'info',
    'Call Request Received',
    `voice=${voice} | turnDetection=${turnDetection}`,
  );

  try {
    const formData = new FormData();
    formData.set('sdp', offerSdp);
    formData.set(
      'session',
      JSON.stringify(
        buildDefaultSessionConfiguration({
          instructions,
          turnDetection,
          voice,
        }),
      ),
    );

    const realtimeResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const answerSdp = await realtimeResponse.text();
    const location = realtimeResponse.headers.get('Location');
    const callId = location?.split('/').pop() ?? null;
    session.callId = callId;

    appendSessionLog(
      session,
      realtimeResponse.ok ? 'info' : 'error',
      'OpenAI Call Response',
      `status=${realtimeResponse.status} | callId=${callId ?? 'none'} | answerLength=${answerSdp.length}`,
    );

    if (!realtimeResponse.ok) {
      session.status = 'error';
      res.status(502).json({
        error: answerSdp || `OpenAI realtime call failed with status ${realtimeResponse.status}.`,
        logs: session.logs,
        sessionId: session.id,
      });
      return;
    }

    void connectSidebandSocket(session, {
      greetingPrompt,
      instructions,
      turnDetection,
    });

    res.json({
      answerSdp,
      callId,
      model: session.model,
      sessionId: session.id,
      voice,
    });
  } catch (error) {
    session.status = 'error';
    appendSessionLog(
      session,
      'error',
      'Call Request Failed',
      error instanceof Error ? error.message : 'Unknown realtime call error',
    );

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown realtime call error',
      logs: session.logs,
      sessionId: session.id,
    });
  }
});

app.post('/api/realtime-webrtc/live-memorization/calls', async (req, res) => {
  if (!OPENAI_API_KEY) {
    res.status(500).json({
      error: 'OPENAI_API_KEY is not configured on the experiment server.',
    });
    return;
  }

  const {
    offerSdp,
    voice = DEFAULT_VOICE,
    script: rawScript,
    selectedCharacter,
    startLineNumber = 1,
    maxAttemptsPerLine = 3,
  } = (req.body ?? {}) as CreateLiveMemorizationCallBody;

  if (typeof offerSdp !== 'string' || !offerSdp.trim()) {
    res.status(400).json({
      error: 'offerSdp is required.',
    });
    return;
  }

  if (!rawScript || typeof rawScript !== 'object') {
    res.status(400).json({
      error: 'A normalized script payload is required for live memorization.',
    });
    return;
  }

  if (typeof selectedCharacter !== 'string' || !selectedCharacter.trim()) {
    res.status(400).json({
      error: 'selectedCharacter is required for live memorization.',
    });
    return;
  }

  let script: Script;
  try {
    script = normalizeScript(rawScript);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid script payload.',
    });
    return;
  }

  const trimmedCharacter = selectedCharacter.trim();
  const availableCharacters = new Set(script.lines.map((line) => line.character));

  if (!availableCharacters.has(trimmedCharacter)) {
    res.status(400).json({
      error: `Character "${trimmedCharacter}" was not found in the uploaded script.`,
    });
    return;
  }

  const session = createLiveMemorizationSession({
    maxAttemptsPerLine,
    model: DEFAULT_MODEL,
    script,
    selectedCharacter: trimmedCharacter,
    startLineNumber,
    voice,
  });

  appendSessionLog(
    session,
    'info',
    'Live Memorization Call Request Received',
    `voice=${voice} | character=${trimmedCharacter} | startLine=${startLineNumber} | attempts=${maxAttemptsPerLine}`,
  );

  try {
    const formData = new FormData();
    formData.set('sdp', offerSdp);
    formData.set(
      'session',
      JSON.stringify(buildLiveMemorizationSessionConfiguration(session)),
    );

    const realtimeResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const answerSdp = await realtimeResponse.text();
    const location = realtimeResponse.headers.get('Location');
    const callId = location?.split('/').pop() ?? null;
    session.callId = callId;

    appendSessionLog(
      session,
      realtimeResponse.ok ? 'info' : 'error',
      'OpenAI Call Response',
      `status=${realtimeResponse.status} | callId=${callId ?? 'none'} | answerLength=${answerSdp.length}`,
    );

    if (!realtimeResponse.ok) {
      session.status = 'error';
      res.status(502).json({
        error: answerSdp || `OpenAI realtime call failed with status ${realtimeResponse.status}.`,
        logs: session.logs,
        sessionId: session.id,
      });
      return;
    }

    void connectSidebandSocket(session);

    res.json({
      answerSdp,
      callId,
      mode: session.mode,
      model: session.model,
      sessionId: session.id,
      voice,
    });
  } catch (error) {
    session.status = 'error';
    appendSessionLog(
      session,
      'error',
      'Live Memorization Call Request Failed',
      error instanceof Error ? error.message : 'Unknown realtime call error',
    );

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown realtime call error',
      logs: session.logs,
      sessionId: session.id,
    });
  }
});

app.post('/api/realtime-webrtc/sessions/:sessionId/live-memorization/control', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session || !isLiveMemorizationSession(session)) {
    res.status(404).json({
      error: 'Live memorization session not found.',
    });
    return;
  }

  const { command } = (req.body ?? {}) as LiveMemorizationControlBody;
  if (
    command !== 'continue' &&
    command !== 'repeat' &&
    command !== 'reveal' &&
    command !== 'skip'
  ) {
    res.status(400).json({
      error: 'A valid live memorization command is required.',
    });
    return;
  }

  handleLiveMemorizationControlCommand(session, command, 'button');

  res.json({
    ok: true,
    queuedResponses: session.responseQueue.length,
    sessionId: session.id,
    status: session.status,
  });
});

app.get('/api/realtime-webrtc/sessions/:sessionId/logs', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({
      error: 'Realtime experiment session not found.',
    });
    return;
  }

  const afterSeq = Number.parseInt(String(req.query.after ?? '0'), 10);
  const logs = Number.isFinite(afterSeq)
    ? session.logs.filter((entry) => entry.seq > afterSeq)
    : session.logs;

  res.json({
    callId: session.callId,
    logs,
    mode: session.mode,
    sessionId: session.id,
    status: session.status,
  });
});

app.post('/api/realtime-webrtc/sessions/:sessionId/end', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    res.status(404).json({
      error: 'Realtime experiment session not found.',
    });
    return;
  }

  session.status = 'ended';
  appendSessionLog(session, 'info', 'Session End Requested');
  closeSidebandSocket(session);

  res.json({
    ok: true,
    sessionId: session.id,
  });
});

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.createdAt >= cutoff) {
      continue;
    }

    closeSidebandSocket(session);
    sessions.delete(sessionId);
  }
}, 60_000).unref();

app.listen(DEFAULT_PORT, () => {
  console.log(
    `Realtime WebRTC lab server listening on http://127.0.0.1:${DEFAULT_PORT} (OPENAI_API_KEY configured: ${OPENAI_API_KEY ? 'yes' : 'no'})`,
  );
});
