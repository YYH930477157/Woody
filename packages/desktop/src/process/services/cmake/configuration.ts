import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CmakeConfiguration, CmakeTools } from '@/common/types/cmake';
import { isPrivateEnvironment, type ResolvedVariants } from './variants';

export function defaultConfiguration(): CmakeConfiguration {
  return {
    tools: { cmake: '', ctest: '', cCompiler: '', cxxCompiler: '', make: '' },
    selections: {},
    jobs: 2,
    target: '',
    runExecutable: '',
    runArguments: [],
    timeoutMs: 600000,
    require32Bit: true,
    gdbPath: '',
  };
}

/** Validate data coming from IPC, persisted JSON or MCP before using process arguments. */
export function normalizeConfiguration(input: CmakeConfiguration): CmakeConfiguration {
  if (!input || typeof input !== 'object') throw new Error('cmake.invalidConfiguration');
  const defaults = defaultConfiguration();
  const config = { ...defaults, ...input, tools: { ...defaults.tools, ...input.tools } };
  const validString = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 8192 && !value.includes('\0') && !/[\r\n]/.test(value);
  if (
    Object.keys(config).some((key) => !Object.hasOwn(defaults, key)) ||
    Object.keys(config.tools).some((key) => !Object.hasOwn(defaults.tools, key))
  )
    throw new Error('cmake.invalidConfiguration: unknown property');
  if (
    Object.values(config.tools).some((value) => !validString(value)) ||
    !validString(config.target) ||
    !validString(config.runExecutable) ||
    !validString(config.gdbPath)
  )
    throw new Error('cmake.invalidConfiguration: invalid path or target');
  if (config.target.startsWith('-')) throw new Error('cmake.invalidConfiguration: target cannot start with dash');
  if (!Number.isInteger(config.jobs) || config.jobs < 1 || config.jobs > 32)
    throw new Error('cmake.invalidConfiguration: jobs must be 1..32');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 86400000)
    throw new Error('cmake.invalidConfiguration: timeout must be 1000..86400000ms');
  if (
    typeof config.require32Bit !== 'boolean' ||
    !Array.isArray(config.runArguments) ||
    config.runArguments.length > 100 ||
    !config.runArguments.every(validString)
  )
    throw new Error('cmake.invalidConfiguration: process settings');
  if (
    !config.selections ||
    typeof config.selections !== 'object' ||
    Array.isArray(config.selections) ||
    Object.values(config.selections).some((value) => !validString(value))
  )
    throw new Error('cmake.invalidConfiguration: selections');
  return structuredClone(config);
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)])
    );
  return value;
}

export function configurationHash(
  config: CmakeConfiguration,
  resolved: ResolvedVariants,
  tools: CmakeTools = config.tools,
  toolIdentity: Record<string, string> = {}
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        sorted({ tools, toolIdentity, resolved, require32Bit: config.require32Bit, generator: 'MinGW Makefiles' })
      )
    )
    .digest('hex')
    .slice(0, 20);
}

/** Remove app-only credentials and prepend explicit tool directories for child processes. */
export function childEnvironment(
  base: NodeJS.ProcessEnv,
  additions: Record<string, string>,
  toolDirectories: string[]
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  let searchPath = '';
  for (const [key, value] of Object.entries({ ...base, ...additions })) {
    if (isPrivateEnvironment(key)) continue;
    if (key.toLowerCase() === 'path') searchPath = value ?? '';
    else result[key] = value;
  }
  result.PATH = [...new Set(toolDirectories.filter(Boolean)), searchPath].filter(Boolean).join(path.delimiter);
  return result;
}
