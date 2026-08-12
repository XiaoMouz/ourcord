export function remainingCooldownSeconds(retryUntil: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryUntil - now) / 1000));
}
