import { app } from 'electron';
import path from 'node:path';
import type { GitRuntimeStatus } from '@/common/types/sourceControl/workbenchTypes';
import { ProcessConfig } from '@process/utils/initStorage';
import { createGitExecutor, type GitExecutor } from '@process/services/sourceControl/workbench/executor';
import {
  GitResolutionError,
  createGitRuntimeResolver,
  type GitRuntime,
} from '@process/services/sourceControl/workbench/executor/runtime';
import { createRepositoryCoordinator } from '@process/services/sourceControl/workbench/coordinator';

export type GitBridgeRuntime = {
  runtime: GitRuntime;
  configuredPath: string;
  git: GitExecutor;
  coordinator: ReturnType<typeof createRepositoryCoordinator>;
};

const resourceRoot = (): string => (app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'));

export const bundledGitExecutable = (): string => path.join(resourceRoot(), 'third-party', 'git', 'cmd', 'git.exe');

let configuredAtStartup = '';
let pending: Promise<GitBridgeRuntime> | undefined;

/** Probe an explicit host path before it is stored; renderer input never reaches the resolver directly. */
export async function validateConfiguredGitPath(candidate: string): Promise<GitRuntime> {
  const configuredPath = candidate.trim();
  if (!configuredPath) throw new Error('Git executable path cannot be empty');
  return createGitRuntimeResolver({ configuredPath }).get();
}

/** Resolve and cache the one Git executable/coordinator shared by every native Git service. */
export function getGitBridgeRuntime(): Promise<GitBridgeRuntime> {
  if (pending) return pending;
  pending = (async () => {
    configuredAtStartup = ((await ProcessConfig.get('scm.gitPath')) ?? '').trim();
    const runtime = await createHostRuntimeResolver(configuredAtStartup).get();
    const git = createGitExecutor(runtime.executable, false);
    return {
      runtime,
      configuredPath: configuredAtStartup,
      git,
      coordinator: createRepositoryCoordinator(undefined, git),
    };
  })();
  return pending;
}

const createHostRuntimeResolver = (configuredPath: string) =>
  createGitRuntimeResolver({
    configuredPath: configuredPath || undefined,
    bundledExecutable: bundledGitExecutable(),
  });

export async function getGitRuntimeStatus(): Promise<GitRuntimeStatus> {
  const configuredPath = ((await ProcessConfig.get('scm.gitPath')) ?? '').trim();
  try {
    // The running services are intentionally cached until restart. Reading the
    // cached executable here keeps the status page honest about what is in use.
    const resolved = await getGitBridgeRuntime();
    return {
      configuredPath: resolved.configuredPath || undefined,
      available: true,
      executable: resolved.runtime.executable,
      source: resolved.runtime.source,
      version: resolved.runtime.version.raw,
      capabilities: resolved.runtime.capabilities,
    };
  } catch (error) {
    return {
      configuredPath: configuredPath || undefined,
      available: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof GitResolutionError ? { attempts: error.attempts } : {}),
    };
  }
}

/** Test hook only. Production resolves once per process to match the real Git services. */
export function resetGitBridgeRuntimeForTest(): void {
  pending = undefined;
  configuredAtStartup = '';
}
