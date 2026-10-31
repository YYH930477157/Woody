import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { explainOutcome, outcomeText } from '@/renderer/pages/conversation/SourceControl/Workbench/operationOutcome';

const t = ((key: string) => key) as unknown as TFunction;
const REASONS = 'conversation.gitWorkbench.operations.reasons';

describe('explainOutcome', () => {
  it('replaces the English message with an explanation the user can act on', () => {
    const outcome = {
      state: 'blocked' as const,
      reason: 'dirtyWorktree',
      output: 'A clean working tree and index are required before history operations',
    };

    expect(explainOutcome(outcome, t)).toEqual({ summary: `${REASONS}.dirtyWorktree`, details: '' });
  });

  it('keeps Git output for failures the app cannot explain', () => {
    const outcome = { state: 'error' as const, output: 'fatal: unable to access remote' };

    expect(explainOutcome(outcome, t)).toEqual({ details: 'fatal: unable to access remote' });
  });

  it('does not guess at a reason it has no translation for', () => {
    const outcome = { state: 'blocked' as const, reason: 'somethingNew', output: 'raw text' };

    expect(explainOutcome(outcome, t)).toEqual({ details: 'raw text' });
  });

  it('keeps the lock file path, which the translation cannot name', () => {
    const outcome = { state: 'blocked' as const, reason: 'gitLocked', output: 'locked: C:/repo/.git/index.lock' };

    expect(explainOutcome(outcome, t).details).toContain('index.lock');
  });
});

describe('outcomeText', () => {
  it('falls back to the state title when there is nothing else to say', () => {
    expect(outcomeText({ state: 'complete', output: '' }, t)).toBe(
      'conversation.gitWorkbench.operations.outcomes.complete'
    );
  });
});
