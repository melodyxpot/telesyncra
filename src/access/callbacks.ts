import { CHAT_PAGE_SIZE, MAX_CALLBACK_LENGTH } from '../constants.js';
import { isNotifyMode } from '../bot/notify-mode.js';
import type { ChatKind, NotifyMode } from '../types.js';

export type CallbackAction =
  | { type: 'menu' }
  | { type: 'create' }
  | { type: 'cancel' }
  | { type: 'back' }
  | { type: 'manual' }
  | { type: 'confirm' }
  | { type: 'settings' }
  | { type: 'pause_all' }
  | { type: 'resume_all' }
  | { type: 'clear_logs_ask' }
  | { type: 'clear_logs' }
  | { type: 'noop' }
  | { type: 'kind'; kind: ChatKind }
  | { type: 'pick'; index: number }
  | { type: 'page'; page: number }
  | { type: 'rules'; page: number }
  | { type: 'toggle_page'; page: number }
  | { type: 'toggle'; ruleId: number }
  | { type: 'edit_page'; page: number }
  | { type: 'edit_rule'; ruleId: number }
  | { type: 'edit_field'; ruleId: number; field: 'source' | 'dest' }
  | { type: 'delete_page'; page: number }
  | { type: 'delete_ask'; ruleId: number }
  | { type: 'delete_confirm'; ruleId: number }
  | { type: 'hide_sender'; hide: boolean }
  | { type: 'hide_sender_rule'; ruleId: number }
  | { type: 'notify'; mode: NotifyMode }
  | { type: 'notify_rule'; ruleId: number }
  | { type: 'sign_in' }
  | { type: 'invite' }
  | { type: 'people' }
  | { type: 'remove_ask'; userId: string }
  | { type: 'remove_confirm'; userId: string }
  | { type: 'logs'; page: number };

const PAGE = /^(?:0|[1-9]\d{0,2})$/;
const RULE_ID = /^[1-9]\d{0,8}$/;

export function parseCallback(data: string | undefined): CallbackAction | null {
  if (data === undefined || data.length === 0 || data.length > MAX_CALLBACK_LENGTH) return null;
  if (!/^[\w:-]+$/.test(data)) return null;

  switch (data) {
    case 'menu':
      return { type: 'menu' };
    case 'new':
      return { type: 'create' };
    case 'cancel':
      return { type: 'cancel' };
    case 'back':
      return { type: 'back' };
    case 'manual':
      return { type: 'manual' };
    case 'ok':
      return { type: 'confirm' };
    case 'set':
      return { type: 'settings' };
    case 'set-pause':
      return { type: 'pause_all' };
    case 'set-resume':
      return { type: 'resume_all' };
    case 'set-clear':
      return { type: 'clear_logs_ask' };
    case 'set-clear-yes':
      return { type: 'clear_logs' };
    case 'signin':
      return { type: 'sign_in' };
    case 'inv-new':
      return { type: 'invite' };
    case 'people':
      return { type: 'people' };
    case 'noop':
      return { type: 'noop' };
    default:
      break;
  }

  const kind = /^kind:(user|group|channel)$/.exec(data);
  if (kind?.[1] === 'user' || kind?.[1] === 'group' || kind?.[1] === 'channel') {
    return { type: 'kind', kind: kind[1] };
  }

  const pick = /^pick:(\d+)$/.exec(data);
  if (pick?.[1]) {
    const index = Number(pick[1]);
    if (Number.isInteger(index) && index >= 0 && index < CHAT_PAGE_SIZE) return { type: 'pick', index };
    return null;
  }

  const sender = /^sender:(0|1)$/.exec(data);
  if (sender?.[1]) return { type: 'hide_sender', hide: sender[1] === '1' };

  const notify = /^note:(off|source|dest|both)$/.exec(data);
  if (notify?.[1] && isNotifyMode(notify[1])) return { type: 'notify', mode: notify[1] };

  const remove = /^rm:([1-9]\d{0,18})$/.exec(data);
  if (remove?.[1]) return { type: 'remove_ask', userId: remove[1] };
  const removeYes = /^rm-yes:([1-9]\d{0,18})$/.exec(data);
  if (removeYes?.[1]) return { type: 'remove_confirm', userId: removeYes[1] };

  return (
    pageAction(data, 'page', 'page') ??
    pageAction(data, 'rules', 'rules') ??
    pageAction(data, 'toggle', 'toggle_page') ??
    idAction(data, 'toggle-id', 'toggle') ??
    pageAction(data, 'edit', 'edit_page') ??
    idAction(data, 'edit-id', 'edit_rule') ??
    fieldAction(data, 'edit-src', 'source') ??
    fieldAction(data, 'edit-dst', 'dest') ??
    pageAction(data, 'del', 'delete_page') ??
    idAction(data, 'del-id', 'delete_ask') ??
    idAction(data, 'del-yes', 'delete_confirm') ??
    idAction(data, 'sender-id', 'hide_sender_rule') ??
    idAction(data, 'note-id', 'notify_rule') ??
    pageAction(data, 'logs', 'logs')
  );
}

function pageAction<T extends string>(data: string, prefix: string, type: T): ({ type: T; page: number }) | null {
  const match = new RegExp(`^${prefix}:(\\d{1,3})$`).exec(data);
  const pageText = match?.[1];
  if (!pageText || !PAGE.test(pageText)) return null;
  return { type, page: Number(pageText) };
}

function idAction<T extends string>(data: string, prefix: string, type: T): ({ type: T; ruleId: number }) | null {
  const match = new RegExp(`^${prefix}:(\\d{1,9})$`).exec(data);
  const idText = match?.[1];
  if (!idText || !RULE_ID.test(idText)) return null;
  return { type, ruleId: Number(idText) };
}

function fieldAction(
  data: string,
  prefix: string,
  field: 'source' | 'dest',
): { type: 'edit_field'; ruleId: number; field: 'source' | 'dest' } | null {
  const match = new RegExp(`^${prefix}:(\\d{1,9})$`).exec(data);
  const idText = match?.[1];
  if (!idText || !RULE_ID.test(idText)) return null;
  return { type: 'edit_field', ruleId: Number(idText), field };
}
