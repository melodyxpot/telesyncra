import { Bot, type Context } from 'node-telegram-bot-api';
import { parseCallback, type CallbackAction } from '../access/callbacks.js';
import { isAllowedUser } from '../access/guard.js';
import { CHAT_PAGE_SIZE, LOG_PAGE_SIZE, RULE_PAGE_SIZE } from '../constants.js';
import type { LogRepository } from '../db/logs.js';
import type { RuleRepository } from '../db/rules.js';
import { AppError, ChatResolveError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ChatDirectory } from '../telegram/directory.js';
import { chatFromRule } from '../telegram/peers.js';
import type { ChatKind, ResolvedChat } from '../types.js';
import { SerialQueue } from '../util/serial-queue.js';
import { formatChat, formatLog, formatRule, helpText, kindPrompt, oneLine, ruleSummary } from './copy.js';
import { dialogLines, REPLY_PLACEHOLDER, replyNudge, type Dialog } from './dialog.js';
import {
  chatPickerRows,
  clearLogsRows,
  confirmRows,
  deleteConfirmRows,
  editFieldRows,
  kindRows,
  logsRows,
  mainMenuRows,
  manualRows,
  rulesRows,
  settingsRows,
} from './keyboards.js';
import { pageSlice } from './paging.js';
import { present } from './present.js';
import { createWizard, editWizard, isManual, WizardStore, type CreatePhase, type EditPhase, type Wizard } from './wizard.js';

export interface ManagerDeps {
  allowedUserId: string;
  rules: RuleRepository;
  logs: LogRepository;
  directory: ChatDirectory;
  selfId: () => string | null;
  connected: () => boolean;
  logger: Logger;
}

export function registerManager(bot: Bot, deps: ManagerDeps): void {
  new Manager(deps).register(bot);
}

class Manager {
  private readonly wizard = new WizardStore();
  private readonly queue = new SerialQueue();
  /** The dialog message button taps rewrite. */
  private anchorId?: number;
  /** The short message that opened the reply bar. */
  private promptId?: number;

  constructor(private readonly deps: ManagerDeps) {}

