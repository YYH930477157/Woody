import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defaultCommitChecks,
  sameCommitChecks,
  type CommitCheckOptions,
  type StaticScanMachineConfig,
  type StaticScanProjectConfig,
} from '@/common/types/sourceControl/staticScanTypes';

const MACHINE_CONFIG_FILE = 'static-scan-tools.json';
const PROJECT_CONFIG_FILE = '.woody/static-scan.json';

const validateChecks = (value: unknown): void => {
  const checks = value as CommitCheckOptions | null;
  if (
    !checks ||
    !Array.isArray(checks.scanners) ||
    checks.scanners.some((tool) => tool !== 'clang-tidy' && tool !== 'pc-lint') ||
    new Set(checks.scanners).size !== checks.scanners.length ||
    typeof checks.compile !== 'boolean' ||
    typeof checks.autoRepair !== 'boolean'
  ) {
    throw new Error('Invalid commitChecks in .woody/static-scan.json');
  }
};

/**
 * Read a repository's `.woody/static-scan.json`; a missing file is an empty config.
 * Throws on unreadable or invalid JSON instead of falling back to defaults.
 */
export const readProjectConfig = async (repoPath: string): Promise<StaticScanProjectConfig> => {
  let contents: string;
  try {
    contents = await readFile(join(repoPath, PROJECT_CONFIG_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  // Windows editors and PowerShell 5.1 may save UTF-8 with a byte order mark, which JSON.parse rejects.
  const config: unknown = JSON.parse(contents.replace(/^\uFEFF/, ''));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Expected an object in .woody/static-scan.json');
  }
  if ('commitChecks' in config) validateChecks(config.commitChecks);
  return config as StaticScanProjectConfig;
};

const readJson = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

export type StaticScanConfigStore = {
  getMachineConfig: () => StaticScanMachineConfig;
  saveMachineConfig: (config: StaticScanMachineConfig) => Promise<void>;
  getProjectConfig: (repoPath: string) => Promise<StaticScanProjectConfig>;
  saveProjectConfig: (repoPath: string, config: StaticScanProjectConfig) => Promise<void>;
  saveCommitChecks: (repoPath: string, checks: CommitCheckOptions) => Promise<StaticScanProjectConfig>;
};

export const createStaticScanConfigStore = (userDataPath: string): StaticScanConfigStore => {
  const machinePath = join(userDataPath, MACHINE_CONFIG_FILE);
  let machineConfig: StaticScanMachineConfig = { tools: {} };
  try {
    machineConfig = JSON.parse(readFileSync(machinePath, 'utf8')) as StaticScanMachineConfig;
  } catch {
    // A missing or malformed machine config is treated as an unconfigured scanner.
  }

  return {
    getMachineConfig: () => machineConfig,
    async saveMachineConfig(config) {
      machineConfig = config;
      await mkdir(userDataPath, { recursive: true });
      await writeFile(machinePath, JSON.stringify(config, null, 2), 'utf8');
    },
    async getProjectConfig(repoPath) {
      return readProjectConfig(repoPath);
    },
    async saveCommitChecks(repoPath, checks) {
      validateChecks(checks);
      const config = await readProjectConfig(repoPath);
      // Unchanged choices, including untouched defaults, leave the repository as it is.
      if (sameCommitChecks(config.commitChecks ?? defaultCommitChecks(config), checks)) return config;
      // Merge the current file, not the renderer's possibly stale configuration.
      const updated = { ...config, commitChecks: checks };
      const path = join(repoPath, PROJECT_CONFIG_FILE);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await mkdir(join(repoPath, '.woody'), { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      return updated;
    },
    async saveProjectConfig(repoPath, config) {
      const path = join(repoPath, PROJECT_CONFIG_FILE);
      await mkdir(join(repoPath, '.woody'), { recursive: true });
      await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
    },
  };
};

export const loadMachineConfig = async (userDataPath: string): Promise<StaticScanMachineConfig> =>
  readJson(join(userDataPath, MACHINE_CONFIG_FILE), { tools: {} });
