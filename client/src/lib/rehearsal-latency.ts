export const SLOW_PREPARATION_THRESHOLD_MS = 10_000;

export function isSlowPreparation(elapsedMs: number): boolean {
  return elapsedMs >= SLOW_PREPARATION_THRESHOLD_MS;
}
