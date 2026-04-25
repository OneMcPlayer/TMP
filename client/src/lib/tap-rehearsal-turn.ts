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

export function canOpenTapUserTurn(options: {
  coachAudioPlaying: boolean;
  currentLine: TapRehearsalTurnLine | null;
  dataChannelState: string;
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
    !options.isCommittingTurn &&
    !options.isOpeningTurn
  );
}