  register(bot: Bot): void {
    bot.use(async (ctx, next) => {
      if (!isAllowedUser(ctx.from?.id, this.deps.allowedUserId)) {
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: 'This bot is private.', show_alert: true }).catch(() => undefined);
        } else if (ctx.chat?.type === 'private') {
          await ctx.reply('This bot is private.').catch(() => undefined);
        }
        return;
      }
      if (ctx.chat && ctx.chat.type !== 'private') return;
      await next();
    });

    bot.command(['start', 'menu'], (ctx) => this.run(ctx, () => this.showMain(ctx)));
    bot.command('help', (ctx) =>
      this.run(ctx, () => this.show(ctx, { title: 'Help', lines: dialogLines(helpText()), rows: mainMenuRows() })),
    );
    bot.command('status', (ctx) => this.run(ctx, () => this.showStatus(ctx)));
    bot.command('cancel', (ctx) => this.run(ctx, () => this.showMain(ctx)));
    bot.on('callback_query', (ctx) => this.onCallback(ctx));
    bot.on('message', (ctx) => this.run(ctx, () => this.onText(ctx)));
    bot.catch((error) => {
      this.deps.logger.error(
        { event: 'bot_handler_error', name: error instanceof Error ? error.name : 'Error' },
        'bot handler failed',
      );
    });
  }

  private async onCallback(ctx: Context): Promise<void> {
    const action = parseCallback(ctx.callbackQuery?.data);
    await ctx.answerCallbackQuery(action ? {} : { text: 'That button is not valid.', show_alert: true }).catch(() => undefined);
    if (!action || action.type === 'noop') return;
    await this.run(ctx, () => this.dispatch(ctx, action));
  }

  private run(ctx: Context, task: () => Promise<void>): Promise<void> {
    return this.queue.add(async () => {
      try {
        await task();
      } catch (error) {
        const safe = error instanceof AppError ? error.message : 'Something went wrong. Send /menu to continue.';
        this.deps.logger.warn(
          { event: 'menu_error', name: error instanceof Error ? error.name : 'Error' },
          'menu action failed',
        );
        const current = this.wizard.get();
        const keepManual = error instanceof ChatResolveError && current !== null && isManual(current);
        if (!keepManual) this.wizard.clear();
        await this.show(ctx, {
          title: keepManual ? 'Try another chat' : 'Something went wrong',
          lines: [safe],
          rows: keepManual ? manualRows() : mainMenuRows(),
          ...(keepManual ? { replyPlaceholder: REPLY_PLACEHOLDER } : {}),
        }).catch(() => undefined);
      }
    });
  }

  private async dispatch(ctx: Context, action: CallbackAction): Promise<void> {
    switch (action.type) {
      case 'menu':
      case 'cancel':
        return this.showMain(ctx);
      case 'create':
        this.wizard.set(createWizard());
        return this.showKind(ctx, 'source');
      case 'kind':
        return this.onKind(ctx, action.kind);
      case 'pick':
        return this.onPick(ctx, action.index);
      case 'page':
        return this.onPage(ctx, action.page);
      case 'manual':
        return this.onManual(ctx);
      case 'back':
        return this.onBack(ctx);
      case 'confirm':
        return this.onConfirm(ctx);
      case 'rules':
        return this.showRules(ctx, action.page, 'view');
      case 'toggle_page':
        return this.showRules(ctx, action.page, 'toggle');
      case 'toggle':
        return this.toggleRule(ctx, action.ruleId);
      case 'edit_page':
        return this.showRules(ctx, action.page, 'edit');
      case 'edit_rule':
        return this.showEditFields(ctx, action.ruleId);
      case 'edit_field':
        this.wizard.set(editWizard(action.ruleId, action.field));
        return this.showKind(ctx, action.field === 'source' ? 'source' : 'destination');
      case 'delete_page':
        return this.showRules(ctx, action.page, 'delete');
      case 'delete_ask':
        return this.askDelete(ctx, action.ruleId);
      case 'delete_confirm':
        return this.deleteRule(ctx, action.ruleId);
      case 'hide_sender':
        return this.onHideChoice(ctx, action.hide);
      case 'hide_sender_rule':
        return this.toggleHideSender(ctx, action.ruleId);
      case 'logs':
        return this.showLogs(ctx, action.page);
      case 'settings':
        return this.showSettings(ctx);
      case 'pause_all':
        return this.pauseAll(ctx);
      case 'resume_all':
        return this.resumeAll(ctx);
      case 'clear_logs_ask':
        return this.show(ctx, {
          title: 'Clear logs',
          lines: ['Clear every forwarding log?', 'Message text is not stored in them.'],
          rows: clearLogsRows(),
        });
      case 'clear_logs': {
        const removed = this.deps.logs.clearAll();
        return this.show(ctx, { title: 'Logs cleared', lines: [`Cleared ${removed} log entries.`], rows: settingsRows() });
      }
      default:
        return this.expired(ctx);
    }
  }

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return;
    const wizard = this.wizard.get();
    if (!wizard || !isManual(wizard)) {
      await this.show(ctx, {
        title: 'Use the buttons',
        lines: ['Send /menu to open the dialog again.'],
        rows: mainMenuRows(),
      });
      return;
    }
    const kind = manualKind(wizard);
    if (!kind) return this.expired(ctx);
    const chat = await this.deps.directory.resolve(text, kind);
    await this.selectChat(ctx, wizard, chat);
  }

  private async onKind(ctx: Context, kind: ChatKind): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard) return this.expired(ctx);
    if (wizard.type === 'create' && wizard.phase === 'source-kind') {
      wizard.sourceKind = kind;
      await this.showCandidates(ctx, wizard, kind, false, 'source-pick');
      return;
    }
    if (wizard.type === 'create' && wizard.phase === 'dest-kind') {
      wizard.destKind = kind;
      await this.showCandidates(ctx, wizard, kind, kind === 'user', 'dest-pick');
      return;
    }
    if (wizard.type === 'edit' && wizard.phase === 'kind') {
      wizard.kind = kind;
      await this.showCandidates(ctx, wizard, kind, wizard.field === 'dest' && kind === 'user', 'pick');
      return;
    }
    return this.expired(ctx);
  }

  private async onPick(ctx: Context, index: number): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard || !isPickPhase(wizard)) return this.expired(ctx);
    const slice = pageSlice(wizard.candidates, wizard.page, CHAT_PAGE_SIZE);
    const chat = slice.items[index];
    if (!chat) {
      await this.show(ctx, {
        title: 'Pick again',
        lines: ['That choice expired. Pick a chat from the list.'],
        rows: chatPickerRows(slice),
      });
      return;
    }
    await this.selectChat(ctx, wizard, chat);
  }

  private async onPage(ctx: Context, page: number): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard || !isPickPhase(wizard)) return this.expired(ctx);
    wizard.page = page;
    wizard.updatedAt = Date.now();
    await this.renderCandidates(ctx, wizard);
  }

  private async onManual(ctx: Context): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard || !isPickPhase(wizard)) return this.expired(ctx);
    wizard.phase = wizard.type === 'create' ? (wizard.phase === 'source-pick' ? 'source-manual' : 'dest-manual') : 'manual';
    wizard.updatedAt = Date.now();
    await this.show(ctx, {
      title: 'Username or id',
      lines: ['Send a public @username, a https://t.me/name link, or a numeric chat id. Invite links are not accepted.'],
      rows: manualRows(),
      replyPlaceholder: REPLY_PLACEHOLDER,
    });
  }

  private async onBack(ctx: Context): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard) return this.showMain(ctx);
    if (wizard.type === 'create') return this.backCreate(ctx, wizard);
    if (wizard.phase === 'kind') return this.showEditFields(ctx, wizard.ruleId);
    if (wizard.phase === 'pick' || wizard.phase === 'manual') {
      wizard.phase = 'kind';
      await this.showKind(ctx, wizard.field === 'source' ? 'source' : 'destination');
      return;
    }
    wizard.phase = 'pick';
    await this.renderCandidates(ctx, wizard);
  }

  private async backCreate(ctx: Context, wizard: Extract<Wizard, { type: 'create' }>): Promise<void> {
    if (wizard.phase === 'source-kind') return this.showMain(ctx);
    if (wizard.phase === 'source-pick' || wizard.phase === 'source-manual') {
      wizard.phase = 'source-kind';
      wizard.updatedAt = Date.now();
      await this.showKind(ctx, 'source');
      return;
    }
    if (wizard.phase === 'dest-kind') {
      if (!wizard.sourceKind) return this.expired(ctx);
      await this.showCandidates(ctx, wizard, wizard.sourceKind, false, 'source-pick');
      return;
    }
    if (wizard.phase === 'dest-pick' || wizard.phase === 'dest-manual') {
      wizard.phase = 'dest-kind';
      wizard.updatedAt = Date.now();
      await this.showKind(ctx, 'destination');
      return;
    }
    wizard.phase = 'dest-pick';
    wizard.updatedAt = Date.now();
    await this.renderCandidates(ctx, wizard);
  }

  private async onConfirm(ctx: Context): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard) return this.expired(ctx);
    if (wizard.type === 'create') return this.confirmCreate(ctx, wizard);
    return this.confirmEdit(ctx, wizard);
  }

  private async confirmCreate(ctx: Context, wizard: Extract<Wizard, { type: 'create' }>): Promise<void> {
    if (wizard.phase !== 'confirm' || !wizard.source || !wizard.destination) return this.expired(ctx);
    const selfId = this.requireSelf();
    const baseline = await this.deps.directory.latestMessageId(wizard.source);
    const rule = this.deps.rules.create({
      source: wizard.source,
      destination: wizard.destination,
      selfUserId: selfId,
      baselineMessageId: baseline,
      hideSender: wizard.hideSender,
    });
    this.deps.logs.write({
      ruleId: rule.id,
      sourceChatId: rule.sourceMarkedId,
      messageId: null,
      level: 'info',
      event: 'rule_created',
      detail: `${oneLine(rule.sourceTitle, 40)} -> ${oneLine(rule.destTitle, 40)}`,
    });
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Rule active',
      lines: [`Rule #${rule.id} is active.`, 'Only messages newer than the current source history will be forwarded.'],
      rows: mainMenuRows(),
    });
  }

  private async confirmEdit(ctx: Context, wizard: Extract<Wizard, { type: 'edit' }>): Promise<void> {
    if (wizard.phase !== 'confirm' || !wizard.candidate) return this.expired(ctx);
    const existing = this.deps.rules.get(wizard.ruleId);
    if (!existing) return this.missing(ctx);
    const source = wizard.field === 'source' ? wizard.candidate : chatFromRule(existing, 'source');
    const baseline = await this.deps.directory.latestMessageId(source);
    const rule = this.deps.rules.updateEndpoint(wizard.ruleId, wizard.field, wizard.candidate, baseline, this.requireSelf());
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Rule updated',
      lines: dialogLines(`Rule #${rule.id} was updated. Older messages will not be backfilled.`, formatRule(rule)),
      rows: mainMenuRows(),
    });
  }

  private async selectChat(ctx: Context, wizard: Wizard, chat: ResolvedChat): Promise<void> {
    wizard.updatedAt = Date.now();
    if (wizard.type === 'create' && (wizard.phase === 'source-pick' || wizard.phase === 'source-manual')) {
      wizard.source = chat;
      wizard.phase = 'dest-kind';
      await this.show(ctx, {
        title: 'Destination',
        lines: dialogLines(`Source selected. ${formatChat(chat)}`, kindPrompt('destination')),
        rows: kindRows(),
      });
      return;
    }
    if (wizard.type === 'create' && (wizard.phase === 'dest-pick' || wizard.phase === 'dest-manual')) {
      if (!wizard.source) return this.expired(ctx);
      wizard.destination = chat;
      wizard.phase = 'confirm';
      await this.show(ctx, {
        title: 'Review the rule',
        lines: dialogLines(ruleSummary(wizard.source, chat, wizard.hideSender)),
        rows: confirmRows(wizard.hideSender),
      });
      return;
    }
    if (wizard.type === 'edit' && (wizard.phase === 'pick' || wizard.phase === 'manual')) {
      wizard.candidate = chat;
      wizard.phase = 'confirm';
      const existing = this.deps.rules.get(wizard.ruleId);
      if (!existing) return this.missing(ctx);
      const source = wizard.field === 'source' ? chat : chatFromRule(existing, 'source');
      const destination = wizard.field === 'dest' ? chat : chatFromRule(existing, 'dest');
      await this.show(ctx, {
        title: `Update rule #${existing.id}`,
        lines: dialogLines(ruleSummary(source, destination, existing.hideSender)),
        rows: confirmRows(),
      });
      return;
    }
    return this.expired(ctx);
  }

  private async showCandidates(
    ctx: Context,
    wizard: Wizard,
    kind: ChatKind,
    includeSelf: boolean,
    phase: CreatePhase | EditPhase,
  ): Promise<void> {
    await this.show(ctx, { title: 'One moment', lines: ['Loading recent chats from your account.'], rows: [] });
    wizard.candidates = await this.deps.directory.list(kind, includeSelf);
    wizard.page = 0;
    wizard.updatedAt = Date.now();
    if (wizard.type === 'create') wizard.phase = phase as CreatePhase;
    else wizard.phase = phase as EditPhase;
    this.wizard.set(wizard);
    await this.renderCandidates(ctx, wizard);
  }

  private async renderCandidates(ctx: Context, wizard: Wizard): Promise<void> {
    const slice = pageSlice(wizard.candidates, wizard.page, CHAT_PAGE_SIZE);
    wizard.page = slice.page;
    const side = candidateSide(wizard);
    const kind = candidateKind(wizard);
    const lines = [
      `Choose the ${side}.`,
      slice.items.length === 0
        ? kind === 'user'
          ? 'No private chats or contacts were found. You can enter a @username or numeric id.'
          : 'No matching recent chats were found. You can enter a @username or numeric id.'
        : `Page ${slice.page + 1} of ${slice.pages}.`,
    ];
    await this.show(ctx, { title: side === 'destination' ? 'Destination' : 'Source', lines, rows: chatPickerRows(slice) });
  }

  private async showRules(ctx: Context, page: number, mode: 'view' | 'toggle' | 'edit' | 'delete'): Promise<void> {
    const rules = this.deps.rules.list();
    if (rules.length === 0) {
      await this.show(ctx, { title: 'No rules yet', lines: ['Create a forwarding rule to begin.'], rows: mainMenuRows() });
      return;
    }
    const slice = pageSlice(rules, page, RULE_PAGE_SIZE);
    const title = mode === 'view' ? 'Rules' : mode === 'toggle' ? 'Start or pause' : mode === 'edit' ? 'Edit a rule' : 'Delete a rule';
    const intro =
      mode === 'view'
        ? `Page ${slice.page + 1} of ${slice.pages}.`
        : mode === 'toggle'
          ? 'Starting again skips messages from while the rule was stopped.'
          : mode === 'edit'
            ? 'Choose a rule to edit.'
            : 'Deleting a rule leaves messages already delivered in Telegram.';
    await this.show(ctx, {
      title,
      lines: dialogLines(intro, ...slice.items.map((rule) => formatRule(rule))),
      rows: rulesRows(slice, mode),
    });
  }

  private async toggleRule(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    if (rule.status === 'active') {
      this.deps.rules.pause(ruleId);
      await this.show(ctx, { title: 'Paused', lines: [`Rule #${ruleId} is paused.`], rows: mainMenuRows() });
      return;
    }
    const baseline = await this.deps.directory.latestMessageId(chatFromRule(rule, 'source'));
    this.deps.rules.activate(ruleId, baseline);
    await this.show(ctx, {
      title: 'Active',
      lines: [`Rule #${ruleId} is active.`, 'Messages that arrived while it was paused are not forwarded.'],
      rows: mainMenuRows(),
    });
  }

  private async onHideChoice(ctx: Context, hide: boolean): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard || wizard.type !== 'create' || wizard.phase !== 'confirm' || !wizard.source || !wizard.destination) {
      return this.expired(ctx);
    }
    wizard.hideSender = hide;
    wizard.updatedAt = Date.now();
    await this.show(ctx, {
      title: 'Review the rule',
      lines: dialogLines(ruleSummary(wizard.source, wizard.destination, hide)),
      rows: confirmRows(hide),
    });
  }

  private async toggleHideSender(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    this.deps.rules.setHideSender(ruleId, !rule.hideSender);
    await this.showEditFields(ctx, ruleId);
  }

  private async showEditFields(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    this.wizard.clear();
    await this.show(ctx, {
      title: `Rule #${rule.id}`,
      lines: dialogLines(formatRule(rule), 'What do you want to change?'),
      rows: editFieldRows(ruleId, rule.hideSender),
    });
  }

  private async askDelete(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    await this.show(ctx, {
      title: `Delete rule #${rule.id}?`,
      lines: dialogLines(formatRule(rule), 'Telegram messages already delivered are left as they are.'),
      rows: deleteConfirmRows(ruleId),
    });
  }

  private async deleteRule(ctx: Context, ruleId: number): Promise<void> {
    const removed = this.deps.rules.delete(ruleId);
    await this.show(ctx, {
      title: removed ? 'Deleted' : 'Already gone',
      lines: [removed ? `Rule #${ruleId} was deleted.` : 'That rule no longer exists.'],
      rows: mainMenuRows(),
    });
  }

  private async showLogs(ctx: Context, page: number): Promise<void> {
    const total = this.deps.logs.count();
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    const safe = Math.min(Math.max(0, page), pages - 1);
    const entries = this.deps.logs.list(safe * LOG_PAGE_SIZE, LOG_PAGE_SIZE);
    const body = entries.length === 0 ? 'No forwarding logs yet. Message text is never stored.' : entries.map((entry) => formatLog(entry)).join('\n\n');
    await this.show(ctx, {
      title: 'Logs',
      lines: dialogLines(`Page ${safe + 1} of ${pages}.`, body),
      rows: logsRows(safe, pages),
    });
  }

  private async showSettings(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts();
    await this.show(ctx, {
      title: 'Settings',
      lines: [
        `User client: ${this.deps.connected() ? 'connected' : 'disconnected'}`,
        `Active rules: ${counts.active}`,
        `Paused rules: ${counts.paused}`,
        'Menu access is limited to the configured user.',
        'Pausing does not delete rules. Resuming does not backfill older messages.',
      ],
      rows: settingsRows(),
    });
  }

  private async pauseAll(ctx: Context): Promise<void> {
    const paused = this.deps.rules.pauseAll();
    await this.show(ctx, {
      title: 'Paused',
      lines: [`Paused ${paused} active rule${paused === 1 ? '' : 's'}.`],
      rows: settingsRows(),
    });
  }

  private async resumeAll(ctx: Context): Promise<void> {
    const paused = this.deps.rules.list().filter((rule) => rule.status === 'paused');
    let started = 0;
    let failed = 0;
    for (const rule of paused) {
      try {
        const baseline = await this.deps.directory.latestMessageId(chatFromRule(rule, 'source'));
        this.deps.rules.activate(rule.id, baseline);
        started += 1;
      } catch (error) {
        failed += 1;
        this.deps.logger.warn(
          { event: 'resume_failed', ruleId: rule.id, name: error instanceof Error ? error.name : 'Error' },
          'could not resume a rule',
        );
      }
    }
    await this.show(ctx, {
      title: 'Resumed',
      lines: [`Resumed ${started} rule${started === 1 ? '' : 's'}.`, `${failed} could not be read and stayed paused.`],
      rows: settingsRows(),
    });
  }

  private async showMain(ctx: Context): Promise<void> {
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Telesyncra',
      lines: [
        'Forward new messages from chats your account can access.',
        'This bot only controls the rules. It does not read your private chats.',
      ],
      rows: mainMenuRows(),
    });
  }

  private async showStatus(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts();
    const selfId = this.deps.selfId();
    await this.show(ctx, {
      title: 'Status',
      lines: [
        `User client: ${this.deps.connected() ? 'connected' : 'disconnected'}`,
        `Account id: ${selfId ?? 'unavailable'}`,
        `Active rules: ${counts.active}`,
        `Paused rules: ${counts.paused}`,
        'Menu access is limited to the configured user.',
        'Session file: stored locally with restricted permissions.',
      ],
      rows: mainMenuRows(),
    });
  }

  private async expired(ctx: Context): Promise<void> {
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Step expired',
      lines: ['Open the menu and start again.'],
      rows: mainMenuRows(),
    });
  }

  private async missing(ctx: Context): Promise<void> {
    await this.show(ctx, { title: 'Missing rule', lines: ['That rule no longer exists.'], rows: mainMenuRows() });
  }

  private showKind(ctx: Context, side: 'source' | 'destination'): Promise<void> {
    const title = side === 'source' ? 'Source' : 'Destination';
    return this.show(ctx, { title, lines: dialogLines(kindPrompt(side)), rows: kindRows() });
  }

  private async show(ctx: Context, dialog: Dialog): Promise<void> {
    if (dialog.replyPlaceholder) {
      const editingAnchor = this.anchorId !== undefined && ctx.callbackQuery?.message?.message_id === this.anchorId;
      if (!editingAnchor) await this.deleteStored(ctx, this.anchorId);
      await this.deleteStored(ctx, this.promptId);
      this.promptId = undefined;
      const anchor = await present(ctx, { ...dialog, replyPlaceholder: undefined });
      this.anchorId = anchor.messageId;
      const prompt = await present(ctx, replyNudge(dialog.replyPlaceholder));
      this.promptId = prompt.messageId;
      return;
    }

    const editingAnchor = this.anchorId !== undefined && ctx.callbackQuery?.message?.message_id === this.anchorId;
    if (this.promptId !== undefined && !editingAnchor) {
      await this.deleteStored(ctx, this.anchorId);
      this.anchorId = undefined;
    }
    await this.deleteStored(ctx, this.promptId);
    this.promptId = undefined;
    const shown = await present(ctx, dialog);
    this.anchorId = shown.messageId;
  }

  private async deleteStored(ctx: Context, messageId: number | undefined): Promise<void> {
    const chatId = ctx.chatId;
    if (messageId === undefined || chatId === undefined) return;
    await ctx.api.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }

  private requireSelf(): string {
    const selfId = this.deps.selfId();
    if (!selfId) throw new AppError('The user client is not authorized yet.');
    return selfId;
  }
}

function isPickPhase(wizard: Wizard): boolean {
  if (wizard.type === 'create') return wizard.phase === 'source-pick' || wizard.phase === 'dest-pick';
  return wizard.phase === 'pick';
}

function manualKind(wizard: Wizard): ChatKind | undefined {
  if (wizard.type === 'create' && wizard.phase === 'source-manual') return wizard.sourceKind;
  if (wizard.type === 'create' && wizard.phase === 'dest-manual') return wizard.destKind;
  if (wizard.type === 'edit' && wizard.phase === 'manual') return wizard.kind;
  return undefined;
}

function candidateSide(wizard: Wizard): string {
  if (wizard.type === 'edit') return wizard.field === 'source' ? 'source' : 'destination';
  return wizard.phase.startsWith('dest') ? 'destination' : 'source';
}

function candidateKind(wizard: Wizard): ChatKind | undefined {
  if (wizard.type === 'edit') return wizard.kind;
  if (wizard.phase.startsWith('dest')) return wizard.destKind;
  return wizard.sourceKind;
}
