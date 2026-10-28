import { TelegramClient } from 'telegram';
import type { StoredPeer } from '../types.js';
import { toInputPeer } from './peers.js';

export function createNativeForwarder(
  client: TelegramClient,
): (source: StoredPeer, destination: StoredPeer, messageIds: number[], dropAuthor: boolean) => Promise<void> {
  return async (source, destination, messageIds, dropAuthor) => {
    if (messageIds.length === 0) return;
    // Native forward. dropAuthor is Telegram's "hide sender name" flag.
    // Protected messages are still rejected by Telegram. The file is not downloaded or re-uploaded.
    await client.forwardMessages(toInputPeer(destination), {
      messages: messageIds,
      fromPeer: toInputPeer(source),
      dropAuthor,
    });
  };
}
