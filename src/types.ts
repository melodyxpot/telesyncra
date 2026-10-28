export type ChatKind = 'user' | 'group' | 'channel';
export type PeerClass = 'user' | 'chat' | 'channel';
export type RuleStatus = 'active' | 'paused';
export type ProcessStatus = 'pending' | 'forwarded' | 'skipped' | 'error';
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface ResolvedChat {
  kind: ChatKind;
  markedId: string;
  rawId: string;
  peerClass: PeerClass;
  title: string;
  username: string | null;
  accessHash: string | null;
  self: boolean;
}

export interface StoredPeer {
  markedId: string;
  rawId: string;
  peerClass: PeerClass;
  accessHash: string | null;
}

export interface Rule {
  id: number;
  sourceKind: ChatKind;
  sourceMarkedId: string;
  sourceRawId: string;
  sourcePeerClass: PeerClass;
  sourceTitle: string;
  sourceUsername: string | null;
  sourceAccessHash: string | null;
  destKind: ChatKind;
  destMarkedId: string;
  destRawId: string;
  destPeerClass: PeerClass;
  destTitle: string;
  destUsername: string | null;
  destAccessHash: string | null;
  status: RuleStatus;
  hideSender: boolean;
  baselineMessageId: number;
  createdAt: number;
  updatedAt: number;
}

export interface InboundMessage {
  messageId: number;
  chatId: string;
  out: boolean;
  senderId: string | null;
  noforwards: boolean;
  service: boolean;
  hasContent: boolean;
}

export interface ForwardLog {
  id: number;
  ruleId: number | null;
  sourceChatId: string | null;
  messageId: number | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail: string | null;
  createdAt: number;
}
