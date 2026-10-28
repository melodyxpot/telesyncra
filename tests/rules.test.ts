import { afterEach, describe, expect, it } from 'vitest';
import { RuleError } from '../src/errors.js';
import { assertRulePair, markedIdFor } from '../src/telegram/peers.js';
import { KINDS, makeChat, memoryDb } from './fixtures.js';

const open: Array<{ close(): void }> = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('rule creation', () => {
  it('accepts every source and destination combination', () => {
    const { db, rules } = memoryDb();
    open.push(db);
    let n = 1;
    for (const sourceKind of KINDS) {
      for (const destKind of KINDS) {
        const source = makeChat({ kind: sourceKind, markedId: String(1000 + n), rawId: String(1000 + n) });
        const destination = makeChat({ kind: destKind, markedId: String(2000 + n), rawId: String(2000 + n) });
        expect(() => assertRulePair(source, destination, '9')).not.toThrow();
        const rule = rules.create({ source, destination, selfUserId: '9', baselineMessageId: 20 + n });
        expect(rule.status).toBe('active');
        expect(rule.sourceKind).toBe(sourceKind);
        expect(rule.destKind).toBe(destKind);
        expect(rule.baselineMessageId).toBe(20 + n);
        n += 1;
      }
    }
    expect(rules.list()).toHaveLength(9);
    expect(rules.counts()).toEqual({ active: 9, paused: 0 });
  });

  it('allows a basic group without an access hash', () => {
    const source = makeChat({
      kind: 'group',
      peerClass: 'chat',
      markedId: '-15',
      rawId: '15',
      accessHash: null,
    });
    const destination = makeChat({ kind: 'user', markedId: '42', rawId: '42' });
    expect(() => assertRulePair(source, destination, '7')).not.toThrow();
  });

  it('rejects identical chats, your own account, and missing access hashes', () => {
    const source = makeChat({ kind: 'user', markedId: '5', rawId: '5' });
    expect(() => assertRulePair(source, source, '9')).toThrow(RuleError);
    expect(() => assertRulePair({ ...source, self: true }, makeChat({ kind: 'user', markedId: '8', rawId: '8' }), '9')).toThrow(
      /own account/,
    );
    expect(() => assertRulePair(source, makeChat({ kind: 'user', markedId: '8', rawId: '8' }), '5')).toThrow(/own account/);
    expect(() =>
      assertRulePair(
        makeChat({ kind: 'channel', markedId: '-1005', rawId: '5', accessHash: null }),
        makeChat({ kind: 'user', markedId: '8', rawId: '8' }),
        '9',
      ),
    ).toThrow(/access information/);
  });

  it('rejects a duplicate pair and supports pause, edit, and delete', () => {
    const { db, rules } = memoryDb();
    open.push(db);
    const source = makeChat({ kind: 'user', markedId: '11', rawId: '11', title: 'Ada' });
    const destination = makeChat({ kind: 'group', markedId: '-10022', rawId: '22', title: 'Ops' });
    const rule = rules.create({ source, destination, selfUserId: '9', baselineMessageId: 4 });
    expect(() => rules.create({ source, destination, selfUserId: '9', baselineMessageId: 4 })).toThrow(/already exists/);

    expect(rules.pause(rule.id).status).toBe('paused');
    expect(rules.listActiveBySource('11')).toHaveLength(0);
    const started = rules.activate(rule.id, 40);
    expect(started.status).toBe('active');
    expect(started.baselineMessageId).toBe(40);

    const edited = rules.updateEndpoint(
      rule.id,
      'dest',
      makeChat({ kind: 'channel', markedId: '-10033', rawId: '33', title: 'News' }),
      50,
      '9',
    );
    expect(edited.destMarkedId).toBe('-10033');
    expect(edited.baselineMessageId).toBe(50);
    expect(edited.sourceMarkedId).toBe('11');

    rules.claim(rule.id, '11', 51);
    expect(rules.delete(rule.id)).toBe(true);
    expect(rules.get(rule.id)).toBeNull();
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM processed_messages').get() as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('builds the same marked ids Telegram uses for users, groups, and channels', () => {
    expect(markedIdFor('user', '42')).toBe('42');
    expect(markedIdFor('chat', '42')).toBe('-42');
    expect(markedIdFor('channel', '42')).toBe('-10042');
  });
});
