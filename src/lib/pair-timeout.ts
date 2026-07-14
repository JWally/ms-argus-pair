const ROUTINE_TIMEOUT_MESSAGES = ["didn't finish scanning", 'session expired'] as const;

export function isPairSessionTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ROUTINE_TIMEOUT_MESSAGES.some((candidate) => message.includes(candidate));
}
