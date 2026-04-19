import { serializeDebugLogEntries, type DebugLogEntry } from './debug-log';
import { serializeRealtimeServerLogs, type RealtimeServerLogEntry } from './realtime-call-lab';
import { getSpeakableText } from './script-utils';
import type { Script } from './types';

export interface LiveMemorizationOptions {
  maxAttemptsPerLine: number;
  script: Script;
  selectedCharacter: string;
  startLineNumber: number;
}

export interface LiveMemorizationReport {
  version: string;
  exportedAt: string;
  backendBaseUrl: string;
  selectedCharacter: string;
  startLineNumber: number;
  maxAttemptsPerLine: number;
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
  activeResponseId?: string | null;
  notes?: string;
  localLogs: DebugLogEntry[];
  serverLogs: RealtimeServerLogEntry[];
}

interface LiveMemorizationLine {
  character: string;
  lineNumber: number;
  role: 'partner' | 'user';
  speakableText: string;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampLiveMemorizationStartLine(startLineNumber: number, scriptLength: number): number {
  if (!Number.isFinite(startLineNumber)) {
    return 1;
  }

  if (scriptLength <= 0) {
    return 1;
  }

  return clampNumber(Math.floor(startLineNumber), 1, scriptLength);
}

export function clampLiveMemorizationAttempts(maxAttemptsPerLine: number): number {
  if (!Number.isFinite(maxAttemptsPerLine)) {
    return 3;
  }

  return clampNumber(Math.floor(maxAttemptsPerLine), 1, 5);
}

function buildLiveMemorizationLines(options: LiveMemorizationOptions): LiveMemorizationLine[] {
  const startLineNumber = clampLiveMemorizationStartLine(
    options.startLineNumber,
    options.script.lines.length,
  );

  return options.script.lines.slice(startLineNumber - 1).map((line, index) => {
    const speakableText = getSpeakableText(line.text);

    return {
      character: line.character,
      lineNumber: startLineNumber + index,
      role: line.character === options.selectedCharacter ? 'user' : 'partner',
      speakableText: speakableText || '[skip this nonverbal beat]',
    };
  });
}

export function buildLiveMemorizationGreetingPrompt(options: LiveMemorizationOptions): string {
  const startLineNumber = clampLiveMemorizationStartLine(
    options.startLineNumber,
    options.script.lines.length,
  );

  return [
    `Start the live memorization session now from line ${startLineNumber}.`,
    `The user is rehearsing ${options.selectedCharacter}.`,
    'If the next scripted beat belongs to a partner character, speak it now.',
    'If the next scripted beat belongs to the user, invite them to say it.',
    'Keep the opening concise and immediately enter the drill.',
  ].join(' ');
}

export function buildLiveMemorizationInstructions(options: LiveMemorizationOptions): string {
  const startLineNumber = clampLiveMemorizationStartLine(
    options.startLineNumber,
    options.script.lines.length,
  );
  const maxAttemptsPerLine = clampLiveMemorizationAttempts(options.maxAttemptsPerLine);
  const formattedLines = buildLiveMemorizationLines({
    ...options,
    startLineNumber,
    maxAttemptsPerLine,
  })
    .map(
      (line) =>
        `${line.lineNumber}. [${line.role.toUpperCase()}] ${line.character}: ${line.speakableText}`,
    )
    .join('\n');

  return [
    `You are running a live memorization rehearsal for the play "${options.script.title}".`,
    options.script.author ? `Author: ${options.script.author}.` : '',
    options.script.language ? `Language: ${options.script.language}.` : '',
    `The human performer is rehearsing the role ${options.selectedCharacter}.`,
    `Begin at scripted line ${startLineNumber}.`,
    '',
    'Rules:',
    '- Speak only lines marked [PARTNER], unless you are revealing the user line after too many failed attempts or the user explicitly asks for the answer.',
    '- When the next line is marked [USER], stop speaking and wait for the human to say it.',
    '- Be fairly strict about the wording and meaning because this is for memorization, but ignore punctuation and tiny hesitations.',
    `- If the user misses or mangles the line, coach them briefly and ask for another try. Allow up to ${maxAttemptsPerLine} attempts before you reveal the expected line once and then continue.`,
    '- If the user says "repeat", repeat the current cue once.',
    '- If the user says "skip", move on to the next scripted beat without arguing.',
    '- If the user says "line please" or asks for help, reveal only their next expected line once, then resume the drill.',
    '- Keep every spoken reply concise, natural, and easy to hear while driving.',
    '- Stay inside the script. Do not invent new dialogue, summaries, or analysis.',
    '- When the script is finished, say that the memorization pass is complete.',
    '',
    'Script from the chosen starting point:',
    formattedLines,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildLiveMemorizationPreviewLines(
  options: LiveMemorizationOptions,
  maxLines: number = 12,
): string[] {
  return buildLiveMemorizationLines(options)
    .slice(0, Math.max(1, maxLines))
    .map(
      (line) =>
        `${line.lineNumber}. [${line.role.toUpperCase()}] ${line.character}: ${line.speakableText}`,
    );
}

export function buildLiveMemorizationRepeatPrompt(): string {
  return 'Repeat the current scripted cue once from the current place in the scene, then wait for my line.';
}

export function buildLiveMemorizationContinuePrompt(): string {
  return 'Continue the memorization session from the current place in the script now.';
}

export function buildLiveMemorizationRevealPrompt(): string {
  return 'Reveal only my next expected line once, then resume the memorization drill from the same place.';
}

export function serializeLiveMemorizationReport(report: LiveMemorizationReport): string {
  return [
    'Live Memorization Report',
    `Version: ${report.version}`,
    `Exported: ${report.exportedAt}`,
    `Backend: ${report.backendBaseUrl || 'not configured'}`,
    `Character: ${report.selectedCharacter}`,
    `Start Line: ${report.startLineNumber}`,
    `Max Attempts: ${report.maxAttemptsPerLine}`,
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
    `Active response: ${report.activeResponseId ?? 'none'}`,
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
