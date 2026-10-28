import { afterEach, describe, expect, it } from 'vitest';
import { AlbumBuffer } from '../src/engine/album-buffer.js';
import { ForwardEngine } from '../src/engine/engine.js';
import { createLogger } from '../src/logger.js';
import { inbound, makeChat, memoryDb } from './fixtures.js';

const open: Array<{ close(): void }> = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('duplicate prevention', () => {
  it('claims a message once per rule and blocks an interrupted claim', () => {
    const { db, rules } = memoryDb();
    open.push(db);
    const first = rules.create({
      source: makeChat({ kind: 'user', markedId: '10', rawId: '10' }),
      destination: makeChat({ kind: 'user', markedId: '20', rawId: '20' }),
      selfUserId: '1',
      baselineMessageId: 1,
    });
    const second = rules.create({
      source: makeChat({ kind: 'user', markedId: '10', rawId: '10' }),
      destination: makeChat({ kind: 'group', markedId: '-10030', rawId: '30' }),
      selfUserId: '1',
      baselineMessageId: 1,
    });
    expect(rules.claim(first.id, '10', 5)).toBe(true);
    expect(rules.claim(first.id, '10', 5)).toBe(false);
    expect(rules.claim(second.id, '10', 5)).toBe(true);
    expect(rules.claim(first.id, '10', 6)).toBe(true);
    expect(rules.settleInterrupted()).toBe(3);
    expect(rules.claim(first.id, '10', 5)).toBe(false);
  });

  it('does not call the forwarder again for a message that was already claimed', async () => {
    const { db, rules, logs } = memoryDb();
    open.push(db);
    const rule = rules.create({
      source: makeChat({ kind: 'channel', markedId: '-10010', rawId: '10' }),
      destination: makeChat({ kind: 'user', markedId: '20', rawId: '20' }),
      selfUserId: '1',
      baselineMessageId: 3,
    });
    const calls: number[][] = [];
    const engine = new ForwardEngine({
      rules,
      logs,
      selfUserId: '1',
      nativeForward: async (_source, _destination, ids) => {
        calls.push(ids);
      },
      sleep: async () => undefined,
      logger: createLogger('error'),
      albumDelayMs: 60_000,
    });
    engine.start();
    const message = inbound({ messageId: 8, chatId: rule.sourceMarkedId, senderId: '77' });
    engine.ingest(message, null);
    await engine.idle();
    engine.ingest(message, null);
    await engine.idle();
    expect(calls).toEqual([[8]]);
  });

  it('keeps album parts together until they are flushed', () => {
    const batches: number[][] = [];
    const buffer = new AlbumBuffer(60_000, (messages) => {
      batches.push(messages.map((message) => message.messageId));
    });
    buffer.push(inbound({ messageId: 1, chatId: '5' }), 'album');
    buffer.push(inbound({ messageId: 2, chatId: '5' }), 'album');
    buffer.push(inbound({ messageId: 3, chatId: '5' }), null);
    expect(batches).toEqual([[3]]);
    buffer.flushAll();
    expect(batches).toEqual([[3], [1, 2]]);
  });
});
