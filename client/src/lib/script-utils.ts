import type { RawScript, RawScriptLine, Script, ScriptLine } from './types';

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
  const characterList = Array.from(
    new Set(script.lines.map((line) => line.character)),
  ).join(', ');

  const promptParts = [
    `This is Italian theatrical dialogue from "${script.title}".`,
    script.author ? `Author: ${script.author}.` : '',
    script.language ? `Language: ${script.language}.` : '',
    selectedCharacter ? `The user is rehearsing as ${selectedCharacter}.` : '',
    characterList ? `Character names may include: ${characterList}.` : '',
    'Transcribe the spoken dialogue faithfully.',
    'Ignore stage directions in parentheses and do not over-index on punctuation.',
    `Expected line context: ${expectedText}`,
  ];

  return promptParts.filter(Boolean).join(' ');
}
