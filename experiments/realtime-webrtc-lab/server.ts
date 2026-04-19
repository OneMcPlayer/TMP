import crypto from 'node:crypto';
import express from 'express';
import WebSocket from 'ws';

type SessionLogLevel = 'error' | 'info';

type SessionLogEntry = {
  seq: number;
  timestamp: string;
  level: SessionLogLevel;
  event: string;
  details?: string;
};

type RealtimeLabSession = {
  id: string;
  createdAt: number;
  callId: string | null;
  model: string;
  status: 'connecting' | 'connected' | 'ended' | 'error';
  logs: SessionLogEntry[];
  nextSeq: number;
  sidebandSocket: WebSocket | null;
};

type CreateCallBody = {
  greetingPrompt?: string;
  instructions?: string;
  offerSdp?: string;
  turnDetection?: 'disabled' | 'server_vad';
  voice?: string;
};

const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_TURN_DETECTION: CreateCallBody['turnDetection'] = 'server_vad';
const DEFAULT_VOICE = 'alloy';
const MAX_LOGS_PER_SESSION = 600;
const SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';

const app = express();
const sessions = new Map<string, RealtimeLabSession>();

app.use(express.json({ limit: '1mb' }));
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

function createSession(model: string): RealtimeLabSession {
  const session: RealtimeLabSession = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    callId: null,
    model,
    status: 'connecting',
    logs: [],
    nextSeq: 1,
    sidebandSocket: null,
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

function buildSessionConfiguration(options: {
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

function sessionModelForRequest(model: string): string {
  return model;
}

async function connectSidebandSocket(
  session: RealtimeLabSession,
  options: {
    greetingPrompt?: string;
    instructions?: string;
    turnDetection: 'disabled' | 'server_vad';
    voice: string;
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

    const sessionUpdateEvent = {
      type: 'session.update',
      session: buildSessionConfiguration(options),
    };

    socket.send(JSON.stringify(sessionUpdateEvent));
    appendSessionLog(
      session,
      'info',
      'Sideband Session Update Sent',
      `voice=${options.voice} | turnDetection=${options.turnDetection}`,
    );

    if (options.greetingPrompt?.trim()) {
      socket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            output_modalities: ['audio'],
            instructions: options.greetingPrompt.trim(),
          },
        }),
      );
      appendSessionLog(session, 'info', 'Initial Greeting Requested', options.greetingPrompt.trim());
    }
  });

  socket.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString()) as unknown;
      appendSessionLog(session, 'info', 'Sideband Event', summarizeRealtimeEvent(payload));
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

  const session = createSession(DEFAULT_MODEL);
  appendSessionLog(session, 'info', 'Call Request Received', `voice=${voice} | turnDetection=${turnDetection}`);

  try {
    const formData = new FormData();
    formData.set('sdp', offerSdp);
    formData.set(
      'session',
      JSON.stringify(
        buildSessionConfiguration({
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
      voice,
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
