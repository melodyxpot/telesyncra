import type { RuleRepository } from '../db/rules.js';
import { peerFromRule } from '../telegram/peers.js';
import type { InboundMessage, Rule, StoredPeer } from '../types.js';
import { classifyTelegramError, nextAttempt } from './errors.js';
import { evaluateInbound } from './policy.js';

export interface ForwardDeps {
  claim: RuleRepository['claim'];
  complete: RuleRepository['complete'];
  nativeForward(source: StoredPeer, destination: StoredPeer, messageIds: number[], dropAuthor: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface ForwardOutcome {
  forwarded: number[];
  skipped: Array<{ messageId: number; reason: string }>;
  failed: Array<{ messageId: number; code: string }>;
}

export async function forwardBatch(deps: ForwardDeps, rule: Rule, messages: InboundMessage[], selfUserId: string): Promise<ForwardOutcome> {
  const outcome: ForwardOutcome = { forwarded: [], skipped: [], failed: [] };
  const toSend: number[] = [];
  for (const message of messages) {
    const decision = evaluateInbound(message, rule, selfUserId);
    if (decision.action === 'skip') {
      outcome.skipped.push({ messageId: message.messageId, reason: decision.reason });
      continue;
    }
    if (!deps.claim(rule.id, message.chatId, message.messageId)) {
      outcome.skipped.push({ messageId: message.messageId, reason: 'duplicate' });
      continue;
    }
    toSend.push(message.messageId);
  }
  if (toSend.length === 0) return outcome;
  toSend.sort((left, right) => left - right);

  const source = peerFromRule(rule, 'source');
  const destination = peerFromRule(rule, 'dest');
  let attemptsMade = 0;
  while (true) {
    attemptsMade += 1;
    try {
      await deps.nativeForward(source, destination, toSend, rule.hideSender);
      for (const messageId of toSend) {
        deps.complete(rule.id, rule.sourceMarkedId, messageId, 'forwarded', null);
        outcome.forwarded.push(messageId);
      }
      return outcome;
    } catch (error) {
      const classified = classifyTelegramError(error);
      const plan = nextAttempt(classified, attemptsMade);
      if (plan.action === 'retry') {
        await deps.sleep(plan.delayMs);
        continue;
      }
      const status = classified.category === 'protected' ? 'skipped' : 'error';
      for (const messageId of toSend) {
        deps.complete(rule.id, rule.sourceMarkedId, messageId, status, classified.code);
        if (status === 'skipped') outcome.skipped.push({ messageId, reason: classified.code });
        else outcome.failed.push({ messageId, code: classified.code });
      }
      return outcome;
    }
  }
}
