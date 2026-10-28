import type { InboundMessage, Rule } from '../types.js';

export type SkipReason =
  | 'own_message'
  | 'other_chat'
  | 'before_baseline'
  | 'service_message'
  | 'protected'
  | 'empty'
  | 'rule_inactive';

export type ForwardDecision = { action: 'forward' } | { action: 'skip'; reason: SkipReason };

export function evaluateInbound(message: InboundMessage, rule: Rule, selfUserId: string): ForwardDecision {
  if (rule.status !== 'active') return skip('rule_inactive');
  if (message.chatId !== rule.sourceMarkedId) return skip('other_chat');
  if (message.out || (message.senderId !== null && message.senderId === selfUserId)) return skip('own_message');
  if (!Number.isInteger(message.messageId) || message.messageId <= rule.baselineMessageId) {
    return skip('before_baseline');
  }
  if (message.service) return skip('service_message');
  if (message.noforwards) return skip('protected');
  if (!message.hasContent) return skip('empty');
  return { action: 'forward' };
}

function skip(reason: SkipReason): ForwardDecision {
  return { action: 'skip', reason };
}
