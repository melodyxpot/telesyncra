import { ALBUM_BUFFER_MS, FORWARD_GAP_MS, NOTIFY_COOLDOWN_MS } from '../constants.js';
import type { LogRepository } from '../db/logs.js';
import type { RuleRepository } from '../db/rules.js';
import type { Logger } from '../logger.js';
import { kindLabel } from '../telegram/peers.js';
import type { InboundMessage, Rule, StoredPeer } from '../types.js';
import { SerialQueue } from '../util/serial-queue.js';
import { AlbumBuffer } from './album-buffer.js';
import { Cooldown } from './cooldown.js';
import { forwardBatch, type ForwardOutcome } from './forward-batch.js';

export interface EngineDeps {
  rules: RuleRepository;
  logs: LogRepository;
  selfUserId: string;
  nativeForward(source: StoredPeer, destination: StoredPeer, messageIds: number[]): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  notify?: (text: string) => Promise<void>;
  logger: Logger;
  albumDelayMs?: number;
}

export class ForwardEngine {
  private ready = false;
  private stopped = false;
  private readonly buffer: Array<{ message: InboundMessage; groupedId: string | null }> = [];
  private readonly queue = new SerialQueue();
  private readonly albums: AlbumBuffer;
  private readonly cooldown = new Cooldown(NOTIFY_COOLDOWN_MS);

  constructor(private readonly deps: EngineDeps) {
    this.albums = new AlbumBuffer(deps.albumDelayMs ?? ALBUM_BUFFER_MS, (messages) => {
      this.queue.add(() => this.forwardChat(messages));
    });
  }

  ingest(message: InboundMessage, groupedId: string | null): void {
    if (this.stopped) return;
    if (!this.ready) {
      if (this.buffer.length < 200) this.buffer.push({ message, groupedId });
      return;
    }
    this.albums.push(message, groupedId);
  }

  start(): void {
    this.ready = true;
    const pending = this.buffer.splice(0);
    for (const item of pending) this.albums.push(item.message, item.groupedId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = true;
    this.albums.flushAll();
    await this.queue.idle();
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  private async forwardChat(messages: InboundMessage[]): Promise<void> {
    const chatId = messages[0]?.chatId;
    if (!chatId) return;
    const rules = this.deps.rules.listActiveBySource(chatId);
    if (rules.length === 0) return;
    for (const rule of rules) {
      const relevant = messages.filter((message) => message.chatId === rule.sourceMarkedId);
      if (relevant.length === 0) continue;
      try {
        const outcome = await forwardBatch(
          {
            claim: this.deps.rules.claim.bind(this.deps.rules),
            complete: this.deps.rules.complete.bind(this.deps.rules),
            nativeForward: this.deps.nativeForward,
            sleep: this.deps.sleep ?? delay,
          },
          rule,
          relevant,
          this.deps.selfUserId,
        );
        this.record(rule, outcome);
        await (this.deps.sleep ?? delay)(FORWARD_GAP_MS);
      } catch (error) {
        this.deps.logger.error(
          { event: 'forward_failed', ruleId: rule.id, name: error instanceof Error ? error.name : 'Error' },
          'forwarding batch failed',
        );
      }
    }
  }

  private record(rule: Rule, outcome: ForwardOutcome): void {
    if (outcome.forwarded.length > 0) {
      const detail = `count=${outcome.forwarded.length}`;
      this.writeLog(rule, 'info', 'forwarded', detail, outcome.forwarded[0] ?? null);
      this.deps.logger.info(
        {
          event: 'forwarded',
          ruleId: rule.id,
          sourceChatId: rule.sourceMarkedId,
          destinationChatId: rule.destMarkedId,
          count: outcome.forwarded.length,
        },
        'forwarded messages',
      );
    }
    for (const skipped of outcome.skipped) {
      if (skipped.reason === 'protected' || skipped.reason === 'CHAT_FORWARDS_RESTRICTED') {
        this.writeLog(rule, 'warn', 'skipped_protected', skipped.reason, skipped.messageId);
        this.deps.logger.warn(
          { event: 'skipped_protected', ruleId: rule.id, code: skipped.reason },
          'skipped protected content',
        );
        void this.notify(rule, skipped.reason);
      }
    }
    for (const failed of outcome.failed) {
      this.writeLog(rule, 'error', 'forward_error', failed.code, failed.messageId);
      this.deps.logger.error({ event: 'forward_error', ruleId: rule.id, code: failed.code }, 'forward failed');
      void this.notify(rule, failed.code);
    }
  }

  private writeLog(rule: Rule, level: 'info' | 'warn' | 'error', event: string, detail: string, messageId: number | null): void {
    try {
      this.deps.logs.write({
        ruleId: rule.id,
        sourceChatId: rule.sourceMarkedId,
        messageId,
        level,
        event,
        detail,
      });
    } catch {
      this.deps.logger.error({ event: 'log_write_failed', ruleId: rule.id }, 'could not write a forwarding log');
    }
  }

  private async notify(rule: Rule, code: string): Promise<void> {
    if (!this.deps.notify || !this.cooldown.allow(`${rule.id}:${code}`)) return;
    const text = [
      `Rule #${rule.id} (${kindLabel(rule.sourceKind)} → ${kindLabel(rule.destKind)}) could not forward a new message.`,
      `Telegram response: ${code}.`,
      'Telesyncra will not copy the message or try to bypass the restriction.',
    ].join(' ');
    try {
      await this.deps.notify(text);
    } catch {
      this.deps.logger.warn({ event: 'notify_failed', ruleId: rule.id }, 'could not notify the allowed user');
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
