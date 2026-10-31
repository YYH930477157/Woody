import type { TFunction } from 'i18next';
import type { GitOperationOutcome } from '@/common/types/sourceControl/operationTypes';

/** Reasons with a translated explanation that says what happened and what to do next. */
const EXPLAINED = new Set([
  'refChanged',
  'branchChanged',
  'invalidName',
  'remoteUnsupported',
  'remoteChanged',
  'operationInProgress',
  'operationEnded',
  'unresolvedConflicts',
  'dirtyWorktree',
  'gitLocked',
  'localChanges',
  'rewriteUnsupported',
  'gitTooOld',
  'cancelled',
]);

/** Git's own text replaces nothing it alone can say, except this lock message, which names the file to look at. */
const KEEPS_OUTPUT = new Set(['gitLocked']);

/** The user's-language summary of an outcome when there is one, and whatever raw output still adds to it. */
export function explainOutcome(outcome: GitOperationOutcome, t: TFunction): { summary?: string; details: string } {
  const { reason, output } = outcome;
  if (!reason || !EXPLAINED.has(reason)) return { details: output };
  return {
    summary: t(`conversation.gitWorkbench.operations.reasons.${reason}`),
    details: KEEPS_OUTPUT.has(reason) ? output : '',
  };
}

/** The same explanation as one block of text, for places that only show a message. */
export function outcomeText(outcome: GitOperationOutcome, t: TFunction): string {
  const { summary, details } = explainOutcome(outcome, t);
  return (
    [summary, details].filter(Boolean).join('\n') || t(`conversation.gitWorkbench.operations.outcomes.${outcome.state}`)
  );
}
