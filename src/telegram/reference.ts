export type ChatReference = { type: 'username'; username: string } | { type: 'id'; id: string };

const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const NUMERIC_ID = /^-?(?:0|[1-9]\d{0,19})$/;

export function parseChatReference(raw: string): { ok: true; value: ChatReference } | { ok: false; error: string } {
  const trimmed = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!trimmed) return fail('Send a @username or a numeric chat id.');
  if (trimmed.length > 64) return fail('That value is too long. Send a @username or a numeric chat id.');
  if (trimmed.startsWith('+')) {
    return fail('Send a @username or a numeric chat id, not a phone number.');
  }
  if (/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)|tg:\/\/join/i.test(trimmed)) {
    return fail('Invite links are not accepted. Join the chat in Telegram, then pick it from the list or send its numeric id.');
  }

  const username = usernameOf(trimmed);
  if (username) return { ok: true, value: { type: 'username', username } };
  if (NUMERIC_ID.test(trimmed) && trimmed !== '0' && trimmed !== '-0') {
    return { ok: true, value: { type: 'id', id: trimmed } };
  }
  return fail('Send a public @username, a t.me link, or a numeric chat id.');
}

export function numericAttempts(id: string, expectedKind: 'user' | 'group' | 'channel'): string[] {
  if (id.startsWith('-')) return [id];
  if (expectedKind === 'user') return [id];
  const attempts = [`-100${id}`];
  if (expectedKind === 'group') attempts.push(`-${id}`);
  attempts.push(id);
  return attempts;
}

function usernameOf(value: string): string | null {
  const direct = value.startsWith('@') ? value.slice(1) : value;
  if (USERNAME.test(direct) && !value.startsWith('http') && !value.includes('/')) return direct;
  const link = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(value);
  if (link?.[1] && USERNAME.test(link[1])) return link[1];
  const tg = /^tg:\/\/resolve\?domain=([A-Za-z][A-Za-z0-9_]{4,31})$/i.exec(value);
  if (tg?.[1] && USERNAME.test(tg[1])) return tg[1];
  return null;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
