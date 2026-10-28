import {
  RichMessageBuilder,
  richListItem,
  type ForceReply,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type InputRichMessage,
} from 'node-telegram-bot-api';
import { oneLine } from './copy.js';
import { richInline } from './rich-text.js';

export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface DialogButton {
  label: string;
  data: string;
  style?: ButtonStyle;
}

/** One screen of the control dialog. Buttons are the full-width keyboard under the message. */
export interface Dialog {
  title: string;
  lines: readonly string[];
  rows: readonly (readonly DialogButton[])[];
  /**
   * When set, Telegram opens the reply bar on a short follow-up message,
   * the same prompt BotFather uses when a step needs typed text.
   */
  replyPlaceholder?: string;
}

export const REPLY_PLACEHOLDER = 'username or chat id';

const BUTTONS_PER_ROW = 8;

export function button(label: string, data: string, style?: ButtonStyle): DialogButton {
  return style ? { label, data, style } : { label, data };
}

export function dialogLines(...parts: string[]): string[] {
  const lines: string[] = [];
  for (const part of parts) {
    for (const line of part.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
  }
  return lines;
}

export function renderDialog(dialog: Dialog): InputRichMessage {
  const builder = new RichMessageBuilder().heading(oneLine(dialog.title, 80), 2);
  appendLines(builder, dialog.lines);
  return builder.build();
}

/** Full-width keyboard under the message. Empty when the screen has no actions. */
export function dialogKeyboard(rows: Dialog['rows']): InlineKeyboardMarkup | undefined {
  const keyboard = rows
    .flatMap((row) => chunk(row.filter((item) => item.data.length > 0), BUTTONS_PER_ROW))
    .map((row) => row.map(keyboardButton));
  if (keyboard.length === 0) return undefined;
  return { inline_keyboard: keyboard };
}

function keyboardButton(item: DialogButton): InlineKeyboardButton {
  const style = item.style;
  return {
    text: oneLine(item.label, 64),
    callback_data: item.data,
    ...(style ? { style } : {}),
  };
}

function appendLines(builder: RichMessageBuilder, lines: readonly string[]): void {
  let index = 0;
  while (index < lines.length) {
    const line = oneLine(lines[index] ?? '', 1000);
    if (line === '---') {
      builder.divider();
      index += 1;
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (index < lines.length) {
        const item = oneLine(lines[index] ?? '', 1000);
        if (!item.startsWith('- ')) break;
        const text = richInline(item.slice(2));
        items.push(richListItem((nested) => nested.paragraph(text)));
        index += 1;
      }
      if (items.length > 0) builder.list(items);
      continue;
    }
    if (line.startsWith('> ')) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const item = oneLine(lines[index] ?? '', 1000);
        if (!item.startsWith('> ')) break;
        quoted.push(item.slice(2));
        index += 1;
      }
      builder.blockquote((nested) => {
        for (const item of quoted) nested.paragraph(richInline(item));
      });
      continue;
    }
    if (line !== 'Untitled chat' || (lines[index] ?? '').trim() === 'Untitled chat') builder.paragraph(richInline(line));
    index += 1;
  }
}

/** Reply markup that opens the native reply bar. Only valid on a newly sent message. */
export function replyMarkup(placeholder: string): ForceReply {
  return {
    force_reply: true,
    input_field_placeholder: oneLine(placeholder, 64),
  };
}

export function replyNudge(placeholder: string): Dialog {
  return {
    title: 'Reply',
    lines: ['Use the reply bar for a @username, a t.me/name link, or a numeric chat id.'],
    rows: [],
    replyPlaceholder: placeholder,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}
