import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'group', 'channel')),
  source_marked_id TEXT NOT NULL,
  source_raw_id TEXT NOT NULL,
  source_peer_class TEXT NOT NULL CHECK (source_peer_class IN ('user', 'chat', 'channel')),
  source_title TEXT NOT NULL,
  source_username TEXT,
  source_access_hash TEXT,
  dest_kind TEXT NOT NULL CHECK (dest_kind IN ('user', 'group', 'channel')),
  dest_marked_id TEXT NOT NULL,
  dest_raw_id TEXT NOT NULL,
  dest_peer_class TEXT NOT NULL CHECK (dest_peer_class IN ('user', 'chat', 'channel')),
  dest_title TEXT NOT NULL,
  dest_username TEXT,
  dest_access_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
  hide_sender INTEGER NOT NULL DEFAULT 1 CHECK (hide_sender IN (0, 1)),
  notify TEXT NOT NULL DEFAULT 'off' CHECK (notify IN ('off', 'source', 'dest', 'both')),
  owner_user_id TEXT NOT NULL,
  baseline_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, source_marked_id, dest_marked_id)
);

CREATE TABLE IF NOT EXISTS processed_messages (
  rule_id INTEGER NOT NULL,
  source_chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'forwarded', 'skipped', 'error')),
  error_code TEXT,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, source_chat_id, message_id),
  FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS forward_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER,
  owner_user_id TEXT,
  source_chat_id TEXT,
  message_id INTEGER,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  display_name TEXT NOT NULL,
  username TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_forward_logs_created ON forward_logs (created_at DESC);
`;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string, adminUserId = '0') {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.ensureHideSender();
    this.ensureLogOwner(adminUserId);
    this.ensureRuleOwnership(adminUserId);
    this.db.exec('DROP INDEX IF EXISTS idx_rules_source_status;');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_rules_source_status ON rules (owner_user_id, source_marked_id, status);');
  }

  /** Older log rows belong to the admin. New rows record the rule owner. */
  private ensureLogOwner(adminUserId: string): void {
    if (this.columnSet('forward_logs').has('owner_user_id')) {
      this.db.prepare(`UPDATE forward_logs SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(adminUserId);
      return;
    }
    this.db.exec('ALTER TABLE forward_logs ADD COLUMN owner_user_id TEXT');
    this.db.prepare(`UPDATE forward_logs SET owner_user_id = ? WHERE owner_user_id IS NULL`).run(adminUserId);
  }

  /**
   * Older rule tables had one shared list. Those rules become the admin's,
   * notifications stay off, and two people may forward the same pair.
   */
  private ensureRuleOwnership(adminUserId: string): void {
    const columns = this.columnSet('rules');
    const definition = this.tableSql('rules');
    const owned =
      columns.has('owner_user_id') &&
      columns.has('notify') &&
      definition.includes('owner_user_id, source_marked_id, dest_marked_id');
    if (owned) return;
    const rows = this.db.prepare('SELECT * FROM rules').all();
    this.db.exec('PRAGMA foreign_keys = OFF;');
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE rules_owned (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('user', 'group', 'channel')),
          source_marked_id TEXT NOT NULL,
          source_raw_id TEXT NOT NULL,
          source_peer_class TEXT NOT NULL CHECK (source_peer_class IN ('user', 'chat', 'channel')),
          source_title TEXT NOT NULL,
          source_username TEXT,
          source_access_hash TEXT,
          dest_kind TEXT NOT NULL CHECK (dest_kind IN ('user', 'group', 'channel')),
          dest_marked_id TEXT NOT NULL,
          dest_raw_id TEXT NOT NULL,
          dest_peer_class TEXT NOT NULL CHECK (dest_peer_class IN ('user', 'chat', 'channel')),
          dest_title TEXT NOT NULL,
          dest_username TEXT,
          dest_access_hash TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
          hide_sender INTEGER NOT NULL DEFAULT 1 CHECK (hide_sender IN (0, 1)),
          notify TEXT NOT NULL DEFAULT 'off' CHECK (notify IN ('off', 'source', 'dest', 'both')),
          owner_user_id TEXT NOT NULL,
          baseline_message_id INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (owner_user_id, source_marked_id, dest_marked_id)
        );
      `);
      const insert = this.db.prepare(`
        INSERT INTO rules_owned (
          id, source_kind, source_marked_id, source_raw_id, source_peer_class, source_title, source_username, source_access_hash,
          dest_kind, dest_marked_id, dest_raw_id, dest_peer_class, dest_title, dest_username, dest_access_hash,
          status, hide_sender, notify, owner_user_id, baseline_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const record = asRow(row);
        insert.run(
          sqlValue(record.id),
          sqlValue(record.source_kind),
          sqlValue(record.source_marked_id),
          sqlValue(record.source_raw_id),
          sqlValue(record.source_peer_class),
          sqlValue(record.source_title),
          sqlValue(record.source_username),
          sqlValue(record.source_access_hash),
          sqlValue(record.dest_kind),
          sqlValue(record.dest_marked_id),
          sqlValue(record.dest_raw_id),
          sqlValue(record.dest_peer_class),
          sqlValue(record.dest_title),
          sqlValue(record.dest_username),
          sqlValue(record.dest_access_hash),
          sqlValue(record.status),
          columns.has('hide_sender') ? sqlValue(record.hide_sender) : 1,
          validNotify(record.notify) ? sqlValue(record.notify) : 'off',
          textCell(record.owner_user_id) || adminUserId,
          sqlValue(record.baseline_message_id),
          sqlValue(record.created_at),
          sqlValue(record.updated_at),
        );
      }
      this.db.exec('DROP TABLE rules;');
      this.db.exec('ALTER TABLE rules_owned RENAME TO rules;');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_rules_source_status ON rules (owner_user_id, source_marked_id, status);');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private columnSet(table: string): Set<string> {
    const names = new Set<string>();
    for (const row of this.db.prepare(`PRAGMA table_info(${table})`).all()) {
      const record = asRow(row);
      if (typeof record.name === 'string') names.add(record.name);
    }
    return names;
  }

  private tableSql(table: string): string {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    const record = asRow(row);
    return typeof record.sql === 'string' ? record.sql : '';
  }

  /** Older databases were created before sender hiding existed. New forwards hide the sender. */
  private ensureHideSender(): void {
    const columns = this.db.prepare('PRAGMA table_info(rules)').all();
    const present = columns.some((row) => {
      if (!row || typeof row !== 'object' || !('name' in row)) return false;
      return row.name === 'hide_sender';
    });
    if (present) return;
    this.db.exec(
      'ALTER TABLE rules ADD COLUMN hide_sender INTEGER NOT NULL DEFAULT 1 CHECK (hide_sender IN (0, 1))',
    );
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }
}

export function openDatabase(filename: string, adminUserId = '0'): AppDatabase {
  return new AppDatabase(filename, adminUserId);
}

function asRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  return row as Record<string, unknown>;
}

function sqlValue(value: unknown): string | number | bigint | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value === null) return value;
  if (value === undefined) return null;
  return null;
}

function textCell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function validNotify(value: unknown): boolean {
  return value === 'off' || value === 'source' || value === 'dest' || value === 'both';
}

export function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'errcode' in error ? Number(error.errcode) : 0;
  return code === 1555 || code === 2067 || error.message.includes('UNIQUE constraint');
}

export function asNumber(value: number | bigint, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid integer from ${label}`);
  return number;
}
