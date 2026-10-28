import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyTelegramError, nextAttempt } from '../src/engine/errors.js';
import { forwardBatch } from '../src/engine/forward-batch.js';
import { evaluateInbound } from '../src/engine/policy.js';
import { mapIncoming } from '../src/telegram/map-message.js';
import type { Rule } from '../src/types.js';
import { inbound, makeChat, memoryDb } from './fixtures.js';

const open: Array<{ close(): void }> = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

describe('forwarding errors and policy', () => {
  it('skips own, foreign, old, service, empty, and protected messages before any forward', () => {
    const rule = sampleRule();
    expect(evaluateInbound(inbound({ out: true }), rule, '1').action).toBe('skip');
    expect(evaluateInbound(inbound({ senderId: '1' }), rule, '1')).toEqual({ action: 'skip', reason: 'own_message' });
    expect(evaluateInbound(inbound({ chatId: '999' }), rule, '1')).toEqual({ action: 'skip', reason: 'other_chat' });
    expect(evaluateInbound(inbound({ messageId: 4 }), rule, '1')).toEqual({ action: 'skip', reason: 'before_baseline' });
    expect(evaluateInbound(inbound({ service: true }), rule, '1')).toEqual({ action: 'skip', reason: 'service_message' });
    expect(evaluateInbound(inbound({ hasContent: false }), rule, '1')).toEqual({ action: 'skip', reason: 'empty' });
    expect(evaluateInbound(inbound({ noforwards: true }), rule, '1')).toEqual({ action: 'skip', reason: 'protected' });
    expect(evaluateInbound(inbound({ messageId: 11, hasContent: true }), rule, '1')).toEqual({ action: 'forward' });
    expect(evaluateInbound(inbound({ messageId: 11 }), { ...rule, status: 'paused' }, '1')).toEqual({
      action: 'skip',
      reason: 'rule_inactive',
    });
  });

  it('does not copy protected content and does not forward it twice', async () => {
    const { db, rules } = memoryDb();
    open.push(db);
    const rule = save(rules);
    let calls = 0;
    const deps = {
      claim: rules.claim.bind(rules),
      complete: rules.complete.bind(rules),
      nativeForward: async () => {
        calls += 1;
        throw { errorMessage: 'CHAT_FORWARDS_RESTRICTED' };
      },
      sleep: async () => undefined,
    };
    const message = inbound({ messageId: 12, chatId: rule.sourceMarkedId });
    const first = await forwardBatch(deps, rule, [message], '1');
    const second = await forwardBatch(deps, rule, [message], '1');
    expect(calls).toBe(1);
    expect(first.skipped).toEqual([{ messageId: 12, reason: 'CHAT_FORWARDS_RESTRICTED' }]);
    expect(first.failed).toEqual([]);
    expect(second.skipped).toEqual([{ messageId: 12, reason: 'duplicate' }]);
  });

  it('asks Telegram to hide the original sender when the rule says so', async () => {
    const { db, rules } = memoryDb();
    open.push(db);
    const rule = save(rules);
    const seen: boolean[] = [];
    await forwardBatch(
      {
        claim: rules.claim.bind(rules),
        complete: rules.complete.bind(rules),
        nativeForward: async (_source, _destination, _ids, dropAuthor) => {
          seen.push(dropAuthor);
        },
        sleep: async () => undefined,
      },
      rule,
      [inbound({ messageId: 16, chatId: rule.sourceMarkedId })],
      '1',
    );
    rules.setHideSender(rule.id, false);
    const shown = rules.get(rule.id);
    if (!shown) throw new Error('rule missing');
    await forwardBatch(
      {
        claim: rules.claim.bind(rules),
        complete: rules.complete.bind(rules),
        nativeForward: async (_source, _destination, _ids, dropAuthor) => {
          seen.push(dropAuthor);
        },
        sleep: async () => undefined,
      },
      shown,
      [inbound({ messageId: 17, chatId: shown.sourceMarkedId })],
      '1',
    );
    expect(seen).toEqual([true, false]);
  });

  it('retries a short flood wait once and refuses a long or ambiguous failure', async () => {
    const { db, rules } = memoryDb();
    open.push(db);
    const rule = save(rules);
    const slept: number[] = [];
    let floodCalls = 0;
    await forwardBatch(
      {
        claim: rules.claim.bind(rules),
        complete: rules.complete.bind(rules),
        nativeForward: async () => {
          floodCalls += 1;
          if (floodCalls === 1) throw { errorMessage: 'FLOOD_WAIT_5', seconds: 5 };
        },
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      rule,
      [inbound({ messageId: 13, chatId: rule.sourceMarkedId })],
      '1',
    );
    expect(floodCalls).toBe(2);
    expect(slept).toEqual([5000]);

    let longCalls = 0;
    const longResult = await forwardBatch(
      {
        claim: rules.claim.bind(rules),
        complete: rules.complete.bind(rules),
        nativeForward: async () => {
          longCalls += 1;
          throw { errorMessage: 'FLOOD_WAIT_200', seconds: 200 };
        },
        sleep: async () => undefined,
      },
      rule,
      [inbound({ messageId: 14, chatId: rule.sourceMarkedId })],
      '1',
    );
    expect(longCalls).toBe(1);
    expect(longResult.failed[0]?.code).toBe('FLOOD_WAIT_200');

    let networkCalls = 0;
    const network = await forwardBatch(
      {
        claim: rules.claim.bind(rules),
        complete: rules.complete.bind(rules),
        nativeForward: async () => {
          networkCalls += 1;
          const error = new Error('socket hang up');
          (error as { code?: string }).code = 'ECONNRESET';
          throw error;
        },
        sleep: async () => undefined,
      },
      rule,
      [inbound({ messageId: 15, chatId: rule.sourceMarkedId })],
      '1',
    );
    expect(networkCalls).toBe(1);
    expect(network.failed).toHaveLength(1);

    const permission = classifyTelegramError({ errorMessage: 'CHAT_WRITE_FORBIDDEN' });
    expect(permission.category).toBe('permission');
    expect(permission.retryable).toBe(false);
    expect(permission.allowCopyFallback).toBe(false);
    expect(nextAttempt(permission, 1)).toEqual({ action: 'stop' });
    expect(classifyTelegramError({ errorMessage: 'CHAT_FORWARDS_RESTRICTED' }).allowCopyFallback).toBe(false);
  });

  it('keeps message text out of the mapped update and does not implement a bypass', () => {
    const mapped = mapIncoming({
      id: 4,
      chatId: { toString: () => '15' },
      message: 'secret caption',
      media: { photo: true },
      out: false,
    });
    expect(mapped?.inbound.hasContent).toBe(true);
    expect(JSON.stringify(mapped)).not.toContain('secret caption');
    expect(mapped?.inbound).not.toHaveProperty('message');

    const source = ['engine/forward-batch.ts', 'engine/engine.ts', 'telegram/forward.ts']
      .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(source).toContain('forwardMessages');
    expect(source).toContain('dropAuthor');
    expect(source).not.toMatch(/copyMessage|sendFile|uploadFile/);
  });
});

function sampleRule(): Rule {
  return {
    id: 1,
    sourceKind: 'user',
    sourceMarkedId: '100',
    sourceRawId: '100',
    sourcePeerClass: 'user',
    sourceTitle: 'Ada',
    sourceUsername: null,
    sourceAccessHash: '1',
    destKind: 'user',
    destMarkedId: '200',
    destRawId: '200',
    destPeerClass: 'user',
    destTitle: 'Bea',
    destUsername: null,
    destAccessHash: '2',
    status: 'active',
    hideSender: true,
    notify: 'off',
    ownerUserId: '1',
    baselineMessageId: 4,
    createdAt: 1,
    updatedAt: 1,
  };
}

function save(rules: ReturnType<typeof memoryDb>['rules']): Rule {
  return rules.create({
    source: makeChat({ kind: 'user', markedId: '100', rawId: '100' }),
    destination: makeChat({ kind: 'channel', markedId: '-100200', rawId: '200' }),
    selfUserId: '1',
    baselineMessageId: 4,
  });
}
