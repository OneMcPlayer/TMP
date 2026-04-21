import {
  calculateAccuracy,
  computeWordDiff,
  getSpeakableText,
  tokenizeComparableText,
  type Script,
  type WordDiff,
} from './rehearsal-core';

export type LiveMemorizationCommand = 'continue' | 'repeat' | 'reveal' | 'skip';

export interface LiveMemorizationLine {
  lineIndex: number;
  lineNumber: number;
  character: string;
  text: string;
  speakableText: string;
  isUserLine: boolean;
}

export interface LiveMemorizationController {
  attemptsForCurrentLine: number;
  completionAnnounced: boolean;
  currentLineIndex: number;
  lastSpokenCoachText: string | null;
  lines: LiveMemorizationLine[];
  maxAttemptsPerLine: number;
}

export interface LiveMemorizationAttemptEvaluation {
  accepted: boolean;
  accuracy: number;
  diff: WordDiff[];
  extraWordCount: number;
  missingWordCount: number;
  spokenText: string;
}

export type LiveMemorizationTranscriptOutcome =
  | { type: 'accepted'; evaluation: LiveMemorizationAttemptEvaluation }
  | { attemptsRemaining: number; evaluation: LiveMemorizationAttemptEvaluation; type: 'retry' }
  | { evaluation: LiveMemorizationAttemptEvaluation; revealText: string; type: 'reveal-and-advance' }
  | { line: LiveMemorizationLine | null; type: 'control'; command: LiveMemorizationCommand }
  | { reason: string; type: 'ignored' };

const ACCEPTANCE_ACCURACY_THRESHOLD = 90;
const MAX_EXTRA_WORDS_FOR_ACCEPTED_LINE = 1;

export function clampLiveMemorizationCursor(
  requestedLineNumber: number,
  scriptLength: number,
): number {
  if (!Number.isFinite(requestedLineNumber) || scriptLength <= 0) {
    return 1;
  }

  const clampedLineNumber = Math.max(1, Math.min(Math.floor(requestedLineNumber), scriptLength));
  return clampedLineNumber;
}

export function buildLiveMemorizationController(options: {
  maxAttemptsPerLine: number;
  script: Script;
  selectedCharacter: string;
  startLineNumber: number;
}): LiveMemorizationController {
  const startLineNumber = clampLiveMemorizationCursor(
    options.startLineNumber,
    options.script.lines.length,
  );

  const lines = options.script.lines
    .slice(startLineNumber - 1)
    .map((line, index) => {
      const speakableText = getSpeakableText(line.text);
      return {
        lineIndex: startLineNumber - 1 + index,
        lineNumber: startLineNumber + index,
        character: line.character,
        text: line.text,
        speakableText,
        isUserLine: line.character === options.selectedCharacter,
      };
    })
    .filter((line) => line.speakableText.length > 0);

  return {
    attemptsForCurrentLine: 0,
    completionAnnounced: false,
    currentLineIndex: 0,
    lastSpokenCoachText: null,
    lines,
    maxAttemptsPerLine: Math.max(1, Math.min(Math.floor(options.maxAttemptsPerLine), 5)),
  };
}

export function getCurrentLiveMemorizationLine(
  controller: LiveMemorizationController,
): LiveMemorizationLine | null {
  return controller.lines[controller.currentLineIndex] ?? null;
}

export function getUpcomingUserLine(
  controller: LiveMemorizationController,
): LiveMemorizationLine | null {
  for (let index = controller.currentLineIndex; index < controller.lines.length; index += 1) {
    const line = controller.lines[index];
    if (line?.isUserLine) {
      return line;
    }
  }

  return null;
}

export function shouldAnnounceCompletion(controller: LiveMemorizationController): boolean {
  return !controller.completionAnnounced && controller.currentLineIndex >= controller.lines.length;
}

export function markLiveMemorizationCompletionAnnounced(
  controller: LiveMemorizationController,
): void {
  controller.completionAnnounced = true;
}

