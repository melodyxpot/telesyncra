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
  baseline_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_marked_id, dest_marked_id)
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
  source_chat_id TEXT,
  message_id INTEGER,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rules_source_status ON rules (source_marked_id, status);
CREATE INDEX IF NOT EXISTS idx_forward_logs_created ON forward_logs (created_at DESC);
`;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.ensureHideSender();
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

export function openDatabase(filename: string): AppDatabase {
  return new AppDatabase(filename);
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
