import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { DIALOG_CACHE_MS, DIALOG_LIMIT } from '../constants.js';
import { ChatResolveError } from '../errors.js';
import type { ChatKind, ResolvedChat } from '../types.js';
import { telegramErrorCode } from './error-code.js';
import { fromEntity, kindLabel, toInputPeer } from './peers.js';
import { numericAttempts, parseChatReference } from './reference.js';

export class ChatDirectory {
  private cache: { at: number; chats: ResolvedChat[] } | null = null;

  constructor(private readonly client: TelegramClient) {}

  async list(kind: ChatKind, includeSelf: boolean): Promise<ResolvedChat[]> {
    const chats = await this.load();
    return chats.filter((chat) => chat.kind === kind && (includeSelf || !chat.self));
  }

  async resolve(raw: string, expectedKind: ChatKind): Promise<ResolvedChat> {
    const parsed = parseChatReference(raw);
    if (!parsed.ok) throw new ChatResolveError('INVALID_INPUT', parsed.error);
    if (parsed.value.type === 'username') {
      const chat = await this.entityToChat(parsed.value.username);
      return this.expectKind(chat, expectedKind);
    }
    let mismatch: ResolvedChat | null = null;
    let lastCode = 'NOT_FOUND';
    for (const attempt of numericAttempts(parsed.value.id, expectedKind)) {
      try {
        const chat = await this.entityToChat(attempt);
        if (chat.kind === expectedKind) return chat;
        mismatch = chat;
      } catch (error) {
        const code = error instanceof ChatResolveError ? error.code : telegramErrorCode(error);
        if (code.startsWith('FLOOD_WAIT') || code.startsWith('SLOWMODE_WAIT')) throw publicError(code);
        lastCode = code;
      }
    }
    if (mismatch) {
      throw new ChatResolveError(
        'KIND_MISMATCH',
        `That chat is a ${kindLabel(mismatch.kind)}, not a ${kindLabel(expectedKind)}.`,
      );
    }
    throw publicError(lastCode);
  }

  async latestMessageId(chat: ResolvedChat): Promise<number> {
    try {
      const messages = await this.client.getMessages(toInputPeer(chat), { limit: 1 });
      return messages[0]?.id ?? 0;
    } catch (error) {
      throw publicError(telegramErrorCode(error));
    }
  }

  private async load(): Promise<ResolvedChat[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < DIALOG_CACHE_MS) return this.cache.chats;
    let dialogs;
    try {
      // Do not pass ignoreMigrated. In GramJS 2.26 that flag keeps only chats
      // that already have migratedTo, which drops every private chat and channel.
      dialogs = [
        ...(await this.client.getDialogs({ limit: DIALOG_LIMIT })),
        ...(await this.client.getDialogs({ limit: 100, folder: 1 }).catch(() => [])),
      ];
    } catch (error) {
      if (error instanceof ChatResolveError) throw error;
      const code = telegramErrorCode(error);
      if (code.startsWith('FLOOD_WAIT') || code.startsWith('SLOWMODE_WAIT')) throw publicError(code);
      throw new ChatResolveError(code, 'Could not load chats from your account. Try again in a moment.');
    }
    const chats: ResolvedChat[] = [];
    const seen = new Set<string>();
    const add = (entity: unknown): void => {
      if (isRetiredBasicGroup(entity)) return;
      const chat = fromEntity(entity);
      if (!chat || seen.has(chat.markedId)) return;
      if (chat.peerClass !== 'chat' && !chat.accessHash) return;
      seen.add(chat.markedId);
      chats.push(chat);
    };
    for (const dialog of dialogs) add(dialog.entity);
    for (const contact of await this.contacts().catch(() => [])) add(contact);
    this.cache = { at: now, chats };
    return chats;
  }

  private async contacts(): Promise<Api.TypeUser[]> {
    const result = await this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
    if (!(result instanceof Api.contacts.Contacts)) return [];
    return result.users;
  }

  private async entityToChat(entityLike: string): Promise<ResolvedChat> {
    try {
      const entity = await this.client.getEntity(entityLike);
      const chat = fromEntity(entity);
      if (!chat) throw new ChatResolveError('UNAVAILABLE', 'That chat is not available to this account.');
      return chat;
    } catch (error) {
      if (error instanceof ChatResolveError) throw error;
      throw publicError(telegramErrorCode(error));
    }
  }

  private expectKind(chat: ResolvedChat, expectedKind: ChatKind): ResolvedChat {
    if (chat.kind !== expectedKind) {
      throw new ChatResolveError(
        'KIND_MISMATCH',
        `That chat is a ${kindLabel(chat.kind)}, not a ${kindLabel(expectedKind)}.`,
      );
    }
    return chat;
  }
}

/** A basic group that Telegram already replaced with a supergroup. The new chat is listed separately. */
export function isRetiredBasicGroup(entity: unknown): boolean {
  if (!entity || typeof entity !== 'object' || !('migratedTo' in entity)) return false;
  return (entity as { migratedTo?: unknown }).migratedTo != null;
}

function publicError(code: string): ChatResolveError {
  if (code.startsWith('FLOOD_WAIT') || code.startsWith('SLOWMODE_WAIT')) {
    return new ChatResolveError(code, 'Telegram rate-limited this request. Wait a few minutes and try again.');
  }
  if (code === 'USERNAME_INVALID' || code === 'USERNAME_NOT_OCCUPIED') {
    return new ChatResolveError(code, 'That username was not found.');
  }
  if (code === 'PEER_ID_INVALID' || code === 'CHAT_ID_INVALID' || code === 'CHANNEL_INVALID') {
    return new ChatResolveError(
      code,
      'That chat was not found for this account. Join it first, then pick it from the list or send its numeric id.',
    );
  }
  if (code === 'CHANNEL_PRIVATE' || code === 'USER_NOT_PARTICIPANT') {
    return new ChatResolveError(code, 'Your account cannot access that private chat.');
  }
  return new ChatResolveError(code, 'Could not open that chat with your account.');
}
