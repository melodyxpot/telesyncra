import { RichMessageBuilder, richMessageButton, type ForceReply, type InputRichMessage } from 'node-telegram-bot-api';
import { oneLine } from './copy.js';

export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface DialogButton {
  label: string;
  data: string;
  style?: ButtonStyle;
}

/** One screen of the control dialog. Buttons are drawn inside the message. */
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
  for (const line of dialog.lines) {
    const text = oneLine(line, 1000);
    if (text !== 'Untitled chat' || line.trim() === 'Untitled chat') builder.paragraph(text);
  }
  const rows = dialog.rows.flatMap((row) => chunk(row.filter((item) => item.data.length > 0), BUTTONS_PER_ROW));
  if (rows.length > 0) builder.divider();
  for (const row of rows) {
    builder.buttons(
      row.map((item) => {
        const style = item.style;
        return richMessageButton(oneLine(item.label, 64), {
          callback_data: item.data,
          ...(style ? { style } : {}),
        });
      }),
    );
  }
  return builder.build();
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
