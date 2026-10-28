import { Bot, type Context } from 'node-telegram-bot-api';
import { Api, TelegramClient } from 'telegram';
import { parseCallback, type CallbackAction } from '../access/callbacks.js';
import { CHAT_PAGE_SIZE, LOG_PAGE_SIZE, RULE_PAGE_SIZE } from '../constants.js';
import type { AccountStore } from '../db/accounts.js';
import type { LogRepository } from '../db/logs.js';
import type { RuleRepository } from '../db/rules.js';
import { AppError, ChatResolveError } from '../errors.js';
import type { Logger } from '../logger.js';
import { AccountPool } from '../telegram/account-pool.js';
import { isLoginCancel, LoginCancelled, runBotLogin } from '../telegram/bot-login.js';
import type { ChatDirectory } from '../telegram/directory.js';
import { createTelegramClient } from '../telegram/user-client.js';
import { chatFromRule } from '../telegram/peers.js';
import type { AppConfig } from '../config.js';
import type { ChatKind, NotifyMode, ResolvedChat } from '../types.js';
import { SerialQueue } from '../util/serial-queue.js';
import { formatChat, formatLog, formatRule, helpText, kindPrompt, oneLine, ruleSummary } from './copy.js';
import { mdEscape } from './rich-text.js';
import { button, dialogKeyboard, dialogLines, renderDialog, REPLY_PLACEHOLDER, replyNudge, type Dialog } from './dialog.js';
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
  peopleRows,
  removePersonRows,
  rulesRows,
  settingsRows,
} from './keyboards.js';
import { nextNotifyMode } from './notify-mode.js';
import { pageSlice } from './paging.js';
import { present } from './present.js';
import { createWizard, editWizard, isManual, WizardStore, type CreatePhase, type EditPhase, type Wizard } from './wizard.js';

export interface ManagerDeps {
  allowedUserId: string;
  api: Pick<AppConfig, 'apiId' | 'apiHash'>;
  rules: RuleRepository;
  logs: LogRepository;
  accounts: AccountStore;
  pool: AccountPool;
  logger: Logger;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface LoginAttempt {
  client: TelegramClient;
  chatId: number;
  api: Context['api'];
  phase: 'phone' | 'code' | 'password';
  wait: Deferred<string> | null;
  cancelled: boolean;
}

export function registerManager(bot: Bot, deps: ManagerDeps): void {
  new Manager(deps).register(bot);
}

class Manager {
  private readonly wizards = new Map<string, WizardStore>();
  private readonly queue = new SerialQueue();
  private readonly threads = new Map<number, { anchorId?: number; promptId?: number }>();
  private readonly logins = new Map<string, LoginAttempt>();
  private actor = '';

  constructor(private readonly deps: ManagerDeps) {}

  private get wizard(): WizardStore {
    const key = this.actor || '0';
    let store = this.wizards.get(key);
    if (!store) {
      store = new WizardStore();
      this.wizards.set(key, store);
    }
    return store;
  }

