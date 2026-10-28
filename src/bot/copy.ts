import { kindLabel } from '../telegram/peers.js';
import type { ForwardLog, ResolvedChat, Rule } from '../types.js';

export function oneLine(value: string, max = 80): string {
  const cleaned = stripControls(value).replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, max) || 'Untitled chat';
}

function stripControls(value: string): string {
  let output = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    output += code <= 31 || code === 127 ? ' ' : char;
  }
  return output;
}

export function formatChat(chat: Pick<ResolvedChat, 'kind' | 'title' | 'username' | 'markedId'>): string {
  const name = oneLine(chat.title, 60);
  const username = chat.username ? ` (@${chat.username})` : '';
  return `${kindLabel(chat.kind)}: ${name}${username} [${chat.markedId}]`;
}

export function formatRule(rule: Rule): string {
  return [
    `#${rule.id} ${rule.status}`,
    `From ${formatChat({ kind: rule.sourceKind, title: rule.sourceTitle, username: rule.sourceUsername, markedId: rule.sourceMarkedId })}`,
    `To ${formatChat({ kind: rule.destKind, title: rule.destTitle, username: rule.destUsername, markedId: rule.destMarkedId })}`,
    rule.hideSender ? 'Sender hidden' : 'Sender shown',
  ].join('\n');
}

export function senderNote(hideSender: boolean): string {
  return hideSender
    ? 'Original sender is hidden. The recipient sees the message as sent by your account. Words inside the message stay as written.'
    : 'Original sender name stays on the forwarded message.';
}

export function ruleSummary(source: ResolvedChat, destination: ResolvedChat, hideSender = true): string {
  return [
    `From ${formatChat(source)}`,
    `To ${formatChat(destination)}`,
    '',
    'Only messages that arrive after you confirm are forwarded.',
    'Messages sent by your account are skipped.',
    'Protected content is skipped. Telesyncra will not copy it or bypass Telegram.',
    senderNote(hideSender),
    '',
    'Confirm to save and activate the rule.',
  ].join('\n');
}

export function kindPrompt(side: 'source' | 'destination'): string {
  const direction = side === 'source' ? 'messages come from' : 'messages are delivered to';
  return [
    `Which kind of chat should ${direction}?`,
    '',
    'Private user: a one-to-one chat.',
    'Group: a basic group or supergroup.',
    'Channel: a broadcast channel.',
    '',
    'Your account must already be able to access the chat.',
  ].join('\n');
}

export function helpText(): string {
  return [
    'Telesyncra forwards new messages with your Telegram account.',
    'This bot is only the control menu. It cannot read your private chats.',
    '',
    'Create a rule, confirm it, and leave this program running.',
    'Your own messages are skipped. Old messages are not copied.',
    'Protected chats and messages that Telegram refuses to forward are skipped.',
    '',
    'Tap a button in the message. The reply bar opens when a step needs a username or id.',
    'Commands: /menu /status /cancel /help',
  ].join('\n');
}

export function formatLog(entry: ForwardLog): string {
  const time = new Date(entry.createdAt).toISOString().slice(0, 19) + 'Z';
  const rule = entry.ruleId === null ? 'rule -' : `rule ${entry.ruleId}`;
  const detail = entry.detail ? ` ${oneLine(entry.detail, 80)}` : '';
  return `${time} ${entry.level} ${rule} ${entry.event}${detail}`;
}
