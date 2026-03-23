import type { WordDiff } from './types';
import { stripStageDirections } from './script-utils';

function normalizeText(text: string): string[] {
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

  return comparableText
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

function levenshteinDistance(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1]
        );
      }
    }
  }

  return dp;
}

export function computeWordDiff(expected: string, spoken: string): WordDiff[] {
  const expectedWords = normalizeText(expected);
  const spokenWords = normalizeText(spoken);
  
  if (expectedWords.length === 0 && spokenWords.length === 0) {
    return [];
  }
  
  if (spokenWords.length === 0) {
    return expectedWords.map(word => ({ word, status: 'missing' }));
  }
  
  if (expectedWords.length === 0) {
    return spokenWords.map(word => ({ word, status: 'extra' }));
  }

  const dp = levenshteinDistance(expectedWords, spokenWords);
  const result: WordDiff[] = [];
  
  let i = expectedWords.length;
  let j = spokenWords.length;
  const operations: Array<{ type: 'match' | 'substitute' | 'insert' | 'delete'; expectedIdx?: number; spokenIdx?: number }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expectedWords[i - 1] === spokenWords[j - 1]) {
      operations.unshift({ type: 'match', expectedIdx: i - 1, spokenIdx: j - 1 });
      i--;
      j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      operations.unshift({ type: 'substitute', expectedIdx: i - 1, spokenIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j] === dp[i][j - 1] + 1)) {
      operations.unshift({ type: 'insert', spokenIdx: j - 1 });
      j--;
    } else {
      operations.unshift({ type: 'delete', expectedIdx: i - 1 });
      i--;
    }
  }

  for (const op of operations) {
    if (op.type === 'match') {
      result.push({ word: expectedWords[op.expectedIdx!], status: 'correct' });
    } else if (op.type === 'substitute') {
      result.push({ word: expectedWords[op.expectedIdx!], status: 'missing' });
      result.push({ word: spokenWords[op.spokenIdx!], status: 'extra' });
    } else if (op.type === 'insert') {
      result.push({ word: spokenWords[op.spokenIdx!], status: 'extra' });
    } else {
      result.push({ word: expectedWords[op.expectedIdx!], status: 'missing' });
    }
  }

  return result;
}

export function calculateAccuracy(diff: WordDiff[]): number {
  if (diff.length === 0) return 100;
  
  const correctCount = diff.filter(d => d.status === 'correct').length;
  const totalExpected = diff.filter(d => d.status === 'correct' || d.status === 'missing').length;
  
  if (totalExpected === 0) return 0;
  return Math.round((correctCount / totalExpected) * 100);
}
