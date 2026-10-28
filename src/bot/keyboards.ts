import { InlineKeyboardBuilder, type InlineKeyboardMarkup } from 'node-telegram-bot-api';
import type { ResolvedChat, Rule } from '../types.js';
import { oneLine } from './copy.js';
import type { Page } from './paging.js';

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder()
    .text('Create forwarding rule', 'new')
    .row()
    .text('View all rules', 'rules:0')
    .row()
    .text('Start / stop a rule', 'toggle:0')
    .row()
    .text('Edit rule', 'edit:0')
    .row()
    .text('Delete rule', 'del:0')
    .row()
    .text('View forwarding logs', 'logs:0')
    .row()
    .text('Settings', 'set')
    .build();
}

export function kindKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder()
    .text('Private user', 'kind:user')
    .row()
    .text('Group', 'kind:group')
    .row()
    .text('Channel', 'kind:channel')
    .row()
    .text('Back', 'back')
    .text('Cancel', 'cancel')
    .build();
}

export function chatPickerKeyboard(slice: Page<ResolvedChat>): InlineKeyboardMarkup {
  const builder = new InlineKeyboardBuilder();
  slice.items.forEach((chat, index) => {
    builder.text(oneLine(chat.title, 40), `pick:${index}`).row();
  });
  if (slice.page > 0) builder.text('Previous', `page:${slice.page - 1}`);
  if (slice.page + 1 < slice.pages) builder.text('Next', `page:${slice.page + 1}`);
  if (slice.pages > 1) builder.row();
  builder.text('Enter username or id', 'manual').row();
  builder.text('Back', 'back').text('Cancel', 'cancel');
  return builder.build();
}

export function confirmKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder().text('Confirm and activate', 'ok').row().text('Back', 'back').text('Cancel', 'cancel').build();
}

export function manualKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder().text('Back', 'back').text('Cancel', 'cancel').build();
}

export function rulesKeyboard(slice: Page<Rule>, mode: 'view' | 'toggle' | 'edit' | 'delete'): InlineKeyboardMarkup {
  const builder = new InlineKeyboardBuilder();
  const prefix = mode === 'view' ? 'rules' : mode === 'toggle' ? 'toggle' : mode === 'edit' ? 'edit' : 'del';
  const idPrefix = mode === 'toggle' ? 'toggle-id' : mode === 'edit' ? 'edit-id' : mode === 'delete' ? 'del-id' : '';
  if (mode !== 'view') {
    for (const rule of slice.items) {
      const verb = mode === 'toggle' ? (rule.status === 'active' ? 'Pause' : 'Start') : mode === 'edit' ? 'Edit' : 'Delete';
      builder.text(`${verb} #${rule.id} ${oneLine(rule.sourceTitle, 18)}`, `${idPrefix}:${rule.id}`).row();
    }
  }
  if (slice.page > 0) builder.text('Previous', `${prefix}:${slice.page - 1}`);
  if (slice.page + 1 < slice.pages) builder.text('Next', `${prefix}:${slice.page + 1}`);
  if (slice.pages > 1) builder.row();
  builder.text('Menu', 'menu');
  return builder.build();
}

export function editFieldKeyboard(ruleId: number): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder()
    .text('Change source', `edit-src:${ruleId}`)
    .row()
    .text('Change destination', `edit-dst:${ruleId}`)
    .row()
    .text('Menu', 'menu')
    .build();
}

export function deleteConfirmKeyboard(ruleId: number): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder().text('Delete rule', `del-yes:${ruleId}`).row().text('Menu', 'menu').build();
}

export function settingsKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder()
    .text('Pause all', 'set-pause')
    .text('Resume all', 'set-resume')
    .row()
    .text('Clear logs', 'set-clear')
    .row()
    .text('Menu', 'menu')
    .build();
}

export function clearLogsKeyboard(): InlineKeyboardMarkup {
  return new InlineKeyboardBuilder().text('Clear all logs', 'set-clear-yes').row().text('Back', 'set').build();
}
