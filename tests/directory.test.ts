import { describe, expect, it } from 'vitest';
import { isRetiredBasicGroup } from '../src/telegram/directory.js';

describe('chat list filtering', () => {
  it('keeps private chats and drops only basic groups that already moved', () => {
    expect(isRetiredBasicGroup({ id: 1, firstName: 'Ada' })).toBe(false);
    expect(isRetiredBasicGroup({ id: 2, title: 'Ops', migratedTo: undefined })).toBe(false);
    expect(isRetiredBasicGroup({ id: 2, title: 'Ops', migratedTo: null })).toBe(false);
    expect(isRetiredBasicGroup({ id: 3, title: 'Old', migratedTo: { chatId: 9 } })).toBe(true);
    expect(isRetiredBasicGroup(undefined)).toBe(false);
  });
});
