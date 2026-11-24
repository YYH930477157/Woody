/**
 * Problems read from CMake job output: compiler and linker diagnostics, and CMake's own errors.
 *
 * The parser is deliberately line based and forgiving. It only has to find what a person would
 * look for first; the raw output stays one click away.
 */

export type CmakeProblemSeverity = 'error' | 'warning';

export type CmakeProblem = {
  severity: CmakeProblemSeverity;
  message: string;
  /** As written in the output; may be relative to the project. */
  file?: string;
  line?: number;
  column?: number;
  /** Zero-based index of the output line the problem starts on. */
  outputLine: number;
};

export type CmakeOutputLineKind = 'error' | 'warning' | 'command' | 'plain';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const FILE = String.raw`(?:[A-Za-z]:)?[^:\s(][^:(]*?`;
/** gcc / clang: `src/a.c:3:7: warning: unused variable 'x'` (column optional). */
const GCC = new RegExp(String.raw`^(${FILE}):(\d+)(?::(\d+))?:\s+(fatal error|error|warning):\s+(.+)$`);
/** MSVC: `src\a.c(12,5): error C2065: 'x': undeclared identifier`. */
const MSVC = new RegExp(
  String.raw`^(${FILE})\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning)\s*(?:[A-Z]+\d+)?\s*:\s*(.+)$`
);
/** `CMake Error at CMakeLists.txt:12 (add_executable):`, `CMake Warning (dev) at ...:` or a bare `CMake Warning:`. */
const CMAKE = /^CMake (Error|Warning)(?: \(([^)]*)\))?(?: at (.+?):(\d+)(?: \([^)]*\))?)?\s*:\s*(.*)$/;
/**
 * Woody passes both compilers on every configure, so a C-only project always gets "Manually-specified variables
 * were not used" (unused-cli). The user cannot act on it; leave it in the log only.
 */
const IGNORED_CMAKE_CATEGORIES = new Set(['unused-cli']);
const LD_TOOL = /^(?:.*?[\\/])?(?:ld|ld\.lld)(?:\.exe)?:\s+/i;
const OBJECT_PREFIX = /^(?:[A-Za-z]:)?[^:\s]+?\.(?:o|obj)\)?:\s*/i;
/**
 * Linker symbol errors with a source location (`src/main.c:42: undefined reference to ...` in `-g` builds, or
 * `main.c:(.text+0x1e): undefined reference to ...`), optionally preceded by `ld.exe: foo.obj:`.
 */
const UNDEFINED = new RegExp(
  String.raw`^(${FILE}):(?:(\d+)(?::\([^)]*\))?|\([^)]*\)):\s*(undefined reference to .+|multiple definition of .+)$`
);
const UNDEFINED_OBJECT_ONLY = /^(?:\([^)]*\):\s*)?(undefined reference to .+|multiple definition of .+)$/;
/** A tool that names itself: `gcc: error: unrecognized option`, `collect2.exe: error: ld returned 1 exit status`. */
const TOOL = /^((?:[A-Za-z]:)?[^\s:]+):\s+(fatal error|error|warning):\s+(.+)$/;
/** The linker without a source location: `.../ld.exe: cannot find -lfoo: No such file or directory`. */
const LINKER = /^(?:.*?[\\/])?(?:ld|ld\.lld|lld-link|link)(?:\.exe)?:\s+(.+)$/i;
const LINKER_ERROR = /cannot find|cannot open|undefined reference|multiple definition|unresolved external/i;
const COLLECT2_SUMMARY = /ld returned \d+ exit status/;
const normalizeSlashes = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

function severityOf(kind: string): CmakeProblemSeverity {
  return kind.toLowerCase().includes('warning') ? 'warning' : 'error';
}

