import { Bot, InlineKeyboardBuilder, type Context } from 'node-telegram-bot-api';
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
import {
  chatPickerKeyboard,
  clearLogsKeyboard,
  confirmKeyboard,
  deleteConfirmKeyboard,
  editFieldKeyboard,
  kindKeyboard,
  mainMenuKeyboard,
  manualKeyboard,
  rulesKeyboard,
  settingsKeyboard,
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
    bot.command('help', (ctx) => this.run(ctx, async () => present(ctx, helpText(), mainMenuKeyboard())));
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
    await ctx.answerCallbackQuery(action ? {} : { text: 'That button is not valid.' }).catch(() => undefined);
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
        await present(ctx, safe, keepManual ? manualKeyboard() : mainMenuKeyboard()).catch(() => undefined);
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
        return present(ctx, kindPrompt('source'), kindKeyboard());
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
        return present(ctx, kindPrompt(action.field === 'source' ? 'source' : 'destination'), kindKeyboard());
      case 'delete_page':
        return this.showRules(ctx, action.page, 'delete');
      case 'delete_ask':
        return this.askDelete(ctx, action.ruleId);
      case 'delete_confirm':
        return this.deleteRule(ctx, action.ruleId);
      case 'logs':
        return this.showLogs(ctx, action.page);
      case 'settings':
        return this.showSettings(ctx);
      case 'pause_all':
        return this.pauseAll(ctx);
      case 'resume_all':
        return this.resumeAll(ctx);
      case 'clear_logs_ask':
        return present(ctx, 'Clear every forwarding log? Message text is not stored in them.', clearLogsKeyboard());
      case 'clear_logs': {
        const removed = this.deps.logs.clearAll();
        return present(ctx, `Cleared ${removed} log entries.`, settingsKeyboard());
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
      await present(ctx, 'Use the buttons, or send /menu.', mainMenuKeyboard());
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
      await present(ctx, 'That choice expired. Pick a chat again.', chatPickerKeyboard(slice));
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
    await present(
      ctx,
      'Send a public @username, a https://t.me/name link, or a numeric chat id. Invite links are not accepted.',
      manualKeyboard(),
    );
  }

  private async onBack(ctx: Context): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard) return this.showMain(ctx);
    if (wizard.type === 'create') return this.backCreate(ctx, wizard);
    if (wizard.phase === 'kind') return this.showEditFields(ctx, wizard.ruleId);
    if (wizard.phase === 'pick' || wizard.phase === 'manual') {
      wizard.phase = 'kind';
      await present(ctx, kindPrompt(wizard.field === 'source' ? 'source' : 'destination'), kindKeyboard());
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
      await present(ctx, kindPrompt('source'), kindKeyboard());
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
      await present(ctx, kindPrompt('destination'), kindKeyboard());
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
    await present(ctx, `Rule #${rule.id} is active.\n\nOnly messages newer than the current source history will be forwarded.`, mainMenuKeyboard());
  }

  private async confirmEdit(ctx: Context, wizard: Extract<Wizard, { type: 'edit' }>): Promise<void> {
    if (wizard.phase !== 'confirm' || !wizard.candidate) return this.expired(ctx);
    const existing = this.deps.rules.get(wizard.ruleId);
    if (!existing) return this.missing(ctx);
    const source = wizard.field === 'source' ? wizard.candidate : chatFromRule(existing, 'source');
    const baseline = await this.deps.directory.latestMessageId(source);
    const rule = this.deps.rules.updateEndpoint(wizard.ruleId, wizard.field, wizard.candidate, baseline, this.requireSelf());
    this.wizard.clear();
    await present(ctx, `Rule #${rule.id} was updated. Older messages will not be backfilled.\n\n${formatRule(rule)}`, mainMenuKeyboard());
  }

  private async selectChat(ctx: Context, wizard: Wizard, chat: ResolvedChat): Promise<void> {
    wizard.updatedAt = Date.now();
    if (wizard.type === 'create' && (wizard.phase === 'source-pick' || wizard.phase === 'source-manual')) {
      wizard.source = chat;
      wizard.phase = 'dest-kind';
      await present(ctx, `Source selected.\n${formatChat(chat)}\n\n${kindPrompt('destination')}`, kindKeyboard());
      return;
    }
    if (wizard.type === 'create' && (wizard.phase === 'dest-pick' || wizard.phase === 'dest-manual')) {
      if (!wizard.source) return this.expired(ctx);
      wizard.destination = chat;
      wizard.phase = 'confirm';
      await present(ctx, ruleSummary(wizard.source, chat), confirmKeyboard());
      return;
    }
    if (wizard.type === 'edit' && (wizard.phase === 'pick' || wizard.phase === 'manual')) {
      wizard.candidate = chat;
      wizard.phase = 'confirm';
      const existing = this.deps.rules.get(wizard.ruleId);
      if (!existing) return this.missing(ctx);
      const source = wizard.field === 'source' ? chat : chatFromRule(existing, 'source');
      const destination = wizard.field === 'dest' ? chat : chatFromRule(existing, 'dest');
      await present(ctx, `Update rule #${existing.id}?\n\n${ruleSummary(source, destination)}`, confirmKeyboard());
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
    await present(ctx, 'Loading chats from your account...');
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
    const lines = [
      `Choose the ${side}.`,
      slice.items.length === 0
        ? 'No matching recent chats were found. You can enter a @username or numeric id.'
        : `Page ${slice.page + 1} of ${slice.pages}.`,
    ];
    await present(ctx, lines.join('\n'), chatPickerKeyboard(slice));
  }

  private async showRules(ctx: Context, page: number, mode: 'view' | 'toggle' | 'edit' | 'delete'): Promise<void> {
    const rules = this.deps.rules.list();
    if (rules.length === 0) {
      await present(ctx, 'No forwarding rules yet.', mainMenuKeyboard());
      return;
    }
    const slice = pageSlice(rules, page, RULE_PAGE_SIZE);
    const heading =
      mode === 'view'
        ? 'Forwarding rules'
        : mode === 'toggle'
          ? 'Start or stop a rule. Starting again skips messages from while it was stopped.'
          : mode === 'edit'
            ? 'Choose a rule to edit.'
            : 'Choose a rule to delete. This does not delete Telegram messages.';
    await present(ctx, `${heading}\n\n${slice.items.map((rule) => formatRule(rule)).join('\n\n')}`, rulesKeyboard(slice, mode));
  }

  private async toggleRule(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    if (rule.status === 'active') {
      this.deps.rules.pause(ruleId);
      await present(ctx, `Rule #${ruleId} is paused.`, mainMenuKeyboard());
      return;
    }
    const baseline = await this.deps.directory.latestMessageId(chatFromRule(rule, 'source'));
    this.deps.rules.activate(ruleId, baseline);
    await present(
      ctx,
      `Rule #${ruleId} is active. Messages that arrived while it was paused are not forwarded.`,
      mainMenuKeyboard(),
    );
  }

  private async showEditFields(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    this.wizard.clear();
    await present(ctx, `${formatRule(rule)}\n\nWhat do you want to change?`, editFieldKeyboard(ruleId));
  }

  private async askDelete(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId);
    if (!rule) return this.missing(ctx);
    await present(ctx, `Delete rule #${rule.id}?\n\n${formatRule(rule)}\n\nTelegram messages already delivered are left as they are.`, deleteConfirmKeyboard(ruleId));
  }

  private async deleteRule(ctx: Context, ruleId: number): Promise<void> {
    const removed = this.deps.rules.delete(ruleId);
    await present(ctx, removed ? `Rule #${ruleId} was deleted.` : 'That rule no longer exists.', mainMenuKeyboard());
  }

  private async showLogs(ctx: Context, page: number): Promise<void> {
    const total = this.deps.logs.count();
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    const safe = Math.min(Math.max(0, page), pages - 1);
    const entries = this.deps.logs.list(safe * LOG_PAGE_SIZE, LOG_PAGE_SIZE);
    const body = entries.length === 0
      ? 'No forwarding logs yet. Message text is never stored.'
      : entries.map((entry) => formatLog(entry)).join('\n\n');
    const builder = new InlineKeyboardBuilder();
    if (safe > 0) builder.text('Previous', `logs:${safe - 1}`);
    if (safe + 1 < pages) builder.text('Next', `logs:${safe + 1}`);
    if (pages > 1) builder.row();
    builder.text('Menu', 'menu');
    await present(ctx, `Forwarding logs\nPage ${safe + 1} of ${pages}\n\n${body}`, builder.build());
  }

  private async showSettings(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts();
    await present(
      ctx,
      [
        'Settings',
        `User client: ${this.deps.connected() ? 'connected' : 'disconnected'}`,
        `Active rules: ${counts.active}`,
        `Paused rules: ${counts.paused}`,
        'Menu access is limited to the configured user.',
        'Pausing does not delete rules. Resuming does not backfill older messages.',
      ].join('\n'),
      settingsKeyboard(),
    );
  }

  private async pauseAll(ctx: Context): Promise<void> {
    const paused = this.deps.rules.pauseAll();
    await present(ctx, `Paused ${paused} active rule${paused === 1 ? '' : 's'}.`, settingsKeyboard());
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
    await present(ctx, `Resumed ${started} rule${started === 1 ? '' : 's'}. ${failed} could not be read and stayed paused.`, settingsKeyboard());
  }

  private async showMain(ctx: Context): Promise<void> {
    this.wizard.clear();
    await present(
      ctx,
      'Telesyncra\n\nForward new messages from chats your account can access. This bot only controls the rules.',
      mainMenuKeyboard(),
    );
  }

  private async showStatus(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts();
    const selfId = this.deps.selfId();
    await present(
      ctx,
      [
        `User client: ${this.deps.connected() ? 'connected' : 'disconnected'}`,
        `Account id: ${selfId ?? 'unavailable'}`,
        `Active rules: ${counts.active}`,
        `Paused rules: ${counts.paused}`,
        'Menu access is limited to the configured user.',
        'Session file: stored locally with restricted permissions.',
      ].join('\n'),
      mainMenuKeyboard(),
    );
  }

  private async expired(ctx: Context): Promise<void> {
    this.wizard.clear();
    await present(ctx, 'That step expired. Open the menu and start again.', mainMenuKeyboard());
  }

  private async missing(ctx: Context): Promise<void> {
    await present(ctx, 'That rule no longer exists.', mainMenuKeyboard());
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
