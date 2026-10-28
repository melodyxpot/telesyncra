import type { NotifyMode, ResolvedChat, Rule } from '../types.js';
import { oneLine } from './copy.js';
import { button, type DialogButton } from './dialog.js';
import { nextNotifyMode, notifyActionLabel } from './notify-mode.js';
import type { Page } from './paging.js';

export function mainMenuRows(options: { admin?: boolean; signedIn?: boolean } = { signedIn: true }): DialogButton[][] {
  const signedIn = options.signedIn !== false;
  const rows: DialogButton[][] = signedIn
    ? [
        [button('Create a rule', 'new', 'primary')],
        [button('My rules', 'rules:0')],
        [button('Start or pause', 'toggle:0', 'success')],
        [button('Edit a rule', 'edit:0')],
        [button('Delete a rule', 'del:0', 'danger')],
        [button('Logs', 'logs:0')],
        [button('Settings', 'set')],
      ]
    : [[button('Sign in', 'signin', 'primary')]];
  if (options.admin) {
    rows.push([button('Create an invite', 'inv-new')], [button('People', 'people')]);
  }
  return rows;
}

export function kindRows(): DialogButton[][] {
  return [
    [button('Private user', 'kind:user', 'primary')],
    [button('Group', 'kind:group', 'primary')],
    [button('Channel', 'kind:channel', 'primary')],
    ...navRows(),
  ];
}

export function chatPickerRows(slice: Page<ResolvedChat>): DialogButton[][] {
  const rows: DialogButton[][] = slice.items.map((chat, index) => [button(oneLine(chat.title, 40), `pick:${index}`)]);
  const pager = pageRow(slice.page, slice.pages, 'page');
  if (pager.length > 0) rows.push(pager);
  rows.push([button('Enter username or id', 'manual', 'primary')]);
  rows.push(...navRows());
  return rows;
}

export function confirmRows(hideSender?: boolean, notify?: NotifyMode): DialogButton[][] {
  const rows: DialogButton[][] = [];
  if (hideSender !== undefined) {
    rows.push([
      button(hideSender ? 'Show original sender' : 'Hide original sender', hideSender ? 'sender:0' : 'sender:1'),
    ]);
  }
  if (notify !== undefined) {
    rows.push([button(notifyActionLabel(notify), `note:${nextNotifyMode(notify)}`)]);
  }
  rows.push([button('Confirm and activate', 'ok', 'success')], ...navRows());
  return rows;
}

export function manualRows(): DialogButton[][] {
  return navRows();
}

export function rulesRows(slice: Page<Rule>, mode: 'view' | 'toggle' | 'edit' | 'delete'): DialogButton[][] {
  const rows: DialogButton[][] = [];
  const prefix = mode === 'view' ? 'rules' : mode === 'toggle' ? 'toggle' : mode === 'edit' ? 'edit' : 'del';
  if (mode !== 'view') {
    for (const rule of slice.items) {
      if (mode === 'toggle') {
        const starting = rule.status !== 'active';
        rows.push([
          button(
            `${starting ? 'Start' : 'Pause'} #${rule.id} ${oneLine(rule.sourceTitle, 18)}`,
            `toggle-id:${rule.id}`,
            starting ? 'success' : undefined,
          ),
        ]);
      } else if (mode === 'edit') {
        rows.push([button(`Edit #${rule.id} ${oneLine(rule.sourceTitle, 18)}`, `edit-id:${rule.id}`)]);
      } else {
        rows.push([button(`Delete #${rule.id} ${oneLine(rule.sourceTitle, 18)}`, `del-id:${rule.id}`, 'danger')]);
      }
    }
  }
  const pager = pageRow(slice.page, slice.pages, prefix);
  if (pager.length > 0) rows.push(pager);
  rows.push([button('Menu', 'menu')]);
  return rows;
}

export function editFieldRows(ruleId: number, hideSender: boolean, notify: NotifyMode): DialogButton[][] {
  return [
    [button('Change source', `edit-src:${ruleId}`)],
    [button('Change destination', `edit-dst:${ruleId}`)],
    [button(hideSender ? 'Show original sender' : 'Hide original sender', `sender-id:${ruleId}`)],
    [button(notifyActionLabel(notify), `note-id:${ruleId}`)],
    [button('Menu', 'menu')],
  ];
}

export function peopleRows(people: readonly { userId: string; displayName: string }[]): DialogButton[][] {
  const rows = people.map((person) => [button(`Remove ${oneLine(person.displayName, 28)}`, `rm:${person.userId}`, 'danger')]);
  rows.push([button('Menu', 'menu')]);
  return rows;
}

export function removePersonRows(userId: string): DialogButton[][] {
  return [[button('Remove this person', `rm-yes:${userId}`, 'danger')], [button('People', 'people')]];
}

export function deleteConfirmRows(ruleId: number): DialogButton[][] {
  return [[button('Delete rule', `del-yes:${ruleId}`, 'danger')], [button('Menu', 'menu')]];
}

export function settingsRows(): DialogButton[][] {
  return [
    [button('Pause all', 'set-pause')],
    [button('Resume all', 'set-resume', 'success')],
    [button('Clear logs', 'set-clear', 'danger')],
    [button('Menu', 'menu')],
  ];
}

export function clearLogsRows(): DialogButton[][] {
  return [[button('Clear all logs', 'set-clear-yes', 'danger')], [button('Back', 'set')]];
}

export function logsRows(page: number, pages: number): DialogButton[][] {
  const rows: DialogButton[][] = [];
  const pager = pageRow(page, pages, 'logs');
  if (pager.length > 0) rows.push(pager);
  rows.push([button('Menu', 'menu')]);
  return rows;
}

function navRows(): DialogButton[][] {
  return [[button('Back', 'back')], [button('Cancel', 'cancel')]];
}

function pageRow(page: number, pages: number, prefix: string): DialogButton[] {
  const row: DialogButton[] = [];
  if (page > 0) row.push(button('Previous', `${prefix}:${page - 1}`));
  if (page + 1 < pages) row.push(button('Next', `${prefix}:${page + 1}`));
  return row;
}
