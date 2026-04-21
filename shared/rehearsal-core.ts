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

function normalizeLine(rawLine: RawScriptLine): ScriptLine {
  const character = rawLine.character ?? rawLine.speaker;
  const text = rawLine.text ?? rawLine.line;

  if (!character || !text) {
    throw new Error('Invalid script line: each line needs a speaker/character and line/text value.');
  }

  return {
    character: character.trim(),
    text: text.trim(),
  };
}

export function normalizeScript(rawScript: RawScript): Script {
  if (!rawScript.title || !Array.isArray(rawScript.lines)) {
    throw new Error('Invalid script: missing title or lines.');
  }

  return {
    title: rawScript.title.trim(),
    author: rawScript.author?.trim(),
    language: rawScript.language?.trim(),
    lines: rawScript.lines.map(normalizeLine),
  };
}

export function stripStageDirections(text: string): string {
  let cleaned = text;
  let previous = '';

  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned.replace(/\([^()]*\)/g, ' ');
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

export function getSpeakableText(text: string): string {
  return stripStageDirections(text).replace(/\s+/g, ' ').trim();
}

export function buildTranscriptionPrompt(
  script: Script,
  selectedCharacter: string | null,
  expectedText: string,
): string {
  const characterList = Array.from(new Set(script.lines.map((line) => line.character))).join(', ');

  const promptParts = [
    `This is Italian theatrical dialogue from "${script.title}".`,
    script.author ? `Author: ${script.author}.` : '',
    script.language ? `Language: ${script.language}.` : '',
    selectedCharacter ? `The user is rehearsing as ${selectedCharacter}.` : '',
    characterList ? `Character names may include: ${characterList}.` : '',
    'Transcribe the spoken dialogue faithfully.',
    'Ignore stage directions in parentheses and do not over-index on punctuation.',
    expectedText ? `Expected line context: ${expectedText}` : '',
  ];

  return promptParts.filter(Boolean).join(' ');
}

export function tokenizeComparableText(text: string): string[] {
  const comparableText = stripStageDirections(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!comparableText) {
    return [];
  }

  return comparableText.split(/\s+/).filter((word) => word.length > 0);
}

function levenshteinDistance(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i += 1) {
    dp[i][0] = i;
  }

  for (let j = 0; j <= n; j += 1) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp;
}

export function computeWordDiff(expected: string, spoken: string): WordDiff[] {
  const expectedWords = tokenizeComparableText(expected);
  const spokenWords = tokenizeComparableText(spoken);

  if (expectedWords.length === 0 && spokenWords.length === 0) {
    return [];
  }

  if (spokenWords.length === 0) {
    return expectedWords.map((word) => ({ word, status: 'missing' }));
  }

  if (expectedWords.length === 0) {
    return spokenWords.map((word) => ({ word, status: 'extra' }));
  }

  const dp = levenshteinDistance(expectedWords, spokenWords);
  const result: WordDiff[] = [];

  let i = expectedWords.length;
  let j = spokenWords.length;
  const operations: Array<{
    type: 'match' | 'substitute' | 'insert' | 'delete';
    expectedIdx?: number;
    spokenIdx?: number;
  }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expectedWords[i - 1] === spokenWords[j - 1]) {
      operations.unshift({ type: 'match', expectedIdx: i - 1, spokenIdx: j - 1 });
      i -= 1;
      j -= 1;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      operations.unshift({ type: 'substitute', expectedIdx: i - 1, spokenIdx: j - 1 });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j] === dp[i][j - 1] + 1)) {
      operations.unshift({ type: 'insert', spokenIdx: j - 1 });
      j -= 1;
    } else {
      operations.unshift({ type: 'delete', expectedIdx: i - 1 });
      i -= 1;
    }
  }

  for (const operation of operations) {
    if (operation.type === 'match') {
      result.push({ word: expectedWords[operation.expectedIdx!], status: 'correct' });
    } else if (operation.type === 'substitute') {
      result.push({ word: expectedWords[operation.expectedIdx!], status: 'missing' });
      result.push({ word: spokenWords[operation.spokenIdx!], status: 'extra' });
    } else if (operation.type === 'insert') {
      result.push({ word: spokenWords[operation.spokenIdx!], status: 'extra' });
    } else {
      result.push({ word: expectedWords[operation.expectedIdx!], status: 'missing' });
    }
  }

  return result;
}

export function calculateAccuracy(diff: WordDiff[]): number {
  if (diff.length === 0) {
    return 100;
  }

  const correctCount = diff.filter((item) => item.status === 'correct').length;
  const totalExpected = diff.filter(
    (item) => item.status === 'correct' || item.status === 'missing',
  ).length;

  if (totalExpected === 0) {
    return 0;
  }

  return Math.round((correctCount / totalExpected) * 100);
}
