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
