export type {
  RawScript,
  RawScriptLine,
  Script,
  ScriptLine,
  WordDiff,
} from '@shared/rehearsal-core';

import type { WordDiff } from '@shared/rehearsal-core';

export interface LineResult {
  lineIndex: number;
  expectedText: string;
  spokenText: string;
  diff: WordDiff[];
  accuracy: number;
}

export type RehearsalState = 
  | 'idle'
  | 'waiting-for-user'
  | 'recording'
  | 'processing'
  | 'playing-tts'
  | 'playing-correction'
  | 'showing-feedback';

export interface RehearsalLine {
  index: number;
  character: string;
  text: string;
  isUserLine: boolean;
  state: 'pending' | 'active' | 'completed';
  spokenText?: string;
  diff?: WordDiff[];
  accuracy?: number;
  correctionPlayed?: boolean;
}
