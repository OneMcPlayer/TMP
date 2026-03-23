export interface ScriptLine {
  character: string;
  text: string;
}

export interface RawScriptLine {
  character?: string;
  text?: string;
  speaker?: string;
  line?: string;
}

export interface Script {
  title: string;
  author?: string;
  language?: string;
  lines: ScriptLine[];
}

export interface RawScript {
  title: string;
  author?: string;
  language?: string;
  lines: RawScriptLine[];
}

export interface WordDiff {
  word: string;
  status: 'correct' | 'missing' | 'extra';
}

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
