import { openDatabase, type AppDatabase } from '../src/db/database.js';
import { LogRepository } from '../src/db/logs.js';
import { RuleRepository } from '../src/db/rules.js';
import type { ChatKind, InboundMessage, PeerClass, ResolvedChat } from '../src/types.js';

export function makeChat(overrides: Partial<ResolvedChat> & Pick<ResolvedChat, 'kind' | 'markedId'>): ResolvedChat {
  const peerClass: PeerClass = overrides.peerClass ?? (overrides.kind === 'user' ? 'user' : 'channel');
  return {
    kind: overrides.kind,
    markedId: overrides.markedId,
    rawId: overrides.rawId ?? overrides.markedId.replace(/^-100/, '').replace(/^-/, ''),
    peerClass,
    title: overrides.title ?? `${overrides.kind} ${overrides.markedId}`,
    username: overrides.username ?? null,
    accessHash: overrides.accessHash === undefined ? '123456789' : overrides.accessHash,
    self: overrides.self ?? false,
  };
}

export function memoryDb(): { db: AppDatabase; rules: RuleRepository; logs: LogRepository } {
  const db = openDatabase(':memory:');
  return { db, rules: new RuleRepository(db), logs: new LogRepository(db) };
}

export function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 10,
    chatId: '100',
    out: false,
    senderId: '50',
    noforwards: false,
    service: false,
    hasContent: true,
    ...overrides,
  };
}

export const KINDS: ChatKind[] = ['user', 'group', 'channel'];
