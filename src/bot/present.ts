import { TelegramApiError, type Context, type InlineKeyboardMarkup } from 'node-telegram-bot-api';

export async function present(ctx: Context, text: string, markup?: InlineKeyboardMarkup): Promise<void> {
  const messageId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chatId;
  if (messageId !== undefined && chatId !== undefined) {
    try {
      await ctx.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: markup,
      });
      return;
    } catch (error) {
      if (isNotModified(error)) return;
    }
  }
  await ctx.reply(text, markup ? { reply_markup: markup } : {});
}

function isNotModified(error: unknown): boolean {
  return error instanceof TelegramApiError && error.description.toLowerCase().includes('message is not modified');
}
