import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { GitWorkflowCompileResult } from '@/common/types/sourceControl/gitWorkflowTypes';
import type { StaticScanProjectConfig } from '@/common/types/sourceControl/staticScanTypes';
import { runStaticScanCommand, type StaticScanCommandRunner } from './staticScanService';

type BuildStep = { executable: string; args: string[]; cwd: string; timeoutMs: number };
type BuildConfig = NonNullable<StaticScanProjectConfig['build']>;

const insideRepository = (repoPath: string, path: string): string => {
  const target = resolve(repoPath, path);
  const rel = relative(repoPath, target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error('Build paths must be inside the repository');
  }
  return target;
};

const discoverProjects = async (repoPath: string): Promise<{ iar: string[]; cmake: string[] }> => {
  const result = { iar: [] as string[], cmake: [] as string[] };
  const excluded = new Set(['.git', '.woody', 'node_modules', 'vendor', 'out', 'dist', 'target', 'build']);
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(resolve(repoPath, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isFile()) {
        if (/\.ewp$/i.test(entry.name)) result.iar.push(rel);
        if (entry.name === 'CMakeLists.txt') result.cmake.push(dir || '.');
      } else if (entry.isDirectory() && depth < 6 && !excluded.has(entry.name)) {
        await visit(rel, depth + 1);
      }
    }
  };
  await visit('', 0);
  // Nested CMakeLists belong to the root project when one exists.
  if (result.cmake.includes('.')) result.cmake = ['.'];
  return result;
};

const planBuild = async (repoPath: string, config: BuildConfig): Promise<BuildStep[] | GitWorkflowCompileResult> => {
  if (config.system !== undefined && config.system !== 'iar' && config.system !== 'cmake') {
    throw new Error('Invalid build system');
  }
  for (const key of ['executable', 'cwd', 'project', 'configuration', 'buildDirectory'] as const) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key]!.trim())) {
      throw new Error(`Invalid build field: ${key}`);
    }
  }
  const cwd = insideRepository(repoPath, config.cwd ?? '.');
  const timeoutMs = config.timeoutMs ?? 600_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3_600_000) {
    throw new Error('Invalid build timeout');
  }
  if (config.executable) {
    if (
      typeof config.executable !== 'string' ||
      !Array.isArray(config.arguments ?? []) ||
      !(config.arguments ?? []).every((arg) => typeof arg === 'string')
    )
      throw new Error('Invalid build command');
    return [{ executable: config.executable, args: config.arguments ?? [], cwd, timeoutMs }];
  }
  const projects = await discoverProjects(repoPath);
  if (!config.system && projects.iar.length && projects.cmake.length) {
    return { ok: false, reasonCode: 'buildAmbiguous' };
  }
  const system = config.system ?? (projects.iar.length ? 'iar' : projects.cmake.length ? 'cmake' : undefined);
  if (!system) return { ok: false, reasonCode: 'buildConfigRequired' };
  const candidates = system === 'iar' ? projects.iar : projects.cmake;
  if (!config.project && candidates.length !== 1) {
    return { ok: false, reasonCode: candidates.length ? 'buildAmbiguous' : 'buildConfigRequired' };
  }
  const project = insideRepository(repoPath, config.project ?? candidates[0]);
  if (system === 'iar') {
    return [
      {
        executable: 'IarBuild',
        args: [project, '-build', config.configuration ?? '*'],
        cwd,
        timeoutMs,
      },
    ];
  }
  const buildDirectory = insideRepository(repoPath, config.buildDirectory ?? 'build');
  return [
    {
      executable: 'cmake',
      args: [
        '-S',
        project,
        '-B',
        buildDirectory,
        ...(config.configuration ? [`-DCMAKE_BUILD_TYPE=${config.configuration}`] : []),
      ],
      cwd,
      timeoutMs,
    },
    {
      executable: 'cmake',
      args: ['--build', buildDirectory, ...(config.configuration ? ['--config', config.configuration] : [])],
      cwd,
      timeoutMs,
    },
  ];
};

/** Compile the original project; a missing or ambiguous build never counts as success. */
export const createProjectBuildService = (runner: StaticScanCommandRunner = runStaticScanCommand) => ({
  async compile({ repoPath }: { repoPath: string }): Promise<GitWorkflowCompileResult> {
    const result: GitWorkflowCompileResult = { ok: false, stdout: '', stderr: '', commands: [] };
    try {
      let projectConfig: StaticScanProjectConfig = {};
      try {
        projectConfig = JSON.parse(
          await readFile(resolve(repoPath, '.woody/static-scan.json'), 'utf8')
        ) as StaticScanProjectConfig;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const plan = await planBuild(repoPath, projectConfig.build ?? {});
      if (!Array.isArray(plan)) return plan;
      for (const step of plan) {
        result.commands!.push(JSON.stringify([step.executable, ...step.args]));
        const output = await runner(step.executable, step.args, step);
        result.stdout += output.stdout;
        result.stderr += output.stderr;
        if (output.exitCode !== 0 || output.timedOut || output.executableMissing) {
          return { ...result, reasonCode: 'buildFailed' };
        }
      }
      return { ...result, ok: true };
    } catch (error) {
      return { ...result, reasonCode: 'buildFailed', stderr: error instanceof Error ? error.message : String(error) };
    }
  },
});
