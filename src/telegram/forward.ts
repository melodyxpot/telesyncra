import { TelegramClient } from 'telegram';
import type { StoredPeer } from '../types.js';
import { toInputPeer } from './peers.js';

export function createNativeForwarder(client: TelegramClient): (source: StoredPeer, destination: StoredPeer, messageIds: number[]) => Promise<void> {
  return async (source, destination, messageIds) => {
    if (messageIds.length === 0) return;
    // Native forward. The author is left intact; Telegram rejects protected messages itself.
    await client.forwardMessages(toInputPeer(destination), {
      messages: messageIds,
      fromPeer: toInputPeer(source),
    });
  };
}
