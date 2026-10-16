import type {
  CommitMessageFields,
  CommitMessageValidation,
  LargeChangeMetrics,
} from '@/common/types/sourceControl/gitWorkflowTypes';

const REQUIRED_FIELDS: Array<keyof Pick<CommitMessageFields, 'reason' | 'scope' | 'solution' | 'impact' | 'tests'>> = [
  'reason',
  'scope',
  'solution',
  'impact',
  'tests',
];

export const resolveSelectedPaths = (paths: readonly string[], selected: ReadonlySet<string>): string[] =>
  paths.filter((path) => selected.has(path));

export const needsLargeChangeNote = ({ fileCount, changedLines }: LargeChangeMetrics): boolean =>
  fileCount > 10 || changedLines > 100;

export const validateCommitMessage = (fields: CommitMessageFields): CommitMessageValidation => {
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field].trim()) return { ok: false, field };
  }
  return { ok: true };
};

export const formatCommitMessage = (fields: CommitMessageFields): string => {
  const lines = [
    `【修改原因】: ${fields.reason.trim()}`,
    `【修改范围】: ${fields.scope.trim()}`,
    `【修改方案】: ${fields.solution.trim()}`,
    `【影响评估】: ${fields.impact.trim()}`,
    `【测试步骤】: ${fields.tests.trim()}`,
  ];
  if (fields.largeChangeNote?.trim()) lines.push(`【强制推送】: ${fields.largeChangeNote.trim()}`);
  return lines.join('\n');
};
