import type { RehearsalLine, Script } from './types';

export function buildRehearsalLines(script: Script, selectedCharacter: string): RehearsalLine[] {
  return script.lines.map((line, index) => ({
    index,
    character: line.character,
    text: line.text,
    isUserLine: line.character === selectedCharacter,
    state: 'pending',
  }));
}

export function needsRehearsalLineInitialization(
  rehearsalLines: RehearsalLine[],
  script: Script,
  selectedCharacter: string,
): boolean {
  if (rehearsalLines.length !== script.lines.length) {
    return true;
  }

  return rehearsalLines.some((line, index) => {
    const scriptLine = script.lines[index];
    if (!scriptLine) {
      return true;
    }

    return (
      line.index !== index ||
      line.character !== scriptLine.character ||
      line.text !== scriptLine.text ||
      line.isUserLine !== (scriptLine.character === selectedCharacter)
    );
  });
}

export function buildSkippedUserLine(line: RehearsalLine): RehearsalLine {
  return {
    ...line,
    state: 'completed',
    spokenText: '',
    diff: [],
    accuracy: 0,
    correctionPlayed: false,
  };
}

function resetLineProgress(
  line: RehearsalLine,
  state: RehearsalLine['state'],
): RehearsalLine {
  return {
    ...line,
    state,
    spokenText: undefined,
    diff: undefined,
    accuracy: undefined,
    correctionPlayed: false,
  };
}

function completeLineForNavigation(line: RehearsalLine): RehearsalLine {
  if (line.state === 'completed') {
    return line;
  }

  return line.isUserLine ? buildSkippedUserLine(line) : resetLineProgress(line, 'completed');
}

export function buildNavigationTargetLines(
  lines: RehearsalLine[],
  targetIndex: number,
): RehearsalLine[] {
  return lines.map((line, index) => {
    if (index < targetIndex) {
      return completeLineForNavigation(line);
    }

    return resetLineProgress(line, 'pending');
  });
}
