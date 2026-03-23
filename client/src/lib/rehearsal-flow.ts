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
