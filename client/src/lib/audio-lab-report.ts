import { serializeDebugLogEntries, type DebugLogEntry } from './debug-log';

export type AudioLabStepStatus = 'idle' | 'success' | 'warning' | 'error';

export interface AudioLabStepResult {
  status: AudioLabStepStatus;
  summary: string;
}

export interface AudioLabMediaActionCounts {
  play: number;
  pause: number;
  stop: number;
  nexttrack: number;
  previoustrack: number;
  seekforward: number;
  seekbackward: number;
}

export interface AudioLabReport {
  appVersion: string;
  exportedAt: string;
  locationHref: string;
  testerNotes: string;
  audioSession: {
    supported: boolean;
    type: string | null;
    state: string | null;
    history: string[];
  };
  mediaControls: {
    probeMode: string;
    counts: AudioLabMediaActionCounts;
  };
  microphone: {
    permissionSummary: string;
    warmStreamSummary: string;
  };
  recording: {
    mode: string;
    summary: string;
    lastBlobSize: number | null;
    lastMimeType: string | null;
  };
  steps: Record<string, AudioLabStepResult>;
  debugEntries: DebugLogEntry[];
}

function formatStepResult(stepName: string, stepResult: AudioLabStepResult): string {
  return `${stepName}: ${stepResult.status.toUpperCase()} — ${stepResult.summary}`;
}

export function serializeAudioLabReport(report: AudioLabReport): string {
  const lines = [
    `Audio Lab Report`,
    `Version: ${report.appVersion}`,
    `Exported: ${report.exportedAt}`,
    `Location: ${report.locationHref}`,
    '',
    'Audio Session',
    `Supported: ${report.audioSession.supported ? 'yes' : 'no'}`,
    `Type: ${report.audioSession.type ?? 'unknown'}`,
    `State: ${report.audioSession.state ?? 'unknown'}`,
    `History: ${report.audioSession.history.length > 0 ? report.audioSession.history.join(', ') : 'none'}`,
    '',
    'Microphone',
    report.microphone.permissionSummary,
    report.microphone.warmStreamSummary,
    '',
    'Recording',
    `Mode: ${report.recording.mode}`,
    report.recording.summary,
    `Last blob size: ${report.recording.lastBlobSize ?? 'none'}`,
    `Last mime type: ${report.recording.lastMimeType ?? 'none'}`,
    '',
    'Media Controls',
    `Probe mode: ${report.mediaControls.probeMode}`,
    `Play: ${report.mediaControls.counts.play}`,
    `Pause: ${report.mediaControls.counts.pause}`,
    `Stop: ${report.mediaControls.counts.stop}`,
    `Next track: ${report.mediaControls.counts.nexttrack}`,
    `Previous track: ${report.mediaControls.counts.previoustrack}`,
    `Seek forward: ${report.mediaControls.counts.seekforward}`,
    `Seek backward: ${report.mediaControls.counts.seekbackward}`,
    '',
    'Step Results',
    ...Object.entries(report.steps).map(([stepName, stepResult]) => formatStepResult(stepName, stepResult)),
    '',
    'Tester Notes',
    report.testerNotes.trim() || 'No tester notes provided.',
    '',
    'Debug Log',
    serializeDebugLogEntries(report.debugEntries),
  ];

  return lines.join('\n');
}
