import { TelegramApiError, type Context, type InputRichMessage } from 'node-telegram-bot-api';
import { renderDialog, replyMarkup, type Dialog } from './dialog.js';

export interface Presented {
  kind: 'edited' | 'sent';
  messageId: number | undefined;
}

/**
 * Show a dialog. Button taps rewrite the same message. A reply placeholder
 * always sends a new message, because Telegram only opens the reply bar on send
 * and will not attach it by editing.
 */
export async function present(ctx: Context, dialog: Dialog): Promise<Presented> {
  const rich = renderDialog(dialog);
  const chatId = ctx.chatId;
  if (chatId === undefined) return { kind: 'sent', messageId: undefined };

  if (dialog.replyPlaceholder) {
    const sent = await ctx.api.sendRichMessage({
      chat_id: chatId,
      rich_message: rich,
      reply_markup: replyMarkup(dialog.replyPlaceholder),
    });
    return { kind: 'sent', messageId: sent.message_id };
  }

  const messageId = ctx.callbackQuery?.message?.message_id;
  if (messageId !== undefined) {
    const edited = await editDialog(ctx, chatId, messageId, rich);
    if (edited !== 'replace') return { kind: 'edited', messageId };
  }

  const sent = await ctx.api.sendRichMessage({ chat_id: chatId, rich_message: rich });
  return { kind: 'sent', messageId: sent.message_id };
}

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.description.toLowerCase().includes('message is not modified');
}

async function editDialog(
  ctx: Context,
  chatId: number,
  messageId: number,
  rich: InputRichMessage,
): Promise<'edited' | 'replace'> {
  try {
    await ctx.api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      rich_message: rich,
      reply_markup: { inline_keyboard: [] },
    });
    return 'edited';
  } catch (error) {
    if (isNotModified(error)) return 'edited';
    if (isMarkupRejected(error)) {
      try {
        await ctx.api.editMessageText({ chat_id: chatId, message_id: messageId, rich_message: rich });
        return 'edited';
      } catch (retry) {
        if (isNotModified(retry)) return 'edited';
        if (shouldSendInstead(retry)) return 'replace';
        throw retry;
      }
    }
    if (shouldSendInstead(error)) return 'replace';
    throw error;
  }
}

function isMarkupRejected(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.errorCode !== 400) return false;
  const text = error.description.toLowerCase();
  return text.includes('keyboard') || text.includes('markup');
}

function shouldSendInstead(error: unknown): boolean {
  if (!(error instanceof TelegramApiError) || error.errorCode !== 400) return false;
  const text = error.description.toLowerCase();
  return (
    text.includes("can't be edited") ||
    text.includes('can not be edited') ||
    text.includes('message to edit not found') ||
    text.includes('there is no text') ||
    text.includes('message identifier')
  );
}
