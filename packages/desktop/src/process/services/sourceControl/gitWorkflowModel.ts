import type {
  CommitMessageFields,
  CommitMessageValidation,
  GitCommitSnapshot,
  LargeChangeMetrics,
  GitWorkflowReasonCode,
} from '@/common/types/sourceControl/gitWorkflowTypes';

/** Check that the selected tree, parent revision and branch still match the scan. */
export const isSameCommitSnapshot = (left: GitCommitSnapshot, right: GitCommitSnapshot): boolean =>
  left.head === right.head && left.branch === right.branch && left.tree === right.tree;

const REQUIRED_FIELDS: Array<keyof Pick<CommitMessageFields, 'reason' | 'scope' | 'solution' | 'impact' | 'tests'>> = [
  'reason',
  'scope',
  'solution',
  'impact',
  'tests',
];

const TEMPLATE_LABELS = {
  reason: '修改原因',
  scope: '修改范围',
  solution: '修改方案',
  impact: '影响评估',
  tests: '测试步骤',
  largeChangeNote: '强制推送',
} as const;

const COMMIT_SCOPE_OPTIONS = new Set([
  '协议栈',
  '驱动',
  '计量',
  '费率',
  '继电器',
  '负控',
  '升级',
  '时钟',
  '显示',
  '结算',
  '曲线',
  '需量',
  '预付费',
  '电网质量',
  '事件',
  '状态字',
  'P2P',
  'PLC',
  'MBUS',
  '生产协议',
  '文档',
  '工具',
  '打印',
]);

const COMMIT_IMPACT_OPTIONS = new Set(['EEPROM', 'DATAFLASH', 'LEGAL', '兼容性', '效率', '其他', '无影响']);

export const COMMIT_MESSAGE_TEMPLATE = [
  '【修改原因】:【BUG[x]|REQ[x]|OPT】说明修改原因',
  '【修改范围】:【协议栈|驱动|计量|费率|继电器|负控|升级|时钟|显示|结算|曲线|需量|预付费|电网质量|事件|状态字|P2P|PLC|MBUS|生产协议|文档|工具|打印|$...】',
  '【修改方案】: 简要说明修改方案',
  '【影响评估】:【EEPROM|DATAFLASH|LEGAL|兼容性|效率|其他|无影响】具体影响内容',
  '【测试步骤】: 简要说明自测试步骤及结果',
].join('\n');

const normalizeField = (field: keyof typeof TEMPLATE_LABELS, value: string | undefined): string => {
  if (!value) return '';
  const label = `【${TEMPLATE_LABELS[field]}】`;
  const normalized = value.trim();
  const prefix = normalized.startsWith(`${label}:`)
    ? `${label}:`
    : normalized.startsWith(`${label}：`)
      ? `${label}：`
      : undefined;
  return prefix ? normalized.slice(prefix.length).trim() : normalized;
};

const normalizeReason = (value: string): string => {
  const normalized = normalizeField('reason', value);
  if (!normalized) return '';
  const match = normalized.match(/^【(BUG|REQ)\[([^\]]*)\]】\s*(.*)$/);
  if (match) return `【${match[1]}[${match[2] || 'x'}]】${match[3].trim()}`;
  const categoryMatch = normalized.match(/^【(OPT|优化|需求|BUG|缺陷)】\s*(.*)$/);
  if (categoryMatch) {
    const category =
      categoryMatch[1] === '需求'
        ? 'REQ[x]'
        : categoryMatch[1] === 'BUG' || categoryMatch[1] === '缺陷'
          ? 'BUG[x]'
          : 'OPT';
    return `【${category}】${categoryMatch[2].trim()}`;
  }
  return `【OPT】${normalized}`;
};

const normalizeScope = (value: string): string => {
  const normalized = normalizeField('scope', value);
  if (!normalized) return '';
  const token = normalized.match(/^【([^】]+)】/)?.[1]?.trim() || normalized;
  if (COMMIT_SCOPE_OPTIONS.has(token)) return `【${token}】`;
  if (token.startsWith('$') && !/[\\/]/.test(token)) return `【${token}】`;
  const moduleRoot = token
    .split(/[\\/]/)[0]
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  const customModule = moduleRoot ? `$${moduleRoot}功能模块` : '$自定义功能模块';
  const scope = token.includes('功能模块') && token.startsWith('$') ? token : customModule;
  return `【${scope}】`;
};

const normalizeImpact = (value: string): string => {
  const normalized = normalizeField('impact', value);
  if (!normalized) return '';
  const match = normalized.match(/^【([^】]+)】\s*(.*)$/);
  if (match && COMMIT_IMPACT_OPTIONS.has(match[1])) {
    return match[1] === '无影响' ? '【无影响】' : `【${match[1]}】${match[2].trim()}`;
  }
  if (normalized.includes('无影响')) return '【无影响】';
  return `【其他】${normalized}`;
};

export const normalizeCommitMessageFields = (fields: CommitMessageFields): CommitMessageFields => ({
  reason: normalizeReason(fields.reason),
  scope: normalizeScope(fields.scope),
  solution: normalizeField('solution', fields.solution),
  impact: normalizeImpact(fields.impact),
  tests: normalizeField('tests', fields.tests),
  ...(fields.largeChangeNote ? { largeChangeNote: normalizeField('largeChangeNote', fields.largeChangeNote) } : {}),
});

export const resolveSelectedPaths = (paths: readonly string[], selected: ReadonlySet<string>): string[] =>
  paths.filter((path) => selected.has(path));

export const needsLargeChangeNote = ({ fileCount, changedLines }: LargeChangeMetrics): boolean =>
  fileCount > 10 || changedLines > 100;

export const validateCommitMessage = (fields: CommitMessageFields): CommitMessageValidation => {
  const normalized = normalizeCommitMessageFields(fields);
  for (const field of REQUIRED_FIELDS) {
    if (!normalized[field]) return { ok: false, field };
  }
  return { ok: true };
};

export const formatCommitMessage = (fields: CommitMessageFields): string => {
  const normalized = normalizeCommitMessageFields(fields);
  const lines = [
    `【修改原因】: ${normalized.reason}`,
    `【修改范围】: ${normalized.scope}`,
    `【修改方案】: ${normalized.solution}`,
    `【影响评估】: ${normalized.impact}`,
    `【测试步骤】: ${normalized.tests}`,
  ];
  if (normalized.largeChangeNote) lines.push(`【强制推送】: ${normalized.largeChangeNote}`);
  return lines.join('\n');
};
export class WorkflowBlockedError extends Error {
  constructor(
    readonly reasonCode: GitWorkflowReasonCode,
    detail = ''
  ) {
    super(detail || reasonCode);
  }
}
