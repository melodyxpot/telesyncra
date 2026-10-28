import path from 'node:path';
import { Bot, TelegramApiError } from 'node-telegram-bot-api';
import { NewMessage } from 'telegram/events/NewMessage.js';
import { registerManager } from './bot/manager.js';
import { loadConfig } from './config.js';
import { RECONNECT_INTERVAL_MS } from './constants.js';
import { openDatabase } from './db/database.js';
import { LogRepository } from './db/logs.js';
import { RuleRepository } from './db/rules.js';
import { ForwardEngine } from './engine/engine.js';
import { createLogger } from './logger.js';
import { acquireProcessLock, ensurePrivateDir, restrictFile } from './security/files.js';
import { ChatDirectory } from './telegram/directory.js';
import { telegramErrorCode } from './telegram/error-code.js';
import { createNativeForwarder } from './telegram/forward.js';
import { mapIncoming } from './telegram/map-message.js';
import { chatFromRule } from './telegram/peers.js';
import { writeSession } from './telegram/session.js';
import { openUserClient } from './telegram/user-client.js';

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, [config.apiHash, config.botToken]);
  const dataDir = path.dirname(config.databasePath);
  const releaseLock = acquireProcessLock(path.join(dataDir, 'telesyncra.lock'), logger);
  ensurePrivateDir(dataDir, logger);
  const database = openDatabase(config.databasePath);
  restrictFile(config.databasePath, logger);
  const rules = new RuleRepository(database);
  const logs = new LogRepository(database);
  const interrupted = rules.settleInterrupted();
  if (interrupted > 0) {
    logger.warn({ event: 'interrupted_claims', count: interrupted }, 'marked interrupted forwards as not retried');
  }

  const client = await openUserClient(config, logger);
  const selfId = (await client.getMe()).id.toString();
  const directory = new ChatDirectory(client);
  const bot = new Bot(config.botToken);
  const engine = new ForwardEngine({
    rules,
    logs,
    selfUserId: selfId,
    nativeForward: createNativeForwarder(client),
    logger,
    notify: async (text) => {
      await bot.api.sendMessage({ chat_id: config.allowedUserId, text });
    },
  });

  client.addEventHandler((event) => {
    try {
      const mapped = mapIncoming(event.message);
      if (mapped) engine.ingest(mapped.inbound, mapped.groupedId);
    } catch (error) {
      logger.error(
        { event: 'update_failed', name: error instanceof Error ? error.name : 'Error' },
        'could not accept an update',
      );
    }
  }, new NewMessage({ incoming: true }));

  await refreshBaselines(rules, directory, logger);
  engine.start();

  registerManager(bot, {
    allowedUserId: config.allowedUserId,
    rules,
    logs,
    directory,
    selfId: () => selfId,
    connected: () => client.connected === true,
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
    if (stopping || client.connected === true) return;
    logger.warn({ event: 'reconnecting' }, 'user client disconnected; reconnecting');
    client.connect().then(
      () => logger.info({ event: 'reconnected' }, 'user client reconnected'),
      (error: unknown) => logger.error({ event: 'reconnect_failed', code: telegramErrorCode(error) }, 'reconnect failed'),
    );
  }, RECONNECT_INTERVAL_MS);

  shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'shutdown', signal }, 'shutting down');
    if (reconnectTimer) clearInterval(reconnectTimer);
    await engine.stop().catch(() => undefined);
    bot.stop();
    await Promise.race([polling.catch(() => undefined), delay(5000)]);
    await Promise.race([client.disconnect().catch(() => undefined), delay(5000)]);
    const fresh = client.session.save() as unknown as string;
    if (typeof fresh === 'string' && fresh.length >= 10) {
      try {
        writeSession(config.sessionPath, fresh, logger);
      } catch {
        logger.warn({ event: 'session_save_failed' }, 'could not refresh the saved session during shutdown');
      }
    }
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
  logger.info({ event: 'running', selfId, activeRules: rules.counts().active }, 'telesyncra is running');
}

async function refreshBaselines(
  rules: RuleRepository,
  directory: ChatDirectory,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  for (const rule of rules.list()) {
    if (rule.status !== 'active') continue;
    try {
      const baseline = await directory.latestMessageId(chatFromRule(rule, 'source'));
      rules.setBaseline(rule.id, baseline);
      logger.info({ event: 'baseline_refreshed', ruleId: rule.id, baseline }, 'baseline refreshed at startup');
    } catch (error) {
      rules.pause(rule.id);
      logger.error(
        { event: 'baseline_refresh_failed', ruleId: rule.id, code: telegramErrorCode(error) },
        'paused a rule because its source chat could not be read',
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
