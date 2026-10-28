import { RuleError } from '../errors.js';
import { assertRulePair } from '../telegram/peers.js';
import type { ChatKind, NotifyMode, PeerClass, ResolvedChat, Rule, RuleStatus } from '../types.js';
import { AppDatabase, asNumber, isUniqueConstraint } from './database.js';

export interface NewRuleInput {
  source: ResolvedChat;
  destination: ResolvedChat;
  selfUserId: string;
  baselineMessageId: number;
  hideSender?: boolean;
  notify?: NotifyMode;
}

const SELECT_RULE = `
  id, source_kind, source_marked_id, source_raw_id, source_peer_class, source_title, source_username, source_access_hash,
  dest_kind, dest_marked_id, dest_raw_id, dest_peer_class, dest_title, dest_username, dest_access_hash,
  status, hide_sender, notify, owner_user_id, baseline_message_id, created_at, updated_at
`;

export class RuleRepository {
  constructor(private readonly database: AppDatabase) {}

  create(input: NewRuleInput): Rule {
    assertRulePair(input.source, input.destination, input.selfUserId);
    if (!Number.isInteger(input.baselineMessageId) || input.baselineMessageId < 0) {
      throw new RuleError('The source chat baseline is invalid, so the rule was not saved.');
    }
    const now = Date.now();
    try {
      const result = this.database.prepare(`
        INSERT INTO rules (
          source_kind, source_marked_id, source_raw_id, source_peer_class, source_title, source_username, source_access_hash,
          dest_kind, dest_marked_id, dest_raw_id, dest_peer_class,           dest_title, dest_username, dest_access_hash,
          status, hide_sender, notify, owner_user_id, baseline_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).run(
        input.source.kind,
        input.source.markedId,
        input.source.rawId,
        input.source.peerClass,
        input.source.title,
        input.source.username,
        input.source.accessHash,
        input.destination.kind,
        input.destination.markedId,
        input.destination.rawId,
        input.destination.peerClass,
        input.destination.title,
        input.destination.username,
        input.destination.accessHash,
        input.hideSender === false ? 0 : 1,
        input.notify ?? 'off',
        input.selfUserId,
        input.baselineMessageId,
        now,
        now,
      );
      const id = asNumber(result.lastInsertRowid, 'rules.id');
      const rule = this.get(id);
      if (!rule) throw new RuleError('The rule was saved but could not be read back.');
      return rule;
    } catch (error) {
      if (error instanceof RuleError) throw error;
      if (isUniqueConstraint(error)) {
        throw new RuleError('A rule for that source and destination already exists.');
      }
      throw error;
    }
  }

  list(ownerUserId?: string): Rule[] {
    const filter = ownerUserId ? 'WHERE owner_user_id = ?' : '';
    return this.database
      .prepare(`SELECT ${SELECT_RULE} FROM rules ${filter} ORDER BY id ASC`)
      .all(...(ownerUserId ? [ownerUserId] : []))
      .map((row) => mapRule(row));
  }

  listActiveBySource(ownerUserId: string, sourceMarkedId: string): Rule[] {
    return this.database
      .prepare(
        `SELECT ${SELECT_RULE} FROM rules WHERE owner_user_id = ? AND status = 'active' AND source_marked_id = ? ORDER BY id ASC`,
      )
      .all(ownerUserId, sourceMarkedId)
      .map((row) => mapRule(row));
  }

  get(id: number, ownerUserId?: string): Rule | null {
    const row = ownerUserId
      ? this.database.prepare(`SELECT ${SELECT_RULE} FROM rules WHERE id = ? AND owner_user_id = ?`).get(id, ownerUserId)
      : this.database.prepare(`SELECT ${SELECT_RULE} FROM rules WHERE id = ?`).get(id);
    return row ? mapRule(row) : null;
  }

  pause(id: number, ownerUserId?: string): Rule {
    return this.requireChange(
      id,
      ownerUserId
        ? this.database
            .prepare(`UPDATE rules SET status = 'paused', updated_at = ? WHERE id = ? AND owner_user_id = ?`)
            .run(Date.now(), id, ownerUserId)
        : this.database.prepare(`UPDATE rules SET status = 'paused', updated_at = ? WHERE id = ?`).run(Date.now(), id),
      ownerUserId,
    );
  }

  activate(id: number, baselineMessageId: number, ownerUserId?: string): Rule {
    if (!Number.isInteger(baselineMessageId) || baselineMessageId < 0) {
      throw new RuleError('Cannot start the rule without a valid baseline.');
    }
    return this.requireChange(
      id,
      ownerUserId
        ? this.database
            .prepare(
              `UPDATE rules SET status = 'active', baseline_message_id = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`,
            )
            .run(baselineMessageId, Date.now(), id, ownerUserId)
        : this.database
            .prepare(`UPDATE rules SET status = 'active', baseline_message_id = ?, updated_at = ? WHERE id = ?`)
            .run(baselineMessageId, Date.now(), id),
      ownerUserId,
    );
  }

  setBaseline(id: number, baselineMessageId: number): void {
    if (!Number.isInteger(baselineMessageId) || baselineMessageId < 0) {
      throw new RuleError('Cannot store an invalid baseline.');
    }
    const result = this.database
      .prepare(`UPDATE rules SET baseline_message_id = ?, updated_at = ? WHERE id = ?`)
      .run(baselineMessageId, Date.now(), id);
    if (asNumber(result.changes, 'rules.changes') !== 1) throw new RuleError('That rule no longer exists.');
  }

  setHideSender(id: number, hideSender: boolean, ownerUserId?: string): Rule {
    return this.requireChange(
      id,
      ownerUserId
        ? this.database
            .prepare(`UPDATE rules SET hide_sender = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`)
            .run(hideSender ? 1 : 0, Date.now(), id, ownerUserId)
        : this.database.prepare(`UPDATE rules SET hide_sender = ?, updated_at = ? WHERE id = ?`).run(hideSender ? 1 : 0, Date.now(), id),
      ownerUserId,
    );
  }

  setNotify(id: number, notify: NotifyMode, ownerUserId?: string): Rule {
    return this.requireChange(
      id,
      ownerUserId
        ? this.database
            .prepare(`UPDATE rules SET notify = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`)
            .run(notify, Date.now(), id, ownerUserId)
        : this.database.prepare(`UPDATE rules SET notify = ?, updated_at = ? WHERE id = ?`).run(notify, Date.now(), id),
      ownerUserId,
    );
  }

  pauseAll(ownerUserId: string): number {
    const result = this.database
      .prepare(`UPDATE rules SET status = 'paused', updated_at = ? WHERE status = 'active' AND owner_user_id = ?`)
      .run(Date.now(), ownerUserId);
    return asNumber(result.changes, 'rules.changes');
  }

  updateEndpoint(
    id: number,
    field: 'source' | 'dest',
    chat: ResolvedChat,
    baselineMessageId: number,
    selfUserId: string,
  ): Rule {
    const existing = this.get(id);
    if (!existing) throw new RuleError('That rule no longer exists.');
    const source = field === 'source' ? chat : chatFrom(existing, 'source');
    const destination = field === 'dest' ? chat : chatFrom(existing, 'dest');
    assertRulePair(source, destination, selfUserId);
    if (!Number.isInteger(baselineMessageId) || baselineMessageId < 0) {
      throw new RuleError('Cannot update the rule without a valid baseline.');
    }
    const sql =
      field === 'source'
        ? `UPDATE rules SET
            source_kind = ?, source_marked_id = ?, source_raw_id = ?, source_peer_class = ?,
            source_title = ?, source_username = ?, source_access_hash = ?,
            baseline_message_id = ?, updated_at = ?
           WHERE id = ? AND owner_user_id = ?`
        : `UPDATE rules SET
            dest_kind = ?, dest_marked_id = ?, dest_raw_id = ?, dest_peer_class = ?,
            dest_title = ?, dest_username = ?, dest_access_hash = ?,
            baseline_message_id = ?, updated_at = ?
           WHERE id = ? AND owner_user_id = ?`;
    try {
      const result = this.database
        .prepare(sql)
        .run(
          chat.kind,
          chat.markedId,
          chat.rawId,
          chat.peerClass,
          chat.title,
          chat.username,
          chat.accessHash,
          baselineMessageId,
          Date.now(),
          id,
          selfUserId,
        );
      if (asNumber(result.changes, 'rules.changes') !== 1) throw new RuleError('That rule no longer exists.');
    } catch (error) {
      if (error instanceof RuleError) throw error;
      if (isUniqueConstraint(error)) throw new RuleError('A rule for that source and destination already exists.');
      throw error;
    }
    return this.require(id, selfUserId);
  }

  delete(id: number, ownerUserId?: string): boolean {
    const result = ownerUserId
      ? this.database.prepare(`DELETE FROM rules WHERE id = ? AND owner_user_id = ?`).run(id, ownerUserId)
      : this.database.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
    return asNumber(result.changes, 'rules.changes') === 1;
  }

  counts(ownerUserId?: string): { active: number; paused: number } {
    const rows = ownerUserId
      ? this.database
          .prepare(`SELECT status, COUNT(*) AS count FROM rules WHERE owner_user_id = ? GROUP BY status`)
          .all(ownerUserId)
      : this.database.prepare(`SELECT status, COUNT(*) AS count FROM rules GROUP BY status`).all();
    const counts = { active: 0, paused: 0 };
    for (const row of rows) {
      const record = asRecord(row);
      if (record.status === 'active') counts.active = integer(record.count, 'count');
      if (record.status === 'paused') counts.paused = integer(record.count, 'count');
    }
    return counts;
  }

  claim(ruleId: number, sourceChatId: string, messageId: number, now = Date.now()): boolean {
    try {
      this.database
        .prepare(
          `INSERT INTO processed_messages (rule_id, source_chat_id, message_id, status, error_code, processed_at)
           VALUES (?, ?, ?, 'pending', NULL, ?)`,
        )
        .run(ruleId, sourceChatId, messageId, now);
      return true;
    } catch (error) {
      if (isUniqueConstraint(error)) return false;
      throw error;
    }
  }

  complete(
    ruleId: number,
    sourceChatId: string,
    messageId: number,
    status: 'forwarded' | 'skipped' | 'error',
    errorCode: string | null,
    now = Date.now(),
  ): void {
    this.database
      .prepare(
        `UPDATE processed_messages
         SET status = ?, error_code = ?, processed_at = ?
         WHERE rule_id = ? AND source_chat_id = ? AND message_id = ?`,
      )
      .run(status, errorCode, now, ruleId, sourceChatId, messageId);
  }

  settleInterrupted(): number {
    const result = this.database
      .prepare(`UPDATE processed_messages SET status = 'error', error_code = 'INTERRUPTED' WHERE status = 'pending'`)
      .run();
    return asNumber(result.changes, 'processed_messages.changes');
  }

  private requireChange(id: number, result: { changes: number | bigint }, ownerUserId?: string): Rule {
    if (asNumber(result.changes, 'rules.changes') !== 1) throw new RuleError('That rule no longer exists.');
    return this.require(id, ownerUserId);
  }

  private require(id: number, ownerUserId?: string): Rule {
    const rule = this.get(id, ownerUserId);
    if (!rule) throw new RuleError('That rule no longer exists.');
    return rule;
  }
}

function chatFrom(rule: Rule, side: 'source' | 'dest'): ResolvedChat {
  if (side === 'source') {
    return {
      kind: rule.sourceKind,
      markedId: rule.sourceMarkedId,
      rawId: rule.sourceRawId,
      peerClass: rule.sourcePeerClass,
      title: rule.sourceTitle,
      username: rule.sourceUsername,
      accessHash: rule.sourceAccessHash,
      self: false,
    };
  }
  return {
    kind: rule.destKind,
    markedId: rule.destMarkedId,
    rawId: rule.destRawId,
    peerClass: rule.destPeerClass,
    title: rule.destTitle,
    username: rule.destUsername,
    accessHash: rule.destAccessHash,
    self: false,
  };
}

function mapRule(row: unknown): Rule {
  const record = asRecord(row);
  return {
    id: integer(record.id, 'id'),
    sourceKind: kind(record.source_kind),
    sourceMarkedId: text(record.source_marked_id),
    sourceRawId: text(record.source_raw_id),
    sourcePeerClass: peerClass(record.source_peer_class),
    sourceTitle: text(record.source_title),
    sourceUsername: textOrNull(record.source_username),
    sourceAccessHash: textOrNull(record.source_access_hash),
    destKind: kind(record.dest_kind),
    destMarkedId: text(record.dest_marked_id),
    destRawId: text(record.dest_raw_id),
    destPeerClass: peerClass(record.dest_peer_class),
    destTitle: text(record.dest_title),
    destUsername: textOrNull(record.dest_username),
    destAccessHash: textOrNull(record.dest_access_hash),
    status: status(record.status),
    hideSender: integer(record.hide_sender, 'hide_sender') === 1,
    notify: notifyMode(record.notify),
    ownerUserId: text(record.owner_user_id),
    baselineMessageId: integer(record.baseline_message_id, 'baseline_message_id'),
    createdAt: integer(record.created_at, 'created_at'),
    updatedAt: integer(record.updated_at, 'updated_at'),
  };
}

function asRecord(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') throw new Error('Invalid database row');
  return row as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (typeof value === 'bigint') return asNumber(value, label);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error(`Invalid integer column ${label}`);
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid text column');
  return value;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function kind(value: unknown): ChatKind {
  if (value === 'user' || value === 'group' || value === 'channel') return value;
  throw new Error('Invalid chat kind');
}

function peerClass(value: unknown): PeerClass {
  if (value === 'user' || value === 'chat' || value === 'channel') return value;
  throw new Error('Invalid peer class');
}

function status(value: unknown): RuleStatus {
  if (value === 'active' || value === 'paused') return value;
  throw new Error('Invalid rule status');
}

function notifyMode(value: unknown): NotifyMode {
  if (value === 'off' || value === 'source' || value === 'dest' || value === 'both') return value;
  throw new Error('Invalid notify mode');
}
