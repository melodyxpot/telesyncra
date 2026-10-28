import type { InboundMessage } from '../types.js';

export interface RawIncoming {
  id?: number;
  chatId?: { toString(): string } | null;
  senderId?: { toString(): string } | null;
  out?: boolean;
  message?: string;
  media?: unknown;
  action?: unknown;
  noforwards?: boolean;
  groupedId?: { toString(): string } | null;
}

export function mapIncoming(message: RawIncoming): { inbound: InboundMessage; groupedId: string | null } | null {
  if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || message.id <= 0) return null;
  if (!message.chatId) return null;
  const chatId = message.chatId.toString();
  if (!/^-?\d+$/.test(chatId)) return null;
  const hasText = typeof message.message === 'string' && message.message.length > 0;
  return {
    inbound: {
      messageId: message.id,
      chatId,
      out: message.out === true,
      senderId: message.senderId ? message.senderId.toString() : null,
      noforwards: message.noforwards === true,
      service: message.action != null,
      hasContent: hasText || message.media != null,
    },
    groupedId: message.groupedId ? message.groupedId.toString() : null,
  };
}
