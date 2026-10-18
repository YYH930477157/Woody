import { describe, expect, it } from 'vitest';

import {
  formatCommitMessage,
  needsLargeChangeNote,
  normalizeCommitMessageFields,
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

  it('normalizes template labels before formatting the final commit message', () => {
    const normalized = normalizeCommitMessageFields(validMessage);
    expect(normalized).toEqual({
      reason: '【BUG[x]】修复曲线状态字错误',
      scope: '【曲线】',
      solution: '修正状态字更新条件',
      impact: '【无影响】',
      tests: '完成曲线回归测试',
    });
    expect(formatCommitMessage(validMessage)).toBe(
      [
        '【修改原因】: 【BUG[x]】修复曲线状态字错误',
        '【修改范围】: 【曲线】',
        '【修改方案】: 修正状态字更新条件',
        '【影响评估】: 【无影响】',
        '【测试步骤】: 完成曲线回归测试',
      ].join('\n')
    );
  });

  it('converts non-template draft values to the required reason, scope and impact syntax', () => {
    expect(
      normalizeCommitMessageFields({
        reason: '【优化】优化标签查询',
        scope: '【skillhub/routers/skills.py】',
        solution: '增加标签索引',
        impact: '标签可索引，其他功能不受影响',
        tests: '运行 pytest',
      })
    ).toEqual({
      reason: '【OPT】优化标签查询',
      scope: '【$skillhub功能模块】',
      solution: '增加标签索引',
      impact: '【其他】标签可索引，其他功能不受影响',
      tests: '运行 pytest',
    });
  });
});
