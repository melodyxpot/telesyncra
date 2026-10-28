import { describe, expect, it } from 'vitest';
import { parseCallback } from '../src/access/callbacks.js';
import { isAllowedUser } from '../src/access/guard.js';
import { parseChatReference } from '../src/telegram/reference.js';

describe('access control', () => {
  it('allows only the configured user id', () => {
    expect(isAllowedUser(100, '100')).toBe(true);
    expect(isAllowedUser('100', '100')).toBe(true);
    expect(isAllowedUser(101, '100')).toBe(false);
    expect(isAllowedUser(undefined, '100')).toBe(false);
    expect(isAllowedUser(null, '100')).toBe(false);
    expect(isAllowedUser(0, '100')).toBe(false);
    expect(isAllowedUser(-5, '100')).toBe(false);
    expect(isAllowedUser(' 100 ', '100')).toBe(true);
    expect(isAllowedUser('100abc', '100')).toBe(false);
    expect(isAllowedUser('0100', '100')).toBe(false);
    expect(isAllowedUser(100, '0')).toBe(false);
    expect(isAllowedUser(100, 'abc')).toBe(false);
  });

  it('accepts the menu callbacks and rejects malformed ones', () => {
    expect(parseCallback('menu')).toEqual({ type: 'menu' });
    expect(parseCallback('new')).toEqual({ type: 'create' });
    expect(parseCallback('kind:user')).toEqual({ type: 'kind', kind: 'user' });
    expect(parseCallback('kind:group')).toEqual({ type: 'kind', kind: 'group' });
    expect(parseCallback('kind:channel')).toEqual({ type: 'kind', kind: 'channel' });
    expect(parseCallback('pick:0')).toEqual({ type: 'pick', index: 0 });
    expect(parseCallback('pick:5')).toEqual({ type: 'pick', index: 5 });
    expect(parseCallback('page:0')).toEqual({ type: 'page', page: 0 });
    expect(parseCallback('rules:2')).toEqual({ type: 'rules', page: 2 });
    expect(parseCallback('toggle:1')).toEqual({ type: 'toggle_page', page: 1 });
    expect(parseCallback('toggle-id:12')).toEqual({ type: 'toggle', ruleId: 12 });
    expect(parseCallback('edit-src:4')).toEqual({ type: 'edit_field', ruleId: 4, field: 'source' });
    expect(parseCallback('edit-dst:4')).toEqual({ type: 'edit_field', ruleId: 4, field: 'dest' });
    expect(parseCallback('del-yes:9')).toEqual({ type: 'delete_confirm', ruleId: 9 });
    expect(parseCallback('logs:3')).toEqual({ type: 'logs', page: 3 });
    expect(parseCallback('set-clear-yes')).toEqual({ type: 'clear_logs' });
    expect(parseCallback('ok')).toEqual({ type: 'confirm' });

    expect(parseCallback(undefined)).toBeNull();
    expect(parseCallback('')).toBeNull();
    expect(parseCallback('kind:bot')).toBeNull();
    expect(parseCallback('pick:6')).toBeNull();
    expect(parseCallback('pick:-1')).toBeNull();
    expect(parseCallback('rules:-1')).toBeNull();
    expect(parseCallback('rules:00')).toBeNull();
    expect(parseCallback('toggle-id:0')).toBeNull();
    expect(parseCallback('toggle-id:01')).toBeNull();
    expect(parseCallback('rules:0;drop')).toBeNull();
    expect(parseCallback('../menu')).toBeNull();
    expect(parseCallback('menu ')).toBeNull();
    expect(parseCallback('a'.repeat(65))).toBeNull();
    expect(parseCallback('set-clear-yes-extra')).toBeNull();
  });

  it('validates manual chat input', () => {
    expect(parseChatReference('@telegram')).toEqual({ ok: true, value: { type: 'username', username: 'telegram' } });
    expect(parseChatReference('https://t.me/telegram')).toEqual({
      ok: true,
      value: { type: 'username', username: 'telegram' },
    });
    expect(parseChatReference('tg://resolve?domain=telegram')).toEqual({
      ok: true,
      value: { type: 'username', username: 'telegram' },
    });
    expect(parseChatReference('-1001234567890')).toEqual({ ok: true, value: { type: 'id', id: '-1001234567890' } });
    expect(parseChatReference('42')).toEqual({ ok: true, value: { type: 'id', id: '42' } });

    expect(parseChatReference('').ok).toBe(false);
    expect(parseChatReference('+15551234567').ok).toBe(false);
    expect(parseChatReference('https://t.me/+inviteHash').ok).toBe(false);
    expect(parseChatReference('https://t.me/joinchat/secret').ok).toBe(false);
    expect(parseChatReference('ab').ok).toBe(false);
    expect(parseChatReference('a'.repeat(70)).ok).toBe(false);
    expect(parseChatReference('javascript:alert(1)').ok).toBe(false);
  });
});
