import type { InboundMessage } from '../types.js';

export class AlbumBuffer {
  private readonly groups = new Map<string, InboundMessage[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: (messages: InboundMessage[]) => void,
  ) {}

  push(message: InboundMessage, groupedId: string | null): void {
    if (!groupedId) {
      this.onFlush([message]);
      return;
    }
    const key = `${message.chatId}:${groupedId}`;
    const existing = this.groups.get(key);
    if (existing) {
      existing.push(message);
      return;
    }
    this.groups.set(key, [message]);
    const timer = setTimeout(() => this.flushKey(key), this.delayMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  flushAll(): void {
    for (const key of [...this.groups.keys()]) this.flushKey(key);
  }

  private flushKey(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const messages = this.groups.get(key);
    this.groups.delete(key);
    if (messages && messages.length > 0) this.onFlush(messages);
  }
}
