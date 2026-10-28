import bigInt from 'big-integer';
import { Api } from 'telegram';
import { TITLE_MAX } from '../constants.js';
import { AppError, RuleError } from '../errors.js';
import type { ChatKind, PeerClass, ResolvedChat, Rule, StoredPeer } from '../types.js';

export function markedIdFor(peerClass: PeerClass, rawId: string): string {
  if (!/^[1-9]\d{0,19}$/.test(rawId)) throw new AppError('Chat id is invalid.');
  if (peerClass === 'user') return rawId;
  if (peerClass === 'chat') return `-${rawId}`;
  return `-100${rawId}`;
}

export function kindLabel(kind: ChatKind): string {
  if (kind === 'user') return 'private user';
  if (kind === 'group') return 'group';
  return 'channel';
}

export function assertRulePair(source: ResolvedChat, destination: ResolvedChat, selfUserId: string): void {
  if (source.markedId === destination.markedId) {
    throw new RuleError('Source and destination must be different chats.');
  }
  if (source.self || source.markedId === selfUserId) {
    throw new RuleError('Your own account cannot be the source. Messages you send are never forwarded.');
  }
  requireAccess(source, 'source');
  requireAccess(destination, 'destination');
}

export function peerFromRule(rule: Rule, side: 'source' | 'dest'): StoredPeer {
  if (side === 'source') {
    return {
      markedId: rule.sourceMarkedId,
      rawId: rule.sourceRawId,
      peerClass: rule.sourcePeerClass,
      accessHash: rule.sourceAccessHash,
    };
  }
  return {
    markedId: rule.destMarkedId,
    rawId: rule.destRawId,
    peerClass: rule.destPeerClass,
    accessHash: rule.destAccessHash,
  };
}

export function chatFromRule(rule: Rule, side: 'source' | 'dest'): ResolvedChat {
  const peer = peerFromRule(rule, side);
  if (side === 'source') {
    return {
      ...peer,
      kind: rule.sourceKind,
      title: rule.sourceTitle,
      username: rule.sourceUsername,
      self: false,
    };
  }
  return {
    ...peer,
    kind: rule.destKind,
    title: rule.destTitle,
    username: rule.destUsername,
    self: false,
  };
}

export function toInputPeer(peer: StoredPeer): Api.TypeInputPeer {
  if (peer.peerClass === 'user') {
    if (!peer.accessHash) throw new AppError('Missing access information for a private chat.');
    return new Api.InputPeerUser({
      userId: bigInt(peer.rawId),
      accessHash: bigInt(peer.accessHash),
    });
  }
  if (peer.peerClass === 'chat') {
    return new Api.InputPeerChat({ chatId: bigInt(peer.rawId) });
  }
  if (!peer.accessHash) throw new AppError('Missing access information for a channel or supergroup.');
  return new Api.InputPeerChannel({
    channelId: bigInt(peer.rawId),
    accessHash: bigInt(peer.accessHash),
  });
}

export function fromEntity(entity: unknown): ResolvedChat | null {
  if (entity instanceof Api.User) return fromUser(entity);
  if (entity instanceof Api.Chat) return fromBasicGroup(entity);
  if (entity instanceof Api.Channel) return fromChannel(entity);
  return null;
}

function fromUser(user: Api.User): ResolvedChat | null {
  if (user.deleted) return null;
  const rawId = unsignedId(user.id);
  if (!rawId) return null;
  const username = usernameOf(user);
  const title = user.self ? 'Saved Messages' : displayName(user, username, rawId);
  return {
    kind: 'user',
    markedId: markedIdFor('user', rawId),
    rawId,
    peerClass: 'user',
    title,
    username,
    accessHash: hashOf(user.accessHash),
    self: user.self === true,
  };
}

function fromBasicGroup(chat: Api.Chat): ResolvedChat | null {
  if (chat.left || chat.deactivated) return null;
  const rawId = unsignedId(chat.id);
  if (!rawId) return null;
  return {
    kind: 'group',
    markedId: markedIdFor('chat', rawId),
    rawId,
    peerClass: 'chat',
    title: cleanTitle(chat.title),
    username: null,
    accessHash: null,
    self: false,
  };
}

function fromChannel(channel: Api.Channel): ResolvedChat | null {
  if (channel.left) return null;
  const rawId = unsignedId(channel.id);
  if (!rawId) return null;
  const kind: ChatKind = channel.megagroup || channel.gigagroup ? 'group' : 'channel';
  return {
    kind,
    markedId: markedIdFor('channel', rawId),
    rawId,
    peerClass: 'channel',
    title: cleanTitle(channel.title),
    username: usernameOf(channel),
    accessHash: hashOf(channel.accessHash),
    self: false,
  };
}

function requireAccess(chat: ResolvedChat, side: string): void {
  if (chat.peerClass !== 'chat' && !chat.accessHash) {
    throw new RuleError(
      `Telesyncra could not store access information for the ${side} chat. Open that chat in Telegram and try again.`,
    );
  }
}

function unsignedId(value: { toString(): string }): string | null {
  const raw = value.toString();
  return /^[1-9]\d{0,19}$/.test(raw) ? raw : null;
}

function hashOf(value: { toString(): string } | undefined): string | null {
  if (value == null) return null;
  const hash = value.toString();
  return /^-?\d+$/.test(hash) ? hash : null;
}

function usernameOf(entity: { username?: string; usernames?: Array<{ username?: string; active?: boolean }> }): string | null {
  if (typeof entity.username === 'string' && entity.username.length > 0) return entity.username;
  const names = entity.usernames;
  if (!Array.isArray(names)) return null;
  for (const item of names) {
    if (item && typeof item.username === 'string' && item.username.length > 0 && item.active !== false) {
      return item.username;
    }
  }
  return null;
}

function displayName(user: Api.User, username: string | null, rawId: string): string {
  const parts = [user.firstName, user.lastName].filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length > 0) return cleanTitle(parts.join(' '));
  if (username) return `@${username}`;
  return `User ${rawId}`;
}

export function cleanTitle(value: string): string {
  let output = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    output += code <= 31 || code === 127 ? ' ' : char;
  }
  const cleaned = output.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, TITLE_MAX) || 'Untitled chat';
}
