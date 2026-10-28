import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events/NewMessage.js';
import type { LogRepository } from '../db/logs.js';
import type { RuleRepository } from '../db/rules.js';
import { ForwardEngine } from '../engine/engine.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Rule } from '../types.js';
import type { AppConfig } from '../config.js';
import { ChatDirectory } from './directory.js';
import { telegramErrorCode } from './error-code.js';
import { createNativeForwarder } from './forward.js';
import { mapIncoming } from './map-message.js';
import { chatFromRule, toInputPeer } from './peers.js';
import { readSession, writeSession } from './session.js';
import { notifySides, statusNotice, type StatusEvent } from './status-notice.js';
import { createTelegramClient } from './user-client.js';

interface Runtime {
  client: TelegramClient;
  directory: ChatDirectory;
  engine: ForwardEngine;
  selfId: string;
}

export class AccountPool {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly config: Pick<AppConfig, 'apiId' | 'apiHash'>,
    private readonly rules: RuleRepository,
    private readonly logs: LogRepository,
    private readonly logger: Logger,
    private readonly sessionsDir: string,
    private readonly notifyOwner: (userId: string, text: string) => Promise<void>,
  ) {}

  directory(userId: string): ChatDirectory | null {
    return this.runtimes.get(userId)?.directory ?? null;
  }

  selfId(userId: string): string | null {
    return this.runtimes.get(userId)?.selfId ?? null;
  }

  connected(userId: string): boolean {
    return this.runtimes.get(userId)?.client.connected === true;
  }

  async restore(userId: string): Promise<void> {
    const saved = readSession(this.sessionPath(userId));
    if (saved.length < 10) return;
    const client = createTelegramClient(this.config, saved);
    try {
      await client.connect();
      const me = await client.getMe();
      if (me.id.toString() !== userId) {
        await client.disconnect().catch(() => undefined);
        this.logger.warn({ event: 'session_user_mismatch', userId }, 'saved session belongs to a different account');
        return;
      }
      await this.attach(userId, client);
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      this.logger.warn(
        { event: 'session_restore_failed', userId, code: telegramErrorCode(error) },
        'could not restore a saved session',
      );
    }
  }

  async adopt(userId: string, client: TelegramClient): Promise<void> {
    const previous = this.runtimes.get(userId);
    if (previous && previous.client !== client) {
      await previous.engine.stop().catch(() => undefined);
      await previous.client.disconnect().catch(() => undefined);
    }
    const fresh = client.session.save() as unknown as string;
    if (typeof fresh !== 'string' || fresh.length < 10) {
      throw new AppError('Telegram did not return a session to save.');
    }
    writeSession(this.sessionPath(userId), fresh, this.logger);
    await this.attach(userId, client);
  }

  async drop(userId: string): Promise<void> {
    const runtime = this.runtimes.get(userId);
    this.runtimes.delete(userId);
    if (runtime) {
      await runtime.engine.stop().catch(() => undefined);
      await runtime.client.disconnect().catch(() => undefined);
    }
    const file = this.sessionPath(userId);
    if (existsSync(file)) unlinkSync(file);
  }

  async announce(userId: string, rule: Rule, event: StatusEvent): Promise<void> {
    const runtime = this.runtimes.get(userId);
    if (!runtime) return;
    const message = statusNotice(rule, event);
    for (const side of notifySides(rule.notify)) {
      try {
        await runtime.client.sendMessage(toInputPeer(chatFromRule(rule, side)), { message, parseMode: 'html' });
      } catch (error) {
        this.logger.warn(
          { event: 'status_notice_failed', ruleId: rule.id, code: telegramErrorCode(error) },
          'could not send a status notice',
        );
      }
    }
  }

  async reconnectLoose(): Promise<void> {
    for (const [userId, runtime] of this.runtimes) {
      if (runtime.client.connected === true) continue;
      this.logger.warn({ event: 'reconnecting', userId }, 'user client disconnected; reconnecting');
      await runtime.client.connect().then(
        () => this.logger.info({ event: 'reconnected', userId }, 'user client reconnected'),
        (error: unknown) =>
          this.logger.error({ event: 'reconnect_failed', userId, code: telegramErrorCode(error) }, 'reconnect failed'),
      );
    }
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.engine.stop().catch(() => undefined);
      const fresh = runtime.client.session.save() as unknown as string;
      if (typeof fresh === 'string' && fresh.length >= 10) {
        try {
          writeSession(this.sessionPath(runtime.selfId), fresh, this.logger);
        } catch {
          this.logger.warn({ event: 'session_save_failed', userId: runtime.selfId }, 'could not refresh a saved session');
        }
      }
      await runtime.client.disconnect().catch(() => undefined);
    }
    this.runtimes.clear();
  }

  private async attach(userId: string, client: TelegramClient): Promise<void> {
    const me = await client.getMe();
    const selfId = me.id.toString();
    if (selfId !== userId) throw new AppError('Sign in with the same Telegram account that is chatting with this bot.');
    const directory = new ChatDirectory(client);
    const engine = new ForwardEngine({
      rules: this.rules,
      logs: this.logs,
      selfUserId: selfId,
      nativeForward: createNativeForwarder(client),
      logger: this.logger,
      notify: async (text) => {
        await this.notifyOwner(userId, text);
      },
    });
    await refreshBaselines(this.rules, directory, selfId, this.logger);
    client.addEventHandler((event) => {
      try {
        const mapped = mapIncoming(event.message);
        if (mapped) engine.ingest(mapped.inbound, mapped.groupedId);
      } catch (error) {
        this.logger.error(
          { event: 'update_failed', userId, name: error instanceof Error ? error.name : 'Error' },
          'could not accept an update',
        );
      }
    }, new NewMessage({ incoming: true }));
    engine.start();
    this.runtimes.set(userId, { client, directory, engine, selfId });
    this.logger.info({ event: 'user_client_ready', userId }, 'user client is ready');
  }

  private sessionPath(userId: string): string {
    if (!/^[1-9]\d{0,19}$/.test(userId)) throw new AppError('Account id is invalid.');
    return path.join(this.sessionsDir, `${userId}.session`);
  }
}

async function refreshBaselines(
  rules: RuleRepository,
  directory: ChatDirectory,
  ownerUserId: string,
  logger: Logger,
): Promise<void> {
  for (const rule of rules.list(ownerUserId)) {
    if (rule.status !== 'active') continue;
    try {
      const baseline = await directory.latestMessageId(chatFromRule(rule, 'source'));
      rules.setBaseline(rule.id, baseline);
      logger.info({ event: 'baseline_refreshed', ruleId: rule.id, baseline }, 'baseline refreshed at startup');
    } catch (error) {
      rules.pause(rule.id, ownerUserId);
      logger.error(
        { event: 'baseline_refresh_failed', ruleId: rule.id, code: telegramErrorCode(error) },
        'paused a rule because its source chat could not be read',
      );
    }
  }
}
