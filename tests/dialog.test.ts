import type { InputRichBlock } from 'node-telegram-bot-api';
import { describe, expect, it } from 'vitest';
import { parseCallback } from '../src/access/callbacks.js';
import { dialogKeyboard, dialogLines, renderDialog, replyMarkup, replyNudge, type Dialog } from '../src/bot/dialog.js';
import { formatChat } from '../src/bot/copy.js';
import { richInline } from '../src/bot/rich-text.js';
import {
  chatPickerRows,
  confirmRows,
  deleteConfirmRows,
  kindRows,
  mainMenuRows,
  rulesRows,
} from '../src/bot/keyboards.js';
import { makeChat } from './fixtures.js';
import type { Rule } from '../src/types.js';

describe('dialog', () => {
  it('builds a BotFather-style card with styled callback buttons', () => {
    const dialog: Dialog = {
      title: 'Telesyncra',
      lines: dialogLines('Forward new messages.\n\nThis bot only controls the rules.'),
      rows: mainMenuRows(),
    };
    const rich = renderDialog(dialog);
    const blocks = rich.blocks ?? [];
    expect(blocks[0]).toMatchObject({ type: 'heading', text: 'Telesyncra', size: 2 });
    expect(textBlocks(blocks, 'paragraph')).toEqual([
      'Forward new messages.',
      'This bot only controls the rules.',
    ]);
    expect(blocks.some((block) => block.type === 'buttons')).toBe(false);
    const keyboard = dialogKeyboard(dialog.rows);
    const buttons = keyboard?.inline_keyboard.flat() ?? [];
    expect(buttons[0]).toMatchObject({ text: 'Create a rule', callback_data: 'new', style: 'primary' });
    expect(buttons.map((item) => item.callback_data).every((data) => data !== undefined && parseCallback(data) !== null)).toBe(true);
    expect(replyMarkup('username or chat id')).toEqual({
      force_reply: true,
      input_field_placeholder: 'username or chat id',
    });
  });

  it('keeps chat titles as plain text and opens a reply nudge', () => {
    const nasty = ' <script> & "quotes" \n second';
    const dialog: Dialog = {
      title: 'Source',
      lines: [`Chat ${nasty}`],
      rows: chatPickerRows({
        page: 1,
        pages: 3,
        items: [makeChat({ kind: 'channel', markedId: '-1001', title: nasty })],
      }),
    };
    const rich = renderDialog(dialog);
    expect(textBlocks(rich.blocks ?? [], 'paragraph').join('\n')).toContain('<script>');
    expect(JSON.stringify(rich)).not.toContain('callback_data');
    const buttons = dialogKeyboard(dialog.rows)?.inline_keyboard ?? [];
    expect(buttons[1]?.map((item) => item.callback_data)).toEqual(['page:0', 'page:2']);
    expect(buttons.at(-2)?.map((item) => item.text)).toEqual(['Back']);
    expect(buttons.at(-1)?.map((item) => item.text)).toEqual(['Cancel']);

    const nudge = replyNudge('username or chat id');
    expect(nudge.replyPlaceholder).toBe('username or chat id');
    expect(renderDialog(nudge).blocks?.some((block) => block.type === 'buttons')).toBe(false);
    expect(replyMarkup('x'.repeat(80)).input_field_placeholder).toHaveLength(64);
  });

  it('marks confirm, start, and delete with the matching button style', () => {
    expect(confirmRows()[0]?.[0]).toMatchObject({ data: 'ok', style: 'success' });
    expect(deleteConfirmRows(4)[0]?.[0]).toMatchObject({ data: 'del-yes:4', style: 'danger' });
    const rows = rulesRows(
      {
        page: 0,
        pages: 1,
        items: [rule(3, 'paused'), rule(4, 'active')],
      },
      'toggle',
    );
    expect(rows[0]?.[0]).toMatchObject({ data: 'toggle-id:3', style: 'success' });
    expect(rows[1]?.[0]?.style).toBeUndefined();
    expect(kindRows().flat().every((item) => parseCallback(item.data) !== null)).toBe(true);
    expect(dialogKeyboard(mainMenuRows())?.inline_keyboard[4]?.[0]).toMatchObject({
      text: 'Delete a rule',
      style: 'danger',
    });
  });

  it('formats dialog copy and leaves chat titles literal', () => {
    const rich = renderDialog({
      title: 'Review the rule',
      lines: dialogLines(
        `**From** ${formatChat(makeChat({ kind: 'user', markedId: '10', title: '**Ada**' }))}`,
        '- Messages sent by your account are skipped.',
        '---',
        '*Sender hidden*',
      ),
      rows: [],
    });
    const blocks = rich.blocks ?? [];
    const from = blocks.find((block) => block.type === 'paragraph' && 'text' in block && Array.isArray(block.text));
    expect(from && 'text' in from ? from.text : []).toEqual([
      { type: 'bold', text: 'From' },
      ' private user: **Ada** [10]',
    ]);
    expect(blocks.some((block) => block.type === 'list')).toBe(true);
    expect(blocks.some((block) => block.type === 'divider')).toBe(true);
    expect(richInline('*Sender hidden*')).toEqual([{ type: 'italic', text: 'Sender hidden' }]);
    expect(dialogKeyboard([])).toBeUndefined();
  });
});

function textBlocks(blocks: readonly InputRichBlock[], type: string): string[] {
  return blocks.flatMap((block) => (block.type === type && 'text' in block && typeof block.text === 'string' ? [block.text] : []));
}

function rule(id: number, status: Rule['status']): Rule {
  return {
    id,
    status,
    sourceKind: 'user',
    sourceMarkedId: '10',
    sourceRawId: '10',
    sourcePeerClass: 'user',
    sourceTitle: 'Ada',
    sourceUsername: null,
    sourceAccessHash: '1',
    destKind: 'channel',
    destMarkedId: '-1001',
    destRawId: '1',
    destPeerClass: 'channel',
    destTitle: 'News',
    destUsername: 'news',
    destAccessHash: '2',
    hideSender: true,
    baselineMessageId: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}
