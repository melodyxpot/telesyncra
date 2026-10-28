import { createHash, randomBytes } from 'node:crypto';
import { INVITE_TTL_MS } from '../constants.js';
import type { Account } from '../types.js';
import { AppDatabase, asNumber } from './database.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class AccountStore {
  constructor(private readonly database: AppDatabase) {}

  ensureAdmin(userId: string): void {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO accounts (user_id, role, display_name, username, status, created_at, updated_at)
         VALUES (?, 'admin', 'Admin', NULL, 'active', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role = 'admin', status = 'active', updated_at = excluded.updated_at`,
      )
      .run(userId, now, now);
  }

  isAdmin(userId: string): boolean {
    return this.get(userId)?.role === 'admin' && this.get(userId)?.status === 'active';
  }

  hasAccess(userId: string): boolean {
    const account = this.get(userId);
    return account?.status === 'active';
  }

  get(userId: string): Account | null {
    const row = this.database.prepare(`SELECT * FROM accounts WHERE user_id = ?`).get(userId);
    return row ? mapAccount(row) : null;
  }

  listMembers(): Account[] {
    return this.database
      .prepare(`SELECT * FROM accounts WHERE role = 'member' AND status = 'active' ORDER BY created_at ASC`)
      .all()
      .map((row) => mapAccount(row));
  }

  grantMember(userId: string, displayName: string, username: string | null): void {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO accounts (user_id, role, display_name, username, status, created_at, updated_at)
         VALUES (?, 'member', ?, ?, 'active', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           role = CASE WHEN accounts.role = 'admin' THEN 'admin' ELSE 'member' END,
           display_name = excluded.display_name,
           username = excluded.username,
           status = 'active',
           updated_at = excluded.updated_at`,
      )
      .run(userId, clipName(displayName), username, now, now);
  }

  revoke(userId: string): boolean {
    const result = this.database
      .prepare(`UPDATE accounts SET status = 'revoked', updated_at = ? WHERE user_id = ? AND role = 'member' AND status = 'active'`)
      .run(Date.now(), userId);
    return asNumber(result.changes, 'accounts.changes') === 1;
  }

  rememberProfile(userId: string, displayName: string, username: string | null): void {
    this.database
      .prepare(`UPDATE accounts SET display_name = ?, username = ?, updated_at = ? WHERE user_id = ?`)
      .run(clipName(displayName), username, Date.now(), userId);
  }

  createInvite(now = Date.now()): string {
    const code = newInviteCode();
    this.database
      .prepare(`INSERT INTO invites (code_hash, created_at, expires_at, used_by, used_at) VALUES (?, ?, ?, NULL, NULL)`)
      .run(hashInvite(normalizeInviteCode(code) ?? ''), now, now + INVITE_TTL_MS);
    return code;
  }

  matchesInvite(raw: string, now = Date.now()): boolean {
    const code = normalizeInviteCode(raw);
    if (!code) return false;
    const row = this.database
      .prepare(`SELECT code_hash FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?`)
      .get(hashInvite(code), now);
    return row !== undefined;
  }

  redeem(raw: string, userId: string, now = Date.now()): boolean {
    const code = normalizeInviteCode(raw);
    if (!code) return false;
    const result = this.database
      .prepare(`UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?`)
      .run(userId, now, hashInvite(code), now);
    return asNumber(result.changes, 'invites.changes') === 1;
  }
}

export function newInviteCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length] ?? 'A';
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeInviteCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(compact)) return null;
  return compact;
}

export function hashInvite(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function clipName(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'Telegram user';
}

function mapAccount(row: unknown): Account {
  if (!row || typeof row !== 'object') throw new Error('Invalid account row');
  const record = row as Record<string, unknown>;
  const role = record.role === 'admin' ? 'admin' : record.role === 'member' ? 'member' : null;
  const status = record.status === 'active' ? 'active' : record.status === 'revoked' ? 'revoked' : null;
  if (!role || !status || typeof record.user_id !== 'string') throw new Error('Invalid account row');
  return {
    userId: record.user_id,
    role,
    displayName: typeof record.display_name === 'string' ? record.display_name : 'Telegram user',
    username: typeof record.username === 'string' ? record.username : null,
    status,
    createdAt: int(record.created_at),
    updatedAt: int(record.updated_at),
  };
}

function int(value: unknown): number {
  if (typeof value === 'bigint') return asNumber(value, 'account');
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error('Invalid account number');
}
