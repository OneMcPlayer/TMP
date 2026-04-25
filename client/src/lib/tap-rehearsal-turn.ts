export type TapRehearsalTurnLine = {
  isUserLine: boolean;
  lineNumber: number;
};

export type TapRehearsalTurnCorrection = {
  timestamp: string;
} | null;

export function buildTapUserTurnKey(
  line: TapRehearsalTurnLine | null,
  correction: TapRehearsalTurnCorrection,
): string | null {
  if (!line?.isUserLine) {
    return null;
  }

  return `${line.lineNumber}:${correction?.timestamp ?? 'clean'}`;
}

export function shouldStartTapCoachCueGate(options: {
  completedCoachCueTurnKey: string | null;
  lastOpenedTurnKey: string | null;
  pendingCoachCueTurnKey: string | null;
  turnKey: string | null;
}): boolean {
  return Boolean(
    options.turnKey &&
      options.turnKey !== options.lastOpenedTurnKey &&
      options.turnKey !== options.completedCoachCueTurnKey &&
      options.turnKey !== options.pendingCoachCueTurnKey,
  );
}

export function shouldResolveTapCommittedLine(options: {
  committedLineNumber: number | null;
  currentLine: TapRehearsalTurnLine | null;
  hasCorrection: boolean;
}): boolean {
  return Boolean(
    options.committedLineNumber !== null &&
      (!options.currentLine ||
        options.hasCorrection ||
        options.currentLine.lineNumber !== options.committedLineNumber),
  );
}

export function canOpenTapUserTurn(options: {
  coachAudioPlaying: boolean;
  currentLine: TapRehearsalTurnLine | null;
  dataChannelState: string;
  isControlStatePending: boolean;
  isCommittingTurn: boolean;
  isOpeningTurn: boolean;
  isWaitingForCoachCue: boolean;
  speechQueueLength: number;
  status: string;
}): boolean {
  return (
    options.status === 'connected' &&
    options.dataChannelState === 'open' &&
    Boolean(options.currentLine?.isUserLine) &&
    !options.coachAudioPlaying &&
    options.speechQueueLength === 0 &&
    !options.isWaitingForCoachCue &&
    !options.isControlStatePending &&
    !options.isCommittingTurn &&
    !options.isOpeningTurn
  );
}
