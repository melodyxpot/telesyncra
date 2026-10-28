import { kindLabel } from '../telegram/peers.js';
import type { ForwardLog, NotifyMode, ResolvedChat, Rule } from '../types.js';
import { notifySummary } from './notify-mode.js';
import { mdEscape } from './rich-text.js';

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
  const name = mdEscape(oneLine(chat.title, 60));
  const username = chat.username ? ` (@${mdEscape(oneLine(chat.username, 32))})` : '';
  return `${kindLabel(chat.kind)}: ${name}${username} [${mdEscape(chat.markedId)}]`;
}

export function formatRule(rule: Rule): string {
  return [
    `**#${rule.id}** \`${rule.status}\``,
    `**From** ${formatChat({ kind: rule.sourceKind, title: rule.sourceTitle, username: rule.sourceUsername, markedId: rule.sourceMarkedId })}`,
    `**To** ${formatChat({ kind: rule.destKind, title: rule.destTitle, username: rule.destUsername, markedId: rule.destMarkedId })}`,
    rule.hideSender ? '*Sender hidden*' : '*Sender shown*',
    notifySummary(rule.notify),
  ].join('\n');
}

export function senderNote(hideSender: boolean): string {
  return hideSender
    ? 'The **original sender is hidden**. The recipient sees the message as sent by your account. Words inside the message stay as written.'
    : 'The **original sender name stays** on the forwarded message.';
}

export function ruleSummary(source: ResolvedChat, destination: ResolvedChat, hideSender = true, notify: NotifyMode = 'off'): string {
  return [
    `**From** ${formatChat(source)}`,
    `**To** ${formatChat(destination)}`,
    '',
    'Only messages that arrive after you confirm are forwarded.',
    '- Messages sent by your account are skipped.',
    '- Protected content is skipped. Telesyncra will not copy it or bypass Telegram.',
    `- ${senderNote(hideSender)}`,
    `- ${notifySummary(notify)}`,
    '',
    '**Confirm** to save and activate the rule.',
  ].join('\n');
}

export function kindPrompt(side: 'source' | 'destination'): string {
  const direction = side === 'source' ? 'messages come from' : 'messages are delivered to';
  return [
    `Which kind of chat should **${direction}**?`,
    '',
    '- **Private user.** A one-to-one chat.',
    '- **Group.** A basic group or supergroup.',
    '- **Channel.** A broadcast channel.',
    '',
    'Your account must already be able to access the chat.',
  ].join('\n');
}

export function helpText(): string {
  return [
    'Telesyncra forwards **new** messages with your Telegram account.',
    '*This bot is only the control menu. It cannot read your private chats.*',
    '',
    '- Create a rule, confirm it, and leave this program running.',
    '- Your own messages are skipped. Old messages are not copied.',
    '- Protected chats and messages that Telegram refuses to forward are skipped.',
    '',
    'Tap a button under the message. The reply bar opens when a step needs a username or id.',
    'Sign in from the menu with your own phone number. Each person keeps their own rules.',
    'An invite code works once. Ask the admin for a new one if it expires.',
    'Commands: `/menu` `/status` `/cancel` `/help`',
  ].join('\n');
}

export function formatLog(entry: ForwardLog): string {
  const time = new Date(entry.createdAt).toISOString().slice(0, 19) + 'Z';
  const rule = entry.ruleId === null ? 'rule -' : `rule ${entry.ruleId}`;
  const detail = entry.detail ? ` ${mdEscape(oneLine(entry.detail, 80))}` : '';
  return `\`${time}\` **${entry.level}** ${rule} ${mdEscape(entry.event)}${detail}`;
}
