import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RuleError } from '../src/errors.js';
import { openDatabase } from '../src/db/database.js';
import { RuleRepository } from '../src/db/rules.js';
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
        expect(rule.hideSender).toBe(true);
        n += 1;
      }
    }
    expect(rules.list()).toHaveLength(9);
    expect(rules.list('9')).toHaveLength(9);
    expect(rules.list('8')).toHaveLength(0);
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
    expect(rules.listActiveBySource('9', '11')).toHaveLength(0);
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
    expect(rules.setHideSender(rule.id, false).hideSender).toBe(false);
    expect(rules.setNotify(rule.id, 'source').notify).toBe('source');
    expect(rules.setHideSender(rule.id, true).hideSender).toBe(true);

    rules.claim(rule.id, '11', 51);
    expect(rules.delete(rule.id, '8')).toBe(false);
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

  it('hides the sender on rules saved before that column existed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'telesyncra-'));
    const file = path.join(dir, 'old.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_kind TEXT NOT NULL,
        source_marked_id TEXT NOT NULL,
        source_raw_id TEXT NOT NULL,
        source_peer_class TEXT NOT NULL,
        source_title TEXT NOT NULL,
        source_username TEXT,
        source_access_hash TEXT,
        dest_kind TEXT NOT NULL,
        dest_marked_id TEXT NOT NULL,
        dest_raw_id TEXT NOT NULL,
        dest_peer_class TEXT NOT NULL,
        dest_title TEXT NOT NULL,
        dest_username TEXT,
        dest_access_hash TEXT,
        status TEXT NOT NULL,
        baseline_message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.prepare(`
      INSERT INTO rules (
        source_kind, source_marked_id, source_raw_id, source_peer_class, source_title, source_username, source_access_hash,
        dest_kind, dest_marked_id, dest_raw_id, dest_peer_class, dest_title, dest_username, dest_access_hash,
        status, baseline_message_id, created_at, updated_at
      ) VALUES ('user', '11', '11', 'user', 'Ada', NULL, '1', 'user', '22', '22', 'user', 'Bea', NULL, '2', 'active', 4, 1, 1)
    `).run();
    raw.close();

    const db = openDatabase(file, '100');
    const rule = new RuleRepository(db).list('100')[0];
    expect(rule?.hideSender).toBe(true);
    expect(rule?.ownerUserId).toBe('100');
    expect(rule?.notify).toBe('off');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
