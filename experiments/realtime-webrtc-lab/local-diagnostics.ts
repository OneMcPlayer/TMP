export interface ClientDiagnosticPayload {
  breadcrumbs?: unknown;
  browser?: unknown;
  context?: unknown;
  error?: unknown;
  extras?: unknown;
  severity?: unknown;
  timestamp?: unknown;
  type?: unknown;
  version?: unknown;
}

export interface ClientDiagnosticRecord {
  breadcrumbs: Array<{
    details?: string;
    event: string;
    timestamp: string;
  }>;
  browser: Record<string, unknown> | null;
  context: Record<string, unknown>;
  error: {
    message: string;
    name: string;
    stack?: string;
  } | null;
  extras: Record<string, unknown>;
  receivedAt: string;
  severity: 'error' | 'info' | 'warning';
  timestamp: string;
  type: string;
  version: string | null;
}

const MAX_DIAGNOSTIC_TEXT_LENGTH = 1200;
const MAX_DIAGNOSTIC_BREADCRUMBS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? redactLocalDiagnosticText(trimmedValue) : fallback;
}

export function redactLocalDiagnosticText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^|\s]+/gi, '$1[redacted]')
    .replace(/((?:transcript|spokenText|expectedText|text)\s*=\s*)[^|]+/gi, '$1[redacted]')
    .replace(
      /("(?:transcript|spokenText|expectedText|text)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"',
    )
    .slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

function normalizePrimitive(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeText(value);
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  return undefined;
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [key, normalizePrimitive(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined),
  );
}

function normalizeSeverity(value: unknown): ClientDiagnosticRecord['severity'] {
  return value === 'info' || value === 'warning' || value === 'error' ? value : 'error';
}

function normalizeBreadcrumbs(value: unknown): ClientDiagnosticRecord['breadcrumbs'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(-MAX_DIAGNOSTIC_BREADCRUMBS).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const event = normalizeText(entry.event, 'Client Event');
    const timestamp = normalizeText(entry.timestamp, new Date().toISOString());
    const details = normalizeText(entry.details);

    return [
      {
        ...(details ? { details } : {}),
        event,
        timestamp,
      },
    ];
  });
}

function normalizeError(value: unknown): ClientDiagnosticRecord['error'] {
  if (!isRecord(value)) {
    return null;
  }

  const message = normalizeText(value.message, 'Unknown client error');
  const name = normalizeText(value.name, 'Error');
  const stack = normalizeText(value.stack);

  return {
    message,
    name,
    ...(stack ? { stack } : {}),
  };
}

export function buildClientDiagnosticRecord(
  payload: ClientDiagnosticPayload,
  receivedAt = new Date().toISOString(),
): ClientDiagnosticRecord {
  return {
    breadcrumbs: normalizeBreadcrumbs(payload.breadcrumbs),
    browser: isRecord(payload.browser) ? sanitizeRecord(payload.browser) : null,
    context: sanitizeRecord(payload.context),
    error: normalizeError(payload.error),
    extras: sanitizeRecord(payload.extras),
    receivedAt,
    severity: normalizeSeverity(payload.severity),
    timestamp: normalizeText(payload.timestamp, receivedAt),
    type: normalizeText(payload.type, 'client-diagnostic'),
    version: normalizeText(payload.version) || null,
  };
}

export function summarizeClientDiagnosticRecord(record: ClientDiagnosticRecord): string {
  return [
    `type=${record.type}`,
    `severity=${record.severity}`,
    record.version ? `version=${record.version}` : null,
    typeof record.context.route === 'string' ? `route=${record.context.route}` : null,
    typeof record.context.status === 'string' ? `status=${record.context.status}` : null,
    record.error ? `error=${record.error.name}: ${record.error.message}` : null,
    `breadcrumbs=${record.breadcrumbs.length}`,
  ]
    .filter(Boolean)
    .join(' | ');
}
