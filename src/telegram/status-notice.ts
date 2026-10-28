import type { NotifyMode, Rule } from '../types.js';

export type StatusEvent = 'started' | 'paused' | 'stopped';

export function notifySides(mode: NotifyMode): Array<'source' | 'dest'> {
  if (mode === 'source') return ['source'];
  if (mode === 'dest') return ['dest'];
  if (mode === 'both') return ['source', 'dest'];
  return [];
}

export function statusNotice(rule: Rule, event: StatusEvent): string {
  const title = event === 'started' ? 'Forwarding started' : event === 'paused' ? 'Forwarding paused' : 'Forwarding stopped';
  const detail =
    event === 'started'
      ? 'New messages will be forwarded. Older messages stay where they are.'
      : event === 'paused'
        ? 'Messages that arrive while this rule is paused stay where they are.'
        : 'This rule was removed. Messages already delivered stay in place.';
  const sender = rule.hideSender ? 'The original sender name is hidden.' : 'The original sender name stays on the message.';
  return [
    `<b>${title}</b>`,
    '',
    `<b>From</b> ${escapeHtml(rule.sourceTitle)}`,
    `<b>To</b> ${escapeHtml(rule.destTitle)}`,
    `<i>${detail} ${sender}</i>`,
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
