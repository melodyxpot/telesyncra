import { afterEach, describe, expect, it } from 'vitest';
import { AccountStore, normalizeInviteCode } from '../src/db/accounts.js';
import { statusNotice } from '../src/telegram/status-notice.js';
import { memoryDb } from './fixtures.js';
import type { Rule } from '../src/types.js';

const open: Array<{ close(): void }> = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('invites', () => {
  it('accepts a code once and keeps the admin in place', () => {
    const { db } = memoryDb();
    open.push(db);
    const accounts = new AccountStore(db);
    accounts.ensureAdmin('100');
    const code = accounts.createInvite(1_000);
    expect(normalizeInviteCode(code)).toHaveLength(8);
    expect(accounts.matchesInvite(`  ${code.toLowerCase()}  `, 1_000)).toBe(true);
    expect(accounts.redeem(code, '200', 1_000)).toBe(true);
    expect(accounts.redeem(code, '201', 1_000)).toBe(false);
    accounts.grantMember('200', 'Ada', 'ada');
    expect(accounts.hasAccess('200')).toBe(true);
    expect(accounts.hasAccess('201')).toBe(false);
    expect(accounts.revoke('100')).toBe(false);
    expect(accounts.revoke('200')).toBe(true);
    expect(accounts.hasAccess('200')).toBe(false);
    expect(accounts.isAdmin('100')).toBe(true);
  });
});

describe('status notices', () => {
  it('describes the rule status without any message text', () => {
    const rule = {
      sourceTitle: 'Ada <ops>',
      destTitle: 'News',
      hideSender: true,
      notify: 'both',
    } as Rule;
    const text = statusNotice(rule, 'started');
    expect(text).toContain('<b>Forwarding started</b>');
    expect(text).toContain('Ada &lt;ops&gt;');
    expect(text).toContain('The original sender name is hidden.');
    expect(text).not.toContain('message text');
    expect(statusNotice({ ...rule, hideSender: false }, 'paused')).toContain('Forwarding paused');
  });
});