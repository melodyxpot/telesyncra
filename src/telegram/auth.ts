import { password as promptPassword, text as promptText } from 'input';
import { TelegramClient } from 'telegram';
import { MAX_AUTH_ATTEMPTS } from '../constants.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { isNetworkError, telegramErrorCode } from './error-code.js';

export async function authorize(client: TelegramClient, hadSession: boolean, logger: Logger): Promise<void> {
  if (!client.connected) await client.connect();
  const probe = await probeAuthorization(client);
  if (probe === 'authorized') {
    logger.info({ event: 'session_reused' }, 'reused the saved Telegram session');
    return;
  }
  if (probe === 'unreachable') {
    throw new AppError(
      'Could not reach Telegram to check the saved session. The session file was not deleted. Check the network and start again.',
    );
  }
  if (hadSession) {
    logger.warn({ event: 'session_unauthorized' }, 'saved session is no longer authorized');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AppError(
      'No valid saved session. Run Telesyncra in an interactive terminal once to log in. The login code stays in that terminal.',
    );
  }
  process.stdout.write(
    '\nTelegram login\nThe login code and two-step password are entered in this terminal only.\nThey are not written to logs, the database, or the management bot.\n\n',
  );
  let attempts = 0;
  await client.start({
    phoneNumber: promptPhone,
    phoneCode: promptCode,
    password: promptTwoFactor,
    onError: (error: Error) => {
      attempts += 1;
      const code = telegramErrorCode(error);
      logger.warn({ event: 'login_attempt_failed', code, attempt: attempts }, 'login attempt failed');
      process.stdout.write(`Login failed (${code}).\n`);
      const stop =
        attempts >= MAX_AUTH_ATTEMPTS ||
        code === 'API_ID_INVALID' ||
        code === 'API_ID_PUBLISHED_FLOOD' ||
        code.startsWith('FLOOD_WAIT');
      return Promise.resolve(stop);
    },
  });
  logger.info({ event: 'login_succeeded' }, 'Telegram account authorized');
}

async function probeAuthorization(client: TelegramClient): Promise<'authorized' | 'unauthorized' | 'unreachable'> {
  try {
    const { Api } = await import('telegram');
    await client.invoke(new Api.updates.GetState());
    return 'authorized';
  } catch (error) {
    if (isNetworkError(error)) return 'unreachable';
    const httpCode = typeof error === 'object' && error !== null && 'code' in error ? Number(error.code) : 0;
    const name = telegramErrorCode(error);
    if (httpCode === 401 || /AUTH|SESSION|UNAUTHORIZED/.test(name)) return 'unauthorized';
    return 'unreachable';
  }
}

async function promptPhone(): Promise<string> {
  for (;;) {
    const raw = await promptText('Phone number (international format, for example +15551234567): ');
    const phone = raw.trim().replace(/[\s()-]/g, '');
    if (/^\+\d{8,15}$/.test(phone)) return phone;
    process.stdout.write('Use international format, for example +15551234567.\n');
  }
}

async function promptCode(): Promise<string> {
  for (;;) {
    const code = (await promptText('Telegram login code: ')).replace(/\s+/g, '');
    if (/^\d{5,6}$/.test(code)) return code;
    process.stdout.write('Enter the numeric code Telegram sent you.\n');
  }
}

async function promptTwoFactor(hint?: string): Promise<string> {
  process.stdout.write('Two-step verification is enabled.\n');
  const suffix = hint ? ` Hint: ${hint}` : '';
  for (;;) {
    const value = await promptPassword(`2FA password:${suffix} `);
    if (value.length > 0) return value;
    process.stdout.write('The password cannot be empty.\n');
  }
}
