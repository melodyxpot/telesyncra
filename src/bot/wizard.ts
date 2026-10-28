import { WIZARD_TTL_MS } from '../constants.js';
import type { ChatKind, ResolvedChat } from '../types.js';

export type CreatePhase =
  | 'source-kind'
  | 'source-pick'
  | 'source-manual'
  | 'dest-kind'
  | 'dest-pick'
  | 'dest-manual'
  | 'confirm';

export type EditPhase = 'kind' | 'pick' | 'manual' | 'confirm';

export interface CreateWizard {
  type: 'create';
  phase: CreatePhase;
  sourceKind?: ChatKind;
  destKind?: ChatKind;
  source?: ResolvedChat;
  destination?: ResolvedChat;
  hideSender: boolean;
  candidates: ResolvedChat[];
  page: number;
  updatedAt: number;
}

export interface EditWizard {
  type: 'edit';
  ruleId: number;
  field: 'source' | 'dest';
  phase: EditPhase;
  kind?: ChatKind;
  candidate?: ResolvedChat;
  candidates: ResolvedChat[];
  page: number;
  updatedAt: number;
}

export type Wizard = CreateWizard | EditWizard;

export class WizardStore {
  private current: Wizard | null = null;

  get(now = Date.now()): Wizard | null {
    if (!this.current) return null;
    if (now - this.current.updatedAt > WIZARD_TTL_MS) {
      this.current = null;
      return null;
    }
    return this.current;
  }

  set(wizard: Wizard): void {
    this.current = wizard;
  }

  clear(): void {
    this.current = null;
  }
}

export function createWizard(now = Date.now()): CreateWizard {
  return { type: 'create', phase: 'source-kind', hideSender: true, candidates: [], page: 0, updatedAt: now };
}

export function editWizard(ruleId: number, field: 'source' | 'dest', now = Date.now()): EditWizard {
  return { type: 'edit', ruleId, field, phase: 'kind', candidates: [], page: 0, updatedAt: now };
}

export function isManual(wizard: Wizard): boolean {
  return wizard.type === 'create'
    ? wizard.phase === 'source-manual' || wizard.phase === 'dest-manual'
    : wizard.phase === 'manual';
}
