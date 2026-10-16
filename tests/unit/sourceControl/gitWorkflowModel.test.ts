import { describe, expect, it } from 'vitest';

import {
  needsLargeChangeNote,
  resolveSelectedPaths,
  validateCommitMessage,
} from '@/process/services/sourceControl/gitWorkflowModel';

const validMessage = {
  reason: '【修改原因】: 【BUG[x]】修复曲线状态字错误',
  scope: '【修改范围】: 【曲线】',
  solution: '【修改方案】: 修正状态字更新条件',
  impact: '【影响评估】: 【无影响】',
  tests: '【测试步骤】: 完成曲线回归测试',
};

describe('git workflow model', () => {
  it('returns only the selected paths in stable input order', () => {
    expect(resolveSelectedPaths(['a.c', 'b.c', 'c.h'], new Set(['c.h', 'a.c']))).toEqual(['a.c', 'c.h']);
  });

  it('returns no paths when the selection is empty', () => {
    expect(resolveSelectedPaths(['a.c'], new Set())).toEqual([]);
  });

  it('requires a large-change note only after a strict threshold is exceeded', () => {
    expect(needsLargeChangeNote({ fileCount: 10, changedLines: 100 })).toBe(false);
    expect(needsLargeChangeNote({ fileCount: 11, changedLines: 1 })).toBe(true);
    expect(needsLargeChangeNote({ fileCount: 1, changedLines: 101 })).toBe(true);
  });

  it('accepts a complete commit message', () => {
    expect(validateCommitMessage(validMessage)).toEqual({ ok: true });
  });

  it('reports the first missing commit message field', () => {
    expect(validateCommitMessage({ ...validMessage, reason: '' })).toEqual({ ok: false, field: 'reason' });
  });
});
