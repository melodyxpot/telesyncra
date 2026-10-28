import type { NotifyMode } from '../types.js';

const ORDER: readonly NotifyMode[] = ['off', 'source', 'dest', 'both'];

export function nextNotifyMode(mode: NotifyMode): NotifyMode {
  const index = ORDER.indexOf(mode);
  return ORDER[(index + 1) % ORDER.length] ?? 'off';
}

export function notifyActionLabel(mode: NotifyMode): string {
  const next = nextNotifyMode(mode);
  if (next === 'off') return 'Turn notifications off';
  if (next === 'source') return 'Notify sending user';
  if (next === 'dest') return 'Notify receiving user';
  return 'Notify both';
}

export function notifySummary(mode: NotifyMode): string {
  if (mode === 'source') return '**Notifications.** The sending user hears when forwarding starts or pauses.';
  if (mode === 'dest') return '**Notifications.** The receiving user hears when forwarding starts or pauses.';
  if (mode === 'both') return '**Notifications.** Both the sending and receiving users hear when forwarding starts or pauses.';
  return '**Notifications.** Off. Nobody is told when forwarding starts or pauses.';
}

export function isNotifyMode(value: string): value is NotifyMode {
  return value === 'off' || value === 'source' || value === 'dest' || value === 'both';
}
