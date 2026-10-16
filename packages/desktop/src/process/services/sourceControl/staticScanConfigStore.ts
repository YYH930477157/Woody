import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { StaticScanMachineConfig, StaticScanProjectConfig } from '@/common/types/sourceControl/staticScanTypes';

const MACHINE_CONFIG_FILE = 'static-scan-tools.json';
const PROJECT_CONFIG_FILE = '.woody/static-scan.json';

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
      return readJson(join(repoPath, PROJECT_CONFIG_FILE), {});
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
