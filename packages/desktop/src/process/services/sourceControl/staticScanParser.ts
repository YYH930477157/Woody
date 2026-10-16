import type { StaticScanDiagnostic, StaticScanSeverity } from '@/common/types/sourceControl/staticScanTypes';

const severity = (value: string): StaticScanSeverity => {
  const normalized = value.toLowerCase();
  return normalized === 'error' || normalized === 'fatal error'
    ? 'error'
    : normalized === 'warning'
      ? 'warning'
      : 'info';
};

export const parseClangTidyDiagnostics = (output: string): StaticScanDiagnostic[] => {
  const diagnostics: StaticScanDiagnostic[] = [];
  const pattern = /^(.*?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*?)\s+\[([^\]]+)\]\s*$/;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    diagnostics.push({
      tool: 'clang-tidy',
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      severity: severity(match[4]),
      message: match[5].trim(),
      rule: match[6],
    });
  }
  return diagnostics;
};

export const parsePcLintDiagnostics = (output: string): StaticScanDiagnostic[] => {
  const diagnostics: StaticScanDiagnostic[] = [];
  const patterns = [
    /^(.*?)\((\d+)(?:[,;:]?(\d+))?\)\s*:\s*(Error|Warning|Info)\s*\((\d+)\)\s*(.+)$/,
    /^(.*?):(\d+):(\d+):\s*(Error|Warning|Info)\s*\((\d+)\)\s*(.+)$/,
    /^(.*?):(\d+):\s*(Error|Warning|Info)\s*\((\d+)\)\s*(.+)$/,
  ];
  for (const line of output.split(/\r?\n/)) {
    const match = patterns.map((pattern) => line.match(pattern)).find((value) => value !== null);
    if (!match) continue;
    const hasColumn = match[3] !== undefined && /^\d+$/.test(match[3]);
    const severityIndex = hasColumn ? 4 : match[3] !== undefined ? 3 : 4;
    const ruleIndex = severityIndex + 1;
    const messageIndex = ruleIndex + 1;
    diagnostics.push({
      tool: 'pc-lint',
      file: match[1],
      line: Number(match[2]),
      ...(hasColumn ? { column: Number(match[3]) } : {}),
      severity: severity(match[severityIndex]),
      rule: match[ruleIndex],
      message: match[messageIndex].trim(),
    });
  }
  return diagnostics;
};
