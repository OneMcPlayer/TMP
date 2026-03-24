export const SLOW_PREPARATION_THRESHOLD_MS = 10_000;
export const PREPARATION_RECOVERY_THRESHOLD_MS = 30_000;

export function isSlowPreparation(elapsedMs: number): boolean {
  return elapsedMs >= SLOW_PREPARATION_THRESHOLD_MS;
}

export function shouldOfferPreparationRecovery(elapsedMs: number): boolean {
  return elapsedMs >= PREPARATION_RECOVERY_THRESHOLD_MS;
}
