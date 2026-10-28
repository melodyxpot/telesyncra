import path from 'node:path';
import { Bot, TelegramApiError } from 'node-telegram-bot-api';
import { registerManager } from './bot/manager.js';
import { loadConfig } from './config.js';
import { RECONNECT_INTERVAL_MS } from './constants.js';
import { AccountStore } from './db/accounts.js';
import { openDatabase } from './db/database.js';
import { LogRepository } from './db/logs.js';
import { RuleRepository } from './db/rules.js';
import { createLogger } from './logger.js';
import { acquireProcessLock, ensurePrivateDir, restrictFile } from './security/files.js';
import { AccountPool } from './telegram/account-pool.js';
import { telegramErrorCode } from './telegram/error-code.js';
import { readSession, writeSession } from './telegram/session.js';

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, [config.apiHash, config.botToken]);
  const dataDir = path.dirname(config.databasePath);
  const releaseLock = acquireProcessLock(path.join(dataDir, 'telesyncra.lock'), logger);
  ensurePrivateDir(dataDir, logger);
  const sessionsDir = path.join(dataDir, 'sessions');
  ensurePrivateDir(sessionsDir, logger);
  const database = openDatabase(config.databasePath, config.allowedUserId);
  restrictFile(config.databasePath, logger);
  const rules = new RuleRepository(database);
  const logs = new LogRepository(database);
  const accounts = new AccountStore(database);
  accounts.ensureAdmin(config.allowedUserId);
  importLegacySession(config.sessionPath, path.join(sessionsDir, `${config.allowedUserId}.session`), logger);
  const interrupted = rules.settleInterrupted();
  if (interrupted > 0) {
    logger.warn({ event: 'interrupted_claims', count: interrupted }, 'marked interrupted forwards as not retried');
  }

  const bot = new Bot(config.botToken);
  const pool = new AccountPool(config, rules, logs, logger, sessionsDir, async (userId, text) => {
    await bot.api.sendMessage({ chat_id: userId, text });
  });
  await pool.restore(config.allowedUserId);
  for (const member of accounts.listMembers()) await pool.restore(member.userId);

  registerManager(bot, {
    allowedUserId: config.allowedUserId,
    api: config,
    rules,
    logs,
    accounts,
    pool,
    logger,
  });

  await bot.api
    .setMyCommands({
      commands: [
        { command: 'start', description: 'Open the menu' },
        { command: 'menu', description: 'Open the menu again' },
        { command: 'status', description: 'Connection and rule counts' },
        { command: 'cancel', description: 'Close the current step' },
        { command: 'help', description: 'How forwarding works' },
      ],
    })
    .catch((error: unknown) => {
      logger.warn({ event: 'commands_failed', code: telegramErrorCode(error) }, 'could not publish bot commands');
    });

  await bot.api
    .setChatMenuButton({ menu_button: { type: 'commands' } })
    .catch((error: unknown) => {
      logger.warn({ event: 'menu_button_failed', code: telegramErrorCode(error) }, 'could not set the command menu button');
    });

  let stopping = false;
  let shutdown = (_signal: string): Promise<void> => Promise.resolve();

  const polling = bot.startPolling(undefined, {
    allowedUpdates: ['message', 'callback_query'],
    retry: true,
    onError: (error) => {
      const errorCode = error instanceof TelegramApiError ? error.errorCode : 0;
      logger.warn({ event: 'bot_poll_error', errorCode }, 'bot polling error');
      if (errorCode === 401 || errorCode === 404) {
        logger.error({ event: 'bot_rejected', errorCode }, 'the bot token was rejected');
        void shutdown('bot-auth');
      }
    },
  });
  polling.catch((error: unknown) => {
    logger.error({ event: 'bot_stopped', name: error instanceof Error ? error.name : 'Error' }, 'bot polling stopped');
  });

  const reconnectTimer = setInterval(() => {
    if (stopping) return;
    void pool.reconnectLoose();
  }, RECONNECT_INTERVAL_MS);

  shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'shutdown', signal }, 'shutting down');
    if (reconnectTimer) clearInterval(reconnectTimer);
    bot.stop();
    await Promise.race([polling.catch(() => undefined), delay(5000)]);
    await Promise.race([pool.shutdown(), delay(5000)]);
    database.close();
    releaseLock();
    process.exit(0);
  };

  process.on('unhandledRejection', (error: unknown) => {
    logger.error(
      { event: 'unhandled_rejection', name: error instanceof Error ? error.name : 'Error' },
      'unhandled rejection',
    );
  });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdout.write('Telesyncra is running. Open the management bot and send /start.\n');
  logger.info({ event: 'running', activeRules: rules.counts().active }, 'telesyncra is running');
}

function importLegacySession(legacyPath: string, adminPath: string, logger: ReturnType<typeof createLogger>): void {
  if (path.resolve(legacyPath) === path.resolve(adminPath)) return;
  if (readSession(adminPath).length >= 10) return;
  const legacy = readSession(legacyPath);
  if (legacy.length < 10) return;
  writeSession(adminPath, legacy, logger);
  logger.info({ event: 'legacy_session_imported' }, 'copied the existing login for the admin');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
