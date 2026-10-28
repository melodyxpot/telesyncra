import { TelegramClient } from 'telegram';
import { Logger as GramLogger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import { APP_VERSION } from '../constants.js';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import { authorize } from './auth.js';
import { readSession, writeSession } from './session.js';

export async function openUserClient(config: AppConfig, logger: Logger): Promise<TelegramClient> {
  const saved = readSession(config.sessionPath);
  const client = createClient(config, saved);
  try {
    await authorize(client, saved.length > 0, logger);
  } catch (error) {
    await client.disconnect().catch(() => undefined);
    throw error;
  }
  const fresh = client.session.save() as unknown as string;
  if (typeof fresh !== 'string' || fresh.length < 10) {
    await client.disconnect().catch(() => undefined);
    throw new AppError('Telegram did not return a session to save. Nothing was overwritten.');
  }
  writeSession(config.sessionPath, fresh, logger);
  const me = await client.getMe();
  logger.info({ event: 'user_client_ready', selfId: me.id.toString() }, 'user client is ready');
  return client;
}

function createClient(config: AppConfig, session: string): TelegramClient {
  return new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
    connectionRetries: 10,
    reconnectRetries: 100,
    retryDelay: 2000,
    autoReconnect: true,
    requestRetries: 3,
    floodSleepThreshold: 15,
    deviceModel: 'Telesyncra',
    appVersion: APP_VERSION,
    systemVersion: process.platform,
    baseLogger: new GramLogger(LogLevel.NONE),
  });
}
