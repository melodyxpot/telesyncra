import type { TelegramClient } from 'telegram';
import { telegramErrorCode } from './error-code.js';

export class LoginCancelled extends Error {
  constructor() {
    super('Login cancelled');
    this.name = 'LoginCancelled';
  }
}

export function isLoginCancel(error: unknown): boolean {
  if (error instanceof LoginCancelled) return true;
  return error instanceof Error && (error.message === 'AUTH_USER_CANCEL' || error.message === 'Login cancelled');
}

export interface LoginPrompts {
  phone(retry: boolean): Promise<string>;
  code(retry: boolean): Promise<string>;
  password(retry: boolean): Promise<string>;
  rejected(message: string): Promise<void>;
  cancelled(): boolean;
}

/** Collect the phone, code, and two-step password through the caller's prompts. */
export async function runBotLogin(client: TelegramClient, prompts: LoginPrompts): Promise<void> {
  let phoneTries = 0;
  let codeTries = 0;
  let passwordTries = 0;
  await client.start({
    phoneNumber: () => prompts.phone(phoneTries++ > 0),
    phoneCode: () => prompts.code(codeTries++ > 0),
    password: () => prompts.password(passwordTries++ > 0),
    onError: async (error: Error) => {
      if (prompts.cancelled()) return true;
      const code = telegramErrorCode(error);
      if (
        code === 'PHONE_NUMBER_INVALID' ||
        code === 'PHONE_CODE_INVALID' ||
        code === 'PHONE_CODE_EXPIRED' ||
        code === 'PASSWORD_HASH_INVALID'
      ) {
        return false;
      }
      await prompts.rejected(loginFailureText(code));
      return true;
    },
  });
}

export function loginFailureText(code: string): string {
  if (code.startsWith('FLOOD_WAIT')) return 'Telegram asked for a wait. Try signing in again later.';
  if (code === 'PHONE_NUMBER_BANNED') return 'Telegram will not send a login code to that number.';
  if (code === 'API_ID_INVALID') return 'The server API credentials were rejected. The owner needs to check them.';
  return 'Sign-in stopped. Send /start and try again.';
}