export function consumeNextAutomaticSpeech(
  controller: LiveMemorizationController,
): LiveMemorizationLine | null {
  const currentLine = getCurrentLiveMemorizationLine(controller);
  if (!currentLine || currentLine.isUserLine) {
    return null;
  }

  controller.currentLineIndex += 1;
  controller.attemptsForCurrentLine = 0;
  return currentLine;
}

export function advancePastCurrentUserLine(controller: LiveMemorizationController): void {
  const currentLine = getCurrentLiveMemorizationLine(controller);
  if (!currentLine || !currentLine.isUserLine) {
    return;
  }

  controller.currentLineIndex += 1;
  controller.attemptsForCurrentLine = 0;
}

export function rememberLiveMemorizationSpeech(
  controller: LiveMemorizationController,
  text: string,
): void {
  controller.lastSpokenCoachText = text.trim() || null;
}

export function detectLiveMemorizationCommand(
  transcript: string,
): LiveMemorizationCommand | null {
  const normalizedTranscript = tokenizeComparableText(transcript).join(' ');

  if (!normalizedTranscript) {
    return null;
  }

  if (
    normalizedTranscript === 'repeat' ||
    normalizedTranscript === 'again' ||
    normalizedTranscript === 'repeat cue' ||
    normalizedTranscript === 'say it again'
  ) {
    return 'repeat';
  }

  if (
    normalizedTranscript === 'skip' ||
    normalizedTranscript === 'next' ||
    normalizedTranscript === 'go on' ||
    normalizedTranscript === 'continue'
  ) {
    return normalizedTranscript === 'continue' ? 'continue' : 'skip';
  }

  if (
    normalizedTranscript === 'line please' ||
    normalizedTranscript === 'my line' ||
    normalizedTranscript === 'help' ||
    normalizedTranscript === 'give me the line'
  ) {
    return 'reveal';
  }

  return null;
}

export function evaluateLiveMemorizationAttempt(
  expectedText: string,
  spokenText: string,
): LiveMemorizationAttemptEvaluation {
  const diff = computeWordDiff(expectedText, spokenText);
  const accuracy = calculateAccuracy(diff);
  const missingWordCount = diff.filter((item) => item.status === 'missing').length;
  const extraWordCount = diff.filter((item) => item.status === 'extra').length;
  const accepted =
    accuracy >= ACCEPTANCE_ACCURACY_THRESHOLD &&
    missingWordCount === 0 &&
    extraWordCount <= MAX_EXTRA_WORDS_FOR_ACCEPTED_LINE;

  return {
    accepted,
    accuracy,
    diff,
    extraWordCount,
    missingWordCount,
    spokenText,
  };
}

export function processLiveMemorizationTranscript(
  controller: LiveMemorizationController,
  transcript: string,
): LiveMemorizationTranscriptOutcome {
  const currentLine = getCurrentLiveMemorizationLine(controller);
  const command = detectLiveMemorizationCommand(transcript);

  if (command) {
    if ((command === 'skip' || command === 'continue') && currentLine?.isUserLine) {
      advancePastCurrentUserLine(controller);
    }

    return {
      type: 'control',
      command,
      line: currentLine,
    };
  }

  if (!currentLine) {
    return {
      type: 'ignored',
      reason: 'session-complete',
    };
  }

  if (!currentLine.isUserLine) {
    return {
      type: 'ignored',
      reason: 'waiting-for-partner-line',
    };
  }

  const evaluation = evaluateLiveMemorizationAttempt(currentLine.speakableText, transcript);

  if (evaluation.accepted) {
    advancePastCurrentUserLine(controller);
    return {
      type: 'accepted',
      evaluation,
    };
  }

  controller.attemptsForCurrentLine += 1;

  if (controller.attemptsForCurrentLine >= controller.maxAttemptsPerLine) {
    const revealText = currentLine.speakableText;
    advancePastCurrentUserLine(controller);
    return {
      type: 'reveal-and-advance',
      evaluation,
      revealText,
    };
  }

  return {
    type: 'retry',
    evaluation,
    attemptsRemaining: controller.maxAttemptsPerLine - controller.attemptsForCurrentLine,
  };
}
