import { APP_VERSION } from './version';
import type { DebugLogEntry } from './debug-log';

type LocalDiagnosticSeverity = 'error' | 'info' | 'warning';
type LocalDiagnosticValue = string | number | boolean | null | undefined;

interface LocalDiagnosticContext {
  backendBaseUrl?: string | null;
  callId?: string | null;
  character?: string | null;
  currentLineNumber?: number | null;
  mode?: string | null;
  route?: string | null;
  sessionId?: string | null;
  status?: string | null;
}

interface LocalDiagnosticBrowserSnapshot {
  displayMode: string;
  language: string | null;
  online: boolean;
  platform: string | null;
  secureContext: boolean;
  serviceWorkerController: boolean | null;
  url: string;
  userAgent: string;
  visibility: string;
}

export interface LocalDiagnosticPayload {
  breadcrumbs: DebugLogEntry[];
  browser: LocalDiagnosticBrowserSnapshot | null;
  context: LocalDiagnosticContext;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
  extras?: Record<string, LocalDiagnosticValue>;
  severity: LocalDiagnosticSeverity;
  timestamp: string;
  type: string;
  version: string;
}

const LOCAL_DIAGNOSTIC_BREADCRUMB_LIMIT = 80;
const LOCAL_DIAGNOSTIC_TEXT_LIMIT = 1200;

let isInitialized = false;
let latestContext: LocalDiagnosticContext = {};
const breadcrumbBuffer: DebugLogEntry[] = [];

export function redactLocalDiagnosticText(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^|\s]+/gi, '$1[redacted]')
    .replace(/((?:transcript|spokenText|expectedText|text)\s*=\s*)[^|]+/gi, '$1[redacted]')
    .replace(
      /("(?:transcript|spokenText|expectedText|text)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"',
    )
    .slice(0, LOCAL_DIAGNOSTIC_TEXT_LIMIT);
}

function normalizeDiagnosticValue(
  value: LocalDiagnosticValue,
): string | number | boolean | null | undefined {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? redactLocalDiagnosticText(trimmedValue) : undefined;
}

function normalizeBreadcrumb(entry: DebugLogEntry): DebugLogEntry {
  return {
    details:
      typeof entry.details === 'string'
        ? redactLocalDiagnosticText(entry.details)
        : entry.details,
    event: redactLocalDiagnosticText(entry.event),
    timestamp: entry.timestamp,
  };
}

function getCurrentDisplayMode(): string {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'browser';
  }

  if (window.matchMedia('(display-mode: standalone)').matches) {
    return 'standalone';
  }

  if (window.matchMedia('(display-mode: fullscreen)').matches) {
    return 'fullscreen';
  }

  if (window.matchMedia('(display-mode: minimal-ui)').matches) {
    return 'minimal-ui';
  }

  return 'browser';
}

function buildBrowserSnapshot(): LocalDiagnosticBrowserSnapshot | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return null;
  }

  return {
    displayMode: getCurrentDisplayMode(),
    language: navigator.language || null,
    online: navigator.onLine,
    platform: navigator.platform || null,
    secureContext: window.isSecureContext,
    serviceWorkerController:
      'serviceWorker' in navigator ? Boolean(navigator.serviceWorker.controller) : null,
    url: window.location.href,
    userAgent: navigator.userAgent,
    visibility: document.visibilityState,
  };
}

function normalizeError(error: unknown): LocalDiagnosticPayload['error'] {
  if (error instanceof Error) {
    return {
      message: redactLocalDiagnosticText(error.message),
      name: error.name || 'Error',
      stack: error.stack ? redactLocalDiagnosticText(error.stack) : undefined,
    };
  }

  return {
    message: redactLocalDiagnosticText(String(error)),
    name: 'Error',
  };
}

export function buildLocalDiagnosticUrl(context: LocalDiagnosticContext): string | null {
  const backendBaseUrl = context.backendBaseUrl?.trim();
  if (!backendBaseUrl) {
    return null;
  }

  if (context.sessionId) {
    return `${backendBaseUrl}/api/realtime-webrtc/sessions/${encodeURIComponent(
      context.sessionId,
    )}/diagnostics`;
  }

  return `${backendBaseUrl}/api/realtime-webrtc/diagnostics`;
}

export function buildLocalDiagnosticPayload(options: {
  error?: unknown;
  extras?: Record<string, LocalDiagnosticValue>;
  severity?: LocalDiagnosticSeverity;
  type: string;
}): LocalDiagnosticPayload {
  const extras = Object.fromEntries(
    Object.entries(options.extras ?? {})
      .map(([key, value]) => [key, normalizeDiagnosticValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  );

  return {
    breadcrumbs: breadcrumbBuffer.slice(-LOCAL_DIAGNOSTIC_BREADCRUMB_LIMIT).map(normalizeBreadcrumb),
    browser: buildBrowserSnapshot(),
    context: latestContext,
    ...(options.error === undefined ? {} : { error: normalizeError(options.error) }),
    extras,
    severity: options.severity ?? 'error',
    timestamp: new Date().toISOString(),
    type: redactLocalDiagnosticText(options.type),
    version: APP_VERSION,
  };
}

export function setLocalDiagnosticContext(context: LocalDiagnosticContext): void {
  latestContext = {
    ...latestContext,
    ...context,
  };
}

export function recordLocalDiagnosticBreadcrumb(event: string, details?: string): void {
  breadcrumbBuffer.push({
    details: details ? redactLocalDiagnosticText(details) : undefined,
    event: redactLocalDiagnosticText(event),
    timestamp: new Date().toISOString(),
  });

  if (breadcrumbBuffer.length > LOCAL_DIAGNOSTIC_BREADCRUMB_LIMIT) {
    breadcrumbBuffer.splice(0, breadcrumbBuffer.length - LOCAL_DIAGNOSTIC_BREADCRUMB_LIMIT);
  }
}

export function captureLocalDiagnostic(options: {
  error?: unknown;
  extras?: Record<string, LocalDiagnosticValue>;
  severity?: LocalDiagnosticSeverity;
  type: string;
}): void {
  const diagnosticUrl = buildLocalDiagnosticUrl(latestContext);
  if (!diagnosticUrl) {
    return;
  }

  const payload = buildLocalDiagnosticPayload(options);
  void fetch(diagnosticUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Local diagnostics should never affect rehearsal flow.
  });
}

export function initializeLocalDiagnostics(): void {
  if (isInitialized || typeof window === 'undefined') {
    return;
  }

  isInitialized = true;
  window.addEventListener('error', (event) => {
    captureLocalDiagnostic({
      error: event.error ?? event.message,
      extras: {
        columnNumber: event.colno,
        filename: event.filename,
        lineNumber: event.lineno,
      },
      type: 'window-error',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    captureLocalDiagnostic({
      error: event.reason,
      type: 'unhandled-rejection',
    });
  });
}
