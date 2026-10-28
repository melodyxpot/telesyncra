import { MAX_FLOOD_RETRY_SECONDS, MAX_FORWARD_ATTEMPTS } from '../constants.js';
import { floodWaitSeconds, isNetworkError, telegramErrorCode } from '../telegram/error-code.js';

export type ErrorCategory = 'flood_wait' | 'protected' | 'permission' | 'transient' | 'permanent';

export interface ClassifiedError {
  code: string;
  category: ErrorCategory;
  /** True only when Telegram rejected the request before applying it. */
  retryable: boolean;
  retryAfterSeconds: number | null;
  /** Telesyncra never copies or reuploads protected content. */
  allowCopyFallback: false;
}

const PROTECTED = new Set(['CHAT_FORWARDS_RESTRICTED']);

const PERMISSION = new Set([
  'CHAT_WRITE_FORBIDDEN',
  'CHAT_ADMIN_REQUIRED',
  'CHAT_RESTRICTED',
  'CHAT_GUEST_SEND_FORBIDDEN',
  'USER_BANNED_IN_CHANNEL',
  'USER_IS_BLOCKED',
  'YOU_BLOCKED_USER',
  'CHANNEL_PRIVATE',
  'PEER_ID_INVALID',
  'INPUT_USER_DEACTIVATED',
  'USER_PRIVACY_RESTRICTED',
  'PREMIUM_ACCOUNT_REQUIRED',
  'ALLOW_PAYMENT_REQUIRED',
  'VOICE_MESSAGES_FORBIDDEN',
  'USER_NOT_PARTICIPANT',
  'CHANNEL_INVALID',
  'CHAT_ID_INVALID',
  'INPUT_CHANNEL_INVALID',
  'TOPIC_CLOSED',
]);

const PERMANENT = new Set([
  'MESSAGE_ID_INVALID',
  'MSG_ID_INVALID',
  'MESSAGE_EMPTY',
  'MEDIA_INVALID',
  'MISSING_ACCESS_HASH',
]);

export function classifyTelegramError(error: unknown): ClassifiedError {
  const code = telegramErrorCode(error);
  const seconds = floodWaitSeconds(error);
  if (code.startsWith('FLOOD_WAIT') || code.startsWith('SLOWMODE_WAIT')) {
    return result(code, 'flood_wait', true, seconds);
  }
  if (PROTECTED.has(code)) return result(code, 'protected', false, null);
  if (PERMISSION.has(code) || /^CHAT_SEND_.+_FORBIDDEN$/.test(code)) return result(code, 'permission', false, null);
  if (PERMANENT.has(code)) return result(code, 'permanent', false, null);
  if (isNetworkError(error)) return result(code === 'UNKNOWN' ? 'NETWORK' : code, 'transient', false, null);
  if (code === 'UNKNOWN') return result(code, 'transient', false, null);
  return result(code, 'permanent', false, null);
}

export function nextAttempt(
  classified: ClassifiedError,
  attemptsMade: number,
): { action: 'retry'; delayMs: number } | { action: 'stop' } {
  if (!classified.retryable || classified.allowCopyFallback) return { action: 'stop' };
  if (attemptsMade >= MAX_FORWARD_ATTEMPTS) return { action: 'stop' };
  if (classified.retryAfterSeconds === null || classified.retryAfterSeconds > MAX_FLOOD_RETRY_SECONDS) {
    return { action: 'stop' };
  }
  return { action: 'retry', delayMs: classified.retryAfterSeconds * 1000 };
}

function result(
  code: string,
  category: ErrorCategory,
  retryable: boolean,
  retryAfterSeconds: number | null,
): ClassifiedError {
  return { code, category, retryable, retryAfterSeconds, allowCopyFallback: false };
}
