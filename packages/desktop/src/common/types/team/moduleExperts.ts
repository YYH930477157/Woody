/** One module expert of a project, saved in `<project>/.woody/experts.json`. */
export type ModuleExpert = {
  /** Lowercase ASCII words joined by `-`; also names the feature card `.woody/features/<id>.md`. */
  id: string;
  /** Name shown in the team, e.g. "Sensor 专家". */
  name: string;
  /** What the module does, so the dispatcher knows which requests belong to it. */
  summary: string;
  /** Project-relative files or folders the expert owns: `dir/` is a folder, `*` matches inside one path segment. */
  paths: string[];
};

export type ModuleExpertsFile = {
  version: 1;
  experts: ModuleExpert[];
  /** Files no expert owns, such as task tables and common headers; the dispatcher names one editor per goal. */
  shared: string[];
};

export type ModuleExpertsState = {
  /** Absolute path of the experts file. */
  file: string;
  /** The saved experts, or null when the project has none yet. */
  saved: ModuleExpertsFile | null;
  /** Feature card ids found in `.woody/features`. */
  cards: string[];
  /** Whether the business overview `.woody/business.md` exists. */
  business: boolean;
};

export type ExpertIssue = 'id' | 'idTaken' | 'name' | 'nameTaken' | 'summary' | 'paths';

export const MODULE_EXPERTS_FILE = 'experts.json';
/** The business overview the dispatcher (the meter business lead) keeps next to the experts file. */
export const BUSINESS_OVERVIEW_FILE = 'business.md';
export const MODULE_EXPERTS_LIMIT = 12;
/** The PowerShell plain reader on encrypted machines returns at most 64 KiB. */
export const MODULE_EXPERTS_MAX_BYTES = 64 * 1024;
const EXPERT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 40;
const SUMMARY_MAX = 400;
const PATHS_MAX = 60;

export function isExpertId(value: string): boolean {
  return value.length <= 40 && EXPERT_ID.test(value);
}

/** Forward slashes, no leading `./`; `dir/` keeps its trailing slash because it marks a folder. */
export function normalizeExpertPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '');
}

function isProjectPath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '..');
}

/** Split a typed list (one path per line, or separated by commas) into normalized paths. */
export function parseExpertPaths(text: string): string[] {
  const paths = text
    .split(/[\r\n,]+/)
    .map(normalizeExpertPath)
    .filter(Boolean);
  return [...new Set(paths)];
}

/** The first problem with an expert, checked against the other experts of the same file. */
export function expertIssue(expert: ModuleExpert, others: ModuleExpert[]): ExpertIssue | null {
  if (!isExpertId(expert.id)) return 'id';
  if (others.some((other) => other.id === expert.id)) return 'idTaken';
  const name = expert.name.trim();
  if (!name || name.length > NAME_MAX) return 'name';
  if (others.some((other) => other.name.trim() === name)) return 'nameTaken';
  const summary = expert.summary.trim();
  if (!summary || summary.length > SUMMARY_MAX) return 'summary';
  if (expert.paths.length === 0 || expert.paths.length > PATHS_MAX || !expert.paths.every(isProjectPath)) {
    return 'paths';
  }
  return null;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a list of strings`);
  }
  return value.map(normalizeExpertPath).filter(Boolean);
}

/** Check a parsed experts file and return it normalized; throws with the first problem found. */
export function validateExpertsFile(value: unknown): ModuleExpertsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The file must hold a JSON object');
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error('Unsupported version; expected 1');
  if (!Array.isArray(record.experts)) throw new Error('experts must be a list');
  if (record.experts.length > MODULE_EXPERTS_LIMIT) throw new Error(`At most ${MODULE_EXPERTS_LIMIT} experts`);
  const experts: ModuleExpert[] = [];
  for (const [index, item] of record.experts.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`experts[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const expert: ModuleExpert = {
      id: typeof raw.id === 'string' ? raw.id.trim() : '',
      name: typeof raw.name === 'string' ? raw.name.trim() : '',
      summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
      paths: [...new Set(stringList(raw.paths, `experts[${index}].paths`))],
    };
    const issue = expertIssue(expert, experts);
    if (issue) throw new Error(`experts[${index}] (${expert.id || 'no id'}): invalid ${issue}`);
    experts.push(expert);
  }
  const shared = [...new Set(stringList(record.shared, 'shared'))];
  if (shared.length > PATHS_MAX || !shared.every(isProjectPath)) throw new Error('shared holds an invalid path');
  return { version: 1, experts, shared };
}
