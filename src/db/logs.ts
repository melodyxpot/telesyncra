import type { ForwardLog } from '../types.js';
import { AppDatabase, asNumber } from './database.js';

export interface NewForwardLog {
  ruleId: number | null;
  ownerUserId: string | null;
  sourceChatId: string | null;
  messageId: number | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail: string | null;
}

export class LogRepository {
  constructor(private readonly database: AppDatabase) {}

  write(entry: NewForwardLog, now = Date.now()): void {
    this.database
      .prepare(
        `INSERT INTO forward_logs (rule_id, owner_user_id, source_chat_id, message_id, level, event, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.ruleId,
        entry.ownerUserId,
        entry.sourceChatId,
        entry.messageId,
        entry.level,
        entry.event,
        clip(entry.detail),
        now,
      );
  }

  list(offset: number, limit: number, ownerUserId?: string): ForwardLog[] {
    const filter = ownerUserId ? 'WHERE owner_user_id = ?' : '';
    return this.database
      .prepare(
        `SELECT id, rule_id, owner_user_id, source_chat_id, message_id, level, event, detail, created_at
         FROM forward_logs ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...(ownerUserId ? [ownerUserId, limit, offset] : [limit, offset]))
      .map((row) => mapLog(row));
  }

  count(ownerUserId?: string): number {
    const row = ownerUserId
      ? this.database.prepare(`SELECT COUNT(*) AS count FROM forward_logs WHERE owner_user_id = ?`).get(ownerUserId)
      : this.database.prepare(`SELECT COUNT(*) AS count FROM forward_logs`).get();
    if (!row || typeof row !== 'object' || !('count' in row)) return 0;
    const count = row.count;
    return typeof count === 'bigint' ? asNumber(count, 'count') : typeof count === 'number' ? count : 0;
  }

  clearAll(ownerUserId?: string): number {
    const result = ownerUserId
      ? this.database.prepare(`DELETE FROM forward_logs WHERE owner_user_id = ?`).run(ownerUserId)
      : this.database.prepare(`DELETE FROM forward_logs`).run();
    return asNumber(result.changes, 'forward_logs.changes');
  }
}

function mapLog(row: unknown): ForwardLog {
  if (!row || typeof row !== 'object') throw new Error('Invalid log row');
  const record = row as Record<string, unknown>;
  const level = record.level;
  if (level !== 'info' && level !== 'warn' && level !== 'error') throw new Error('Invalid log level');
  return {
    id: numberValue(record.id),
    ruleId: record.rule_id === null ? null : numberValue(record.rule_id),
    ownerUserId: typeof record.owner_user_id === 'string' ? record.owner_user_id : null,
    sourceChatId: typeof record.source_chat_id === 'string' ? record.source_chat_id : null,
    messageId: record.message_id === null ? null : numberValue(record.message_id),
    level,
    event: typeof record.event === 'string' ? record.event : 'unknown',
    detail: typeof record.detail === 'string' ? record.detail : null,
    createdAt: numberValue(record.created_at),
  };
}

function numberValue(value: unknown): number {
  if (typeof value === 'bigint') return asNumber(value, 'log');
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error('Invalid log number');
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 180);
}
