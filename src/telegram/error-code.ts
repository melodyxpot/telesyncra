const NAMED_CODE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function telegramErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';
  const record = error as { errorMessage?: unknown; message?: unknown; code?: unknown };
  const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage : '';
  if (/^[A-Z0-9_]+$/.test(errorMessage) && errorMessage.length > 0) return errorMessage;
  const message = typeof record.message === 'string' ? record.message : '';
  const flood = /(?:FLOOD_WAIT|SLOWMODE_WAIT)_\d+/.exec(`${errorMessage} ${message}`);
  if (flood) return flood[0];
  const named = NAMED_CODE.exec(message);
  if (named?.[1]) return named[1];
  if (typeof record.code === 'string' && record.code.length > 0) return record.code;
  return 'UNKNOWN';
}

export function floodWaitSeconds(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const seconds = (error as { seconds?: unknown }).seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  const match = /(?:FLOOD_WAIT|SLOWMODE_WAIT)_(\d+)/.exec(telegramErrorCode(error));
  return match?.[1] ? Number(match[1]) : null;
}

export function isNetworkError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && NETWORK_CODES.has(record.code)) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /timeout|timed out|network|socket|not connected|connection closed|ECONNRESET/i.test(message);
}