function toNumber(text?: string): number | undefined {
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Split once so both the parser and the console agree on line indexes. */
export function splitOutputLines(output: string): string[] {
  return output.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
}

/** CMake puts its message on the indented lines that follow the header. */
function cmakeMessage(lines: string[], start: number, inline: string): string {
  const parts = inline.trim() ? [inline.trim()] : [];
  for (let index = start + 1; index < lines.length && parts.length < 3; index++) {
    const text = lines[index];
    if (!text.trim()) {
      if (parts.length) break;
      continue;
    }
    if (!/^\s/.test(text)) break;
    parts.push(text.trim());
  }
  return parts.join(' ');
}

/** The problem a single output line reports, if any. CMake headers also read the message lines under them. */
function problemAt(lines: string[], outputLine: number): CmakeProblem | undefined {
  const text = lines[outputLine].trimEnd();
  if (!text) return undefined;
  let match = CMAKE.exec(text);
  if (match) {
    if (match[2] && IGNORED_CMAKE_CATEGORIES.has(match[2])) return undefined;
    return {
      severity: severityOf(match[1]),
      file: match[3],
      line: toNumber(match[4]),
      message: cmakeMessage(lines, outputLine, match[5]) || text,
      outputLine,
    };
  }
  match = GCC.exec(text) ?? MSVC.exec(text);
  if (match) {
    return {
      severity: severityOf(match[4]),
      file: match[1].trim(),
      line: toNumber(match[2]),
      column: toNumber(match[3]),
      message: match[5].trim(),
      outputLine,
    };
  }
  const withoutLd = text.replace(LD_TOOL, '');
  const withoutObject = withoutLd.replace(OBJECT_PREFIX, '');
  match = UNDEFINED.exec(withoutObject);
  if (match && !/\.(?:o|obj)$/i.test(match[1])) {
    return {
      severity: 'error',
      file: match[1].trim(),
      line: toNumber(match[2]),
      message: match[3].trim(),
      outputLine,
    };
  }
  if (withoutObject !== withoutLd) {
    match = UNDEFINED_OBJECT_ONLY.exec(withoutObject);
    if (match) return { severity: 'error', message: match[1].trim(), outputLine };
  }
  match = TOOL.exec(text);
  if (match) {
    return {
      severity: severityOf(match[2]),
      message: `${match[1].split(/[\\/]/).pop()}: ${match[3].trim()}`,
      outputLine,
    };
  }
  match = LINKER.exec(text);
  if (match && LINKER_ERROR.test(match[1])) return { severity: 'error', message: `ld: ${match[1].trim()}`, outputLine };
  return undefined;
}

export function parseCmakeProblems(output: string): CmakeProblem[] {
  const lines = splitOutputLines(output);
  const problems: CmakeProblem[] = [];
  const seen = new Set<string>();
  lines.forEach((_line, outputLine) => {
    const problem = problemAt(lines, outputLine);
    if (!problem) return;
    // Builds repeat themselves (CMake prints a failed test compile twice); list each problem once.
    const key = [problem.severity, problem.file, problem.line, problem.column, problem.message].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(problem);
  });

  // "ld returned 1 exit status" only repeats that the link failed; keep it when nothing better was found.
  const isSummary = (problem: CmakeProblem) => !problem.file && COLLECT2_SUMMARY.test(problem.message);
  return problems.some((problem) => problem.severity === 'error' && !isSummary(problem))
    ? problems.filter((problem) => !isSummary(problem))
    : problems;
}

/** How the console colors each output line; repeated problems are colored every time they appear. */
export function classifyOutputLines(lines: string[]): CmakeOutputLineKind[] {
  return lines.map((line, index) => problemAt(lines, index)?.severity ?? (/^\s*>\s?/.test(line) ? 'command' : 'plain'));
}

/** Resolve a problem's file against the project so the editor can open it. */
export function resolveProblemPath(file: string, projectPath: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(file)) return file;
  const base = projectPath.replace(/[\\/]+$/, '');
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base}${separator}${file.replace(/^\.[\\/]/, '')}`;
}

/** A path inside the project as `build/debug`; anything else unchanged. Windows paths compare case-insensitively. */
export function projectRelativePath(path: string, projectPath: string): string {
  const root = normalizeSlashes(projectPath);
  const target = normalizeSlashes(path);
  if (!root || target.length <= root.length + 1 || target[root.length] !== '/') return path;
  const head = target.slice(0, root.length);
  const windows = /^[A-Za-z]:\//.test(root);
  const inside = windows ? head.toLowerCase() === root.toLowerCase() : head === root;
  return inside ? target.slice(root.length + 1) : path;
}