  register(bot: Bot): void {
    bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.chat.type !== 'private') return;
      const userId = ctx.from?.id === undefined ? '' : String(ctx.from.id);
      if (!userId) return;
      if (userId === this.deps.allowedUserId || this.deps.accounts.hasAccess(userId)) {
        await next();
        return;
      }
      const text = ctx.message?.text?.trim() ?? '';
      if (text && !text.startsWith('/') && this.deps.accounts.matchesInvite(text)) {
        await next();
        return;
      }
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: 'This bot is private.', show_alert: true }).catch(() => undefined);
      } else {
        await ctx.reply('This bot is private. Send your one-time invite code if you have one.').catch(() => undefined);
      }
    });

    bot.command(['start', 'menu'], (ctx) => this.run(ctx, () => this.showMain(ctx)));
    bot.command('help', (ctx) =>
      this.run(ctx, () => this.show(ctx, { title: 'Help', lines: dialogLines(helpText()), rows: this.menuRows() })),
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
      this.actor = ctx.from?.id === undefined ? '' : String(ctx.from.id);
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
          lines: [mdEscape(safe)],
          rows: keepManual ? manualRows() : this.menuRows(),
          ...(keepManual ? { replyPlaceholder: REPLY_PLACEHOLDER } : {}),
        }).catch(() => undefined);
      }
    });
  }

  private async dispatch(ctx: Context, action: CallbackAction): Promise<void> {
    switch (action.type) {
      case 'menu':
      case 'cancel':
        this.abortLogin();
        return this.showMain(ctx);
      case 'sign_in':
        return this.beginSignIn(ctx);
      case 'invite':
        return this.createInvite(ctx);
      case 'people':
        return this.showPeople(ctx);
      case 'remove_ask':
        return this.askRemove(ctx, action.userId);
      case 'remove_confirm':
        return this.removePerson(ctx, action.userId);
      case 'notify':
        return this.onNotifyChoice(ctx, action.mode);
      case 'notify_rule':
        return this.cycleNotify(ctx, action.ruleId);
      case 'create':
        if (!this.deps.pool.connected(this.actor)) return this.beginSignIn(ctx);
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
        const removed = this.deps.logs.clearAll(this.actor);
        return this.show(ctx, { title: 'Logs cleared', lines: [`Cleared ${removed} log entries.`], rows: settingsRows() });
      }
      default:
        return this.expired(ctx);
    }
  }

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    if (!text || text.startsWith('/')) return;
    if (await this.acceptLoginText(ctx, text)) return;
    if (await this.acceptInvite(ctx, text)) return;
    const wizard = this.wizard.get();
    if (!wizard || !isManual(wizard)) {
      await this.show(ctx, {
        title: 'Use the buttons',
        lines: ['Send /menu to open the dialog again.'],
        rows: this.menuRows(),
      });
      return;
    }
    const kind = manualKind(wizard);
    if (!kind) return this.expired(ctx);
    const chat = await this.directory().resolve(text, kind);
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
      lines: ['Send a public `@username`, a `https://t.me/name` link, or a numeric chat id. Invite links are not accepted.'],
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
    const baseline = await this.directory().latestMessageId(wizard.source);
    const rule = this.deps.rules.create({
      source: wizard.source,
      destination: wizard.destination,
      selfUserId: selfId,
      baselineMessageId: baseline,
      hideSender: wizard.hideSender,
      notify: wizard.notify,
    });
    await this.deps.pool.announce(this.actor, rule, 'started');
    this.deps.logs.write({
      ruleId: rule.id,
      ownerUserId: this.actor,
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
      rows: this.menuRows(),
    });
  }

  private async confirmEdit(ctx: Context, wizard: Extract<Wizard, { type: 'edit' }>): Promise<void> {
    if (wizard.phase !== 'confirm' || !wizard.candidate) return this.expired(ctx);
    const existing = this.deps.rules.get(wizard.ruleId, this.actor);
    if (!existing) return this.missing(ctx);
    const source = wizard.field === 'source' ? wizard.candidate : chatFromRule(existing, 'source');
    const baseline = await this.directory().latestMessageId(source);
    const rule = this.deps.rules.updateEndpoint(wizard.ruleId, wizard.field, wizard.candidate, baseline, this.requireSelf());
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Rule updated',
      lines: dialogLines(`Rule #${rule.id} was updated. Older messages will not be backfilled.`, formatRule(rule)),
      rows: this.menuRows(),
    });
  }

  private async selectChat(ctx: Context, wizard: Wizard, chat: ResolvedChat): Promise<void> {
    wizard.updatedAt = Date.now();
    if (wizard.type === 'create' && (wizard.phase === 'source-pick' || wizard.phase === 'source-manual')) {
      wizard.source = chat;
      wizard.phase = 'dest-kind';
      await this.show(ctx, {
        title: 'Destination',
        lines: dialogLines(`**Source selected.** ${formatChat(chat)}`, kindPrompt('destination')),
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
        lines: dialogLines(ruleSummary(wizard.source, chat, wizard.hideSender, wizard.notify)),
        rows: confirmRows(wizard.hideSender, wizard.notify),
      });
      return;
    }
    if (wizard.type === 'edit' && (wizard.phase === 'pick' || wizard.phase === 'manual')) {
      wizard.candidate = chat;
      wizard.phase = 'confirm';
      const existing = this.deps.rules.get(wizard.ruleId, this.actor);
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
    wizard.candidates = await this.directory().list(kind, includeSelf);
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
    const rules = this.deps.rules.list(this.actor);
    if (rules.length === 0) {
      await this.show(ctx, { title: 'No rules yet', lines: ['Create a forwarding rule to begin.'], rows: this.menuRows() });
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
      lines: dialogLines(intro, slice.items.map((rule) => formatRule(rule)).join('\n---\n')),
      rows: rulesRows(slice, mode),
    });
  }

  private async toggleRule(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId, this.actor);
    if (!rule) return this.missing(ctx);
    if (rule.status === 'active') {
      const paused = this.deps.rules.pause(ruleId, this.actor);
      await this.deps.pool.announce(this.actor, paused, 'paused');
      await this.show(ctx, { title: 'Paused', lines: [`Rule #${ruleId} is paused.`], rows: this.menuRows() });
      return;
    }
    const baseline = await this.directory().latestMessageId(chatFromRule(rule, 'source'));
    const started = this.deps.rules.activate(ruleId, baseline, this.actor);
    await this.deps.pool.announce(this.actor, started, 'started');
    await this.show(ctx, {
      title: 'Active',
      lines: [`Rule #${ruleId} is active.`, 'Messages that arrived while it was paused are not forwarded.'],
      rows: this.menuRows(),
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
      lines: dialogLines(ruleSummary(wizard.source, wizard.destination, hide, wizard.notify)),
      rows: confirmRows(hide, wizard.notify),
    });
  }

  private async toggleHideSender(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId, this.actor);
    if (!rule) return this.missing(ctx);
    this.deps.rules.setHideSender(ruleId, !rule.hideSender, this.actor);
    await this.showEditFields(ctx, ruleId);
  }

  private async showEditFields(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId, this.actor);
    if (!rule) return this.missing(ctx);
    this.wizard.clear();
    await this.show(ctx, {
      title: `Rule #${rule.id}`,
      lines: dialogLines(formatRule(rule), 'What do you want to change?'),
      rows: editFieldRows(ruleId, rule.hideSender, rule.notify),
    });
  }

  private async askDelete(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId, this.actor);
    if (!rule) return this.missing(ctx);
    await this.show(ctx, {
      title: `Delete rule #${rule.id}?`,
      lines: dialogLines(formatRule(rule), 'Telegram messages already delivered are left as they are.'),
      rows: deleteConfirmRows(ruleId),
    });
  }

  private async deleteRule(ctx: Context, ruleId: number): Promise<void> {
    const existing = this.deps.rules.get(ruleId, this.actor);
    if (existing) await this.deps.pool.announce(this.actor, existing, 'stopped');
    const removed = this.deps.rules.delete(ruleId, this.actor);
    await this.show(ctx, {
      title: removed ? 'Deleted' : 'Already gone',
      lines: [removed ? `Rule #${ruleId} was deleted.` : 'That rule no longer exists.'],
      rows: this.menuRows(),
    });
  }

  private async showLogs(ctx: Context, page: number): Promise<void> {
    const total = this.deps.logs.count(this.actor);
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    const safe = Math.min(Math.max(0, page), pages - 1);
    const entries = this.deps.logs.list(safe * LOG_PAGE_SIZE, LOG_PAGE_SIZE, this.actor);
    const body = entries.length === 0 ? 'No forwarding logs yet. Message text is never stored.' : entries.map((entry) => formatLog(entry)).join('\n\n');
    await this.show(ctx, {
      title: 'Logs',
      lines: dialogLines(`Page ${safe + 1} of ${pages}.`, body),
      rows: logsRows(safe, pages),
    });
  }

  private async showSettings(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts(this.actor);
    await this.show(ctx, {
      title: 'Settings',
      lines: [
        `**User client.** ${this.deps.pool.connected(this.actor) ? 'connected' : 'disconnected'}`,
        `**Active rules.** ${counts.active}`,
        `**Paused rules.** ${counts.paused}`,
        'Only you and people with a one-time invite can open this bot.',
        'Pausing does not delete rules. Resuming does not backfill older messages.',
      ],
      rows: settingsRows(),
    });
  }

  private async pauseAll(ctx: Context): Promise<void> {
    const active = this.deps.rules.list(this.actor).filter((rule) => rule.status === 'active');
    const paused = this.deps.rules.pauseAll(this.actor);
    for (const rule of active) await this.deps.pool.announce(this.actor, { ...rule, status: 'paused' }, 'paused');
    await this.show(ctx, {
      title: 'Paused',
      lines: [`Paused ${paused} active rule${paused === 1 ? '' : 's'}.`],
      rows: settingsRows(),
    });
  }

  private async resumeAll(ctx: Context): Promise<void> {
    const paused = this.deps.rules.list(this.actor).filter((rule) => rule.status === 'paused');
    let started = 0;
    let failed = 0;
    for (const rule of paused) {
      try {
        const baseline = await this.directory().latestMessageId(chatFromRule(rule, 'source'));
        const resumed = this.deps.rules.activate(rule.id, baseline, this.actor);
        await this.deps.pool.announce(this.actor, resumed, 'started');
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
        'Forward **new** messages from chats your account can access.',
        '*This bot only controls the rules. It does not read your private chats.*',
      ],
      rows: this.menuRows(),
    });
  }

  private async showStatus(ctx: Context): Promise<void> {
    const counts = this.deps.rules.counts(this.actor);
    const selfId = this.deps.pool.selfId(this.actor);
    await this.show(ctx, {
      title: 'Status',
      lines: [
        `**User client.** ${this.deps.pool.connected(this.actor) ? 'connected' : 'disconnected'}`,
        `**Account id.** ${selfId ?? 'unavailable'}`,
        `**Active rules.** ${counts.active}`,
        `**Paused rules.** ${counts.paused}`,
        'Only you and people with a one-time invite can open this bot.',
        'Session file: stored locally with restricted permissions.',
      ],
      rows: this.menuRows(),
    });
  }

  private async expired(ctx: Context): Promise<void> {
    this.wizard.clear();
    await this.show(ctx, {
      title: 'Step expired',
      lines: ['Open the menu and start again.'],
      rows: this.menuRows(),
    });
  }

  private async missing(ctx: Context): Promise<void> {
    await this.show(ctx, { title: 'Missing rule', lines: ['That rule no longer exists.'], rows: this.menuRows() });
  }

  private showKind(ctx: Context, side: 'source' | 'destination'): Promise<void> {
    const title = side === 'source' ? 'Source' : 'Destination';
    return this.show(ctx, { title, lines: dialogLines(kindPrompt(side)), rows: kindRows() });
  }

  private async show(ctx: Context, dialog: Dialog): Promise<void> {
    const thread = this.thread(ctx);
    if (dialog.replyPlaceholder) {
      const editingAnchor = thread.anchorId !== undefined && ctx.callbackQuery?.message?.message_id === thread.anchorId;
      if (!editingAnchor) await this.deleteStored(ctx, thread.anchorId);
      await this.deleteStored(ctx, thread.promptId);
      thread.promptId = undefined;
      const anchor = await present(ctx, { ...dialog, replyPlaceholder: undefined });
      thread.anchorId = anchor.messageId;
      const prompt = await present(ctx, replyNudge(dialog.replyPlaceholder));
      thread.promptId = prompt.messageId;
      return;
    }

    const editingAnchor = thread.anchorId !== undefined && ctx.callbackQuery?.message?.message_id === thread.anchorId;
    if (thread.promptId !== undefined && !editingAnchor) {
      await this.deleteStored(ctx, thread.anchorId);
      thread.anchorId = undefined;
    }
    await this.deleteStored(ctx, thread.promptId);
    thread.promptId = undefined;
    const shown = await present(ctx, dialog);
    thread.anchorId = shown.messageId;
  }

  private async deleteStored(ctx: Context, messageId: number | undefined): Promise<void> {
    const chatId = ctx.chatId;
    if (messageId === undefined || chatId === undefined) return;
    await ctx.api.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }

  private requireSelf(): string {
    const selfId = this.deps.pool.selfId(this.actor);
    if (!selfId) throw new AppError('Sign in with your phone number before creating a rule.');
    return selfId;
  }

  private directory(): ChatDirectory {
    const directory = this.deps.pool.directory(this.actor);
    if (!directory) throw new AppError('Sign in with your phone number before choosing a chat.');
    return directory;
  }

  private menuRows() {
    return mainMenuRows({ admin: this.actor === this.deps.allowedUserId, signedIn: this.deps.pool.connected(this.actor) });
  }

  private thread(ctx: Context): { anchorId?: number; promptId?: number } {
    const chatId = ctx.chatId ?? 0;
    let thread = this.threads.get(chatId);
    if (!thread) {
      thread = {};
      this.threads.set(chatId, thread);
    }
    return thread;
  }

  private async onNotifyChoice(ctx: Context, mode: NotifyMode): Promise<void> {
    const wizard = this.wizard.get();
    if (!wizard || wizard.type !== 'create' || wizard.phase !== 'confirm' || !wizard.source || !wizard.destination) {
      return this.expired(ctx);
    }
    wizard.notify = mode;
    wizard.updatedAt = Date.now();
    await this.show(ctx, {
      title: 'Review the rule',
      lines: dialogLines(ruleSummary(wizard.source, wizard.destination, wizard.hideSender, mode)),
      rows: confirmRows(wizard.hideSender, mode),
    });
  }

  private async cycleNotify(ctx: Context, ruleId: number): Promise<void> {
    const rule = this.deps.rules.get(ruleId, this.actor);
    if (!rule) return this.missing(ctx);
    this.deps.rules.setNotify(ruleId, nextNotifyMode(rule.notify), this.actor);
    await this.showEditFields(ctx, ruleId);
  }

  private async createInvite(ctx: Context): Promise<void> {
    if (this.actor !== this.deps.allowedUserId) return this.showMain(ctx);
    const code = this.deps.accounts.createInvite();
    await this.show(ctx, {
      title: 'One-time invite',
      lines: [
        'Send this code to one person. It works once and expires in 24 hours.',
        `\`${code}\``,
        'They open this bot and send the code. Then they sign in with their own phone number.',
      ],
      rows: this.menuRows(),
    });
  }

  private async showPeople(ctx: Context): Promise<void> {
    if (this.actor !== this.deps.allowedUserId) return this.showMain(ctx);
    const people = this.deps.accounts.listMembers();
    await this.show(ctx, {
      title: 'People',
      lines:
        people.length === 0
          ? ['Nobody else has joined yet. Create an invite and send the code to one person.']
          : people.map((person) => `**${mdEscape(person.displayName)}** \`${person.userId}\``),
      rows: peopleRows(people),
    });
  }

  private async askRemove(ctx: Context, userId: string): Promise<void> {
    if (this.actor !== this.deps.allowedUserId) return this.showMain(ctx);
    const person = this.deps.accounts.get(userId);
    if (!person || person.role !== 'member') return this.showPeople(ctx);
    await this.show(ctx, {
      title: 'Remove this person?',
      lines: [
        `**${mdEscape(person.displayName)}** loses the menu.`,
        'Their rules stop and their saved login is deleted.',
      ],
      rows: removePersonRows(userId),
    });
  }

  private async removePerson(ctx: Context, userId: string): Promise<void> {
    if (this.actor !== this.deps.allowedUserId || userId === this.deps.allowedUserId) return this.showMain(ctx);
    const removed = this.deps.accounts.revoke(userId);
    if (removed) {
      this.deps.rules.pauseAll(userId);
      await this.deps.pool.drop(userId);
    }
    await this.show(ctx, {
      title: removed ? 'Removed' : 'Already gone',
      lines: [removed ? 'That person can no longer use the bot.' : 'That person is not an active member.'],
      rows: this.menuRows(),
    });
  }

  private async acceptInvite(ctx: Context, text: string): Promise<boolean> {
    if (this.actor === this.deps.allowedUserId || this.deps.accounts.hasAccess(this.actor)) return false;
    if (!this.deps.accounts.redeem(text, this.actor)) {
      await this.show(ctx, {
        title: 'Invite not accepted',
        lines: ['That code is missing, expired, or already used.'],
        rows: [],
      });
      return true;
    }
    const from = ctx.from;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() || 'Telegram user';
    this.deps.accounts.grantMember(this.actor, name, from?.username ?? null);
    await this.deleteSecret(ctx);
    await this.beginSignIn(ctx);
    return true;
  }

  private async acceptLoginText(ctx: Context, text: string): Promise<boolean> {
    const attempt = this.logins.get(this.actor);
    if (!attempt || !attempt.wait) return false;
    await this.deleteSecret(ctx);
    const value = text.trim();
    if (attempt.phase === 'phone' && !/^\+\d{8,15}$/.test(value.replace(/[\s()-]/g, ''))) {
      await this.tell(attempt, {
        title: 'Phone number',
        lines: ['Use international format, for example `+15551234567`.'],
        rows: [[button('Cancel', 'cancel')]],
      });
      return true;
    }
    if (attempt.phase === 'code' && !/^\d{5,6}$/.test(value.replace(/\s+/g, ''))) {
      await this.tell(attempt, {
        title: 'Login code',
        lines: ['Send the numeric code Telegram showed you. It is deleted from this chat.'],
        rows: [[button('Cancel', 'cancel')]],
      });
      return true;
    }
    if (attempt.phase === 'password' && value.length === 0) return true;
    const wait = attempt.wait;
    attempt.wait = null;
    wait.resolve(attempt.phase === 'phone' ? value.replace(/[\s()-]/g, '') : attempt.phase === 'code' ? value.replace(/\s+/g, '') : value);
    return true;
  }

  private async beginSignIn(ctx: Context): Promise<void> {
    if (this.deps.pool.connected(this.actor)) return this.showMain(ctx);
    if (!ctx.chatId) return;
    this.abortLogin();
    const client = createTelegramClient(this.deps.api, '');
    const attempt: LoginAttempt = {
      client,
      chatId: ctx.chatId,
      api: ctx.api,
      phase: 'phone',
      wait: null,
      cancelled: false,
    };
    this.logins.set(this.actor, attempt);
    const userId = this.actor;
    void runBotLogin(client, {
      phone: (retry) => this.askSecret(attempt, 'phone', retry),
      code: (retry) => this.askSecret(attempt, 'code', retry),
      password: (retry) => this.askSecret(attempt, 'password', retry),
      rejected: async (message) => {
        await this.tell(attempt, {
          title: 'Sign-in stopped',
          lines: [mdEscape(message)],
          rows: mainMenuRows({ admin: userId === this.deps.allowedUserId, signedIn: false }),
        });
      },
      cancelled: () => attempt.cancelled,
    })
      .then(async () => {
        if (attempt.cancelled || this.logins.get(userId) !== attempt) return;
        const me = await client.getMe();
        if (me.id.toString() !== userId) {
          await client.invoke(new Api.auth.LogOut()).catch(() => undefined);
          await client.disconnect().catch(() => undefined);
          this.logins.delete(userId);
          await this.tell(attempt, {
            title: 'Wrong account',
            lines: ['Sign in with the same Telegram account that is chatting with this bot.'],
            rows: [[button('Try again', 'signin', 'primary')]],
          });
          return;
        }
        const name = [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || 'Telegram user';
        if (userId === this.deps.allowedUserId) this.deps.accounts.ensureAdmin(userId);
        this.deps.accounts.rememberProfile(userId, name, me.username ?? null);
        await this.deps.pool.adopt(userId, client);
        this.logins.delete(userId);
        await this.tell(attempt, {
          title: 'Signed in',
          lines: ['This account can forward new messages. Your rules stay separate from everyone else.'],
          rows: mainMenuRows({ admin: userId === this.deps.allowedUserId, signedIn: true }),
        });
      })
      .catch(async (error: unknown) => {
        this.logins.delete(userId);
        await client.disconnect().catch(() => undefined);
        if (isLoginCancel(error) || attempt.cancelled) return;
        this.deps.logger.warn({ event: 'sign_in_failed', userId, code: error instanceof Error ? error.name : 'Error' }, 'sign-in failed');
        await this.tell(attempt, {
          title: 'Sign-in stopped',
          lines: ['Send /start and try again. The phone number and code were not saved.'],
          rows: [[button('Try again', 'signin', 'primary')]],
        }).catch(() => undefined);
      });
  }

  private askSecret(attempt: LoginAttempt, phase: LoginAttempt['phase'], retry: boolean): Promise<string> {
    const wait = deferred<string>();
    attempt.phase = phase;
    attempt.wait = wait;
    const dialog =
      phase === 'phone'
        ? {
            title: 'Phone number',
            lines: [retry ? 'That number was not accepted. Send it as `+15551234567`.' : 'Send your phone number in international format, for example `+15551234567`.'],
          }
        : phase === 'code'
          ? {
              title: 'Login code',
              lines: [
                retry
                  ? 'That code was not accepted. Send the latest code Telegram showed you.'
                  : 'Telegram sent a login code to your account. Send that code here. This message is deleted.',
              ],
            }
          : {
              title: 'Two-step password',
              lines: [retry ? 'That password was not accepted. Send it again.' : 'This account has a two-step password. Send it here. This message is deleted.'],
            };
    void this.tell(attempt, { ...dialog, rows: [[button('Cancel', 'cancel')]] });
    return wait.promise;
  }

  private abortLogin(): void {
    const attempt = this.logins.get(this.actor);
    if (!attempt) return;
    attempt.cancelled = true;
    attempt.wait?.reject(new LoginCancelled());
    void attempt.client.disconnect().catch(() => undefined);
    this.logins.delete(this.actor);
  }

  private async tell(attempt: LoginAttempt, dialog: Dialog): Promise<void> {
    const rich = renderDialog(dialog);
    const keyboard = dialogKeyboard(dialog.rows);
    await attempt.api.sendRichMessage({
      chat_id: attempt.chatId,
      rich_message: rich,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  private async deleteSecret(ctx: Context): Promise<void> {
    const chatId = ctx.chatId;
    const messageId = ctx.message?.message_id;
    if (chatId === undefined || messageId === undefined) return;
    await ctx.api.deleteMessage({ chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
