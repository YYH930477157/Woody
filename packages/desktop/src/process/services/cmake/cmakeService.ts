import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CmakeAction,
  CmakeConfiguration,
  CmakeJob,
  CmakeJobRead,
  CmakeProject,
  CmakeTools,
} from '@/common/types/cmake';
import { childEnvironment, configurationHash, normalizeConfiguration } from './configuration';
import { buildCommand, configureCommand, type CmakeCommand } from './commands';
import { runProcess, type ProcessRunner } from './processRunner';
import { resolveVariants, type ResolvedVariants } from './variants';
import { requireTools, resolveTools, toolIdentity } from './toolchain';
import { resolveGdb } from './gdb/toolchain';
import type { DebugTarget } from './gdb';
import {
  buildDirectory,
  canonicalProject,
  loadConfiguration,
  loadDimensions,
  projectKey,
  readBounded,
  storeConfiguration,
  validateExecutable,
  verifyArchitecture,
} from './workspace';

type Dependencies = {
  runner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  maxLogChars?: number;
  maxCompletedJobs?: number;
};
type JobState = {
  job: CmakeJob;
  output: string;
  offset: number;
  controller: AbortController;
  completion: Promise<void>;
};
type ProjectState = { project: CmakeProject; variants: ResolvedVariants; tools: CmakeTools; hash: string };

/** Shared desktop/agent CMake operations with one active operation per canonical project. */
export class CmakeService {
  private readonly runner: ProcessRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly jobs = new Map<string, JobState>();
  private readonly locks = new Set<string>();
  private readonly latest = new Map<string, string>();
  private readonly logLimit: number;
  private readonly retention: number;
  private disposed = false;

  constructor(
    private readonly storagePath: string,
    dependencies: Dependencies = {}
  ) {
    this.runner = dependencies.runner ?? runProcess;
    this.env = { ...(dependencies.env ?? process.env) };
    this.logLimit = Math.max(1024, Math.min(dependencies.maxLogChars ?? 1048576, 4194304));
    this.retention = Math.max(1, Math.min(dependencies.maxCompletedJobs ?? 40, 100));
  }

  private async project(
    root: string,
    selection?: Record<string, string>,
    override?: CmakeConfiguration,
    recoverSelections = false
  ): Promise<ProjectState> {
    const config = override ?? (await loadConfiguration(this.storagePath, root));
    const dimensions = await loadDimensions(root);
    const invalidSelections: string[] = [];
    if (recoverSelections) {
      for (const [name, id] of Object.entries(config.selections)) {
        const dimension = dimensions.find((candidate) => candidate.name === name);
        if (!dimension?.choices.some((choice) => choice.id === id)) {
          invalidSelections.push(`${name}=${id}`);
          delete config.selections[name];
        }
      }
    }
    const variants = resolveVariants(dimensions, { ...config.selections, ...selection });
    const tools = await resolveTools(config.tools, childEnvironment(this.env, variants.env, []));
    const hash = configurationHash(config, variants, tools, await toolIdentity(tools));
    const build = await buildDirectory(root, hash);
    const lastId = this.latest.get(projectKey(root));
    const last = lastId ? this.jobs.get(lastId)?.job : undefined;
    return {
      project: {
        projectPath: root,
        config,
        dimensions,
        selection: variants.selection,
        buildDirectory: build,
        ...(last ? { latestJob: structuredClone(last) } : {}),
        ...(invalidSelections.length ? { invalidSelections } : {}),
      },
      variants,
      tools,
      hash,
    };
  }

  /** Inspect settings, variants and the latest operation without launching tools. */
  async inspect(projectPath: string): Promise<CmakeProject> {
    return (await this.project(await canonicalProject(projectPath), undefined, undefined, true)).project;
  }

  /** Save validated settings outside the source tree. */
  async save(projectPath: string, config: CmakeConfiguration): Promise<CmakeProject> {
    const root = await canonicalProject(projectPath);
    const key = projectKey(root);
    if (this.disposed) throw new Error('cmake.disposed');
    if (this.locks.has(key)) throw new Error('cmake.busy');
    this.locks.add(key);
    try {
      const next = await this.project(root, undefined, normalizeConfiguration(config));
      await storeConfiguration(this.storagePath, root, next.project.config);
      return next.project;
    } finally {
      this.locks.delete(key);
    }
  }

  /** Hold the build lock until GDB and its inferior have both stopped. */
  async acquireDebugTarget(projectPath: string): Promise<DebugTarget> {
    const root = await canonicalProject(projectPath);
    const key = projectKey(root);
    if (this.disposed) throw new Error('cmake.disposed');
    if (this.locks.has(key)) throw new Error('cmake.busy');
    this.locks.add(key);
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        this.locks.delete(key);
      }
    };
    try {
      const { project, tools, variants, hash } = await this.project(root);
      const { config, buildDirectory: build } = project;
      try {
        if (
          JSON.parse(await readBounded(path.join(build, '.woody-configured.json'))).hash !== hash ||
          !(await fs.stat(path.join(build, 'CMakeCache.txt'))).isFile()
        )
          throw new Error('missing');
      } catch {
        throw new Error('cmake.notConfigured');
      }
      const executable = await validateExecutable(build, config.runExecutable, config.require32Bit);
      const env = childEnvironment(
        this.env,
        variants.env,
        Object.values(tools)
          .filter(Boolean)
          .map((file) => path.dirname(file))
      );
      const gdbPath = await resolveGdb(config.gdbPath ?? '', tools.cCompiler, env);
      if (this.disposed) throw new Error('cmake.disposed');
      return {
        projectPath: root,
        buildDirectory: build,
        executable,
        args: [...config.runArguments],
        gdbPath,
        env: childEnvironment(env, {}, [
          ...(tools.cCompiler ? [path.dirname(tools.cCompiler)] : []),
          path.dirname(gdbPath),
        ]),
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Start asynchronously and return an operation id for incremental reads. */
  async start(projectPath: string, action: CmakeAction, selection?: Record<string, string>): Promise<CmakeJob> {
    if (!['check', 'configure', 'build', 'test', 'run'].includes(action)) throw new Error('cmake.invalidAction');
    const root = await canonicalProject(projectPath);
    const key = projectKey(root);
    if (this.disposed) throw new Error('cmake.disposed');
    if (this.locks.has(key)) throw new Error('cmake.busy');
    this.locks.add(key);
    try {
      const context = await this.project(root, selection);
      if (this.disposed) throw new Error('cmake.disposed');
      const job: CmakeJob = {
        id: randomUUID(),
        projectPath: root,
        action,
        status: 'running',
        startedAt: new Date().toISOString(),
        buildDirectory: context.project.buildDirectory,
        selection: { ...context.project.selection },
      };
      const state: JobState = {
        job,
        output: '',
        offset: 0,
        controller: new AbortController(),
        completion: Promise.resolve(),
      };
      this.jobs.set(job.id, state);
      this.latest.set(key, job.id);
      state.completion = this.execute(state, context)
        .catch((error: unknown) => {
          job.status = state.controller.signal.aborted ? 'cancelled' : 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          this.append(state, `\n${job.error}\n`);
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          this.locks.delete(key);
          this.trimJobs();
        });
      return structuredClone(job);
    } catch (error) {
      this.locks.delete(key);
      throw error;
    }
  }

  /** Read bounded output using absolute character cursors. */
  read(jobId: string, cursor = 0): CmakeJobRead {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error('cmake.jobNotFound');
    const end = state.offset + state.output.length;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > end) throw new Error('cmake.invalidCursor');
    return {
      job: structuredClone(state.job),
      output: state.output.slice(Math.max(0, cursor - state.offset)),
      cursor: end,
      truncated: cursor < state.offset,
    };
  }

  /** Cancel and wait for the current process tree to exit before unlocking. */
  async cancel(jobId: string): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) throw new Error('cmake.jobNotFound');
    if (state.job.status === 'running') state.controller.abort();
    await state.completion;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const active = [...this.jobs.values()];
    active.forEach((state) => {
      if (state.job.status === 'running') state.controller.abort();
    });
    await Promise.all(active.map((state) => state.completion));
  }

  private append(state: JobState, output: string): void {
    const combined = state.output + output;
    const removed = Math.max(0, combined.length - this.logLimit);
    state.output = combined.slice(removed);
    state.offset += removed;
  }

  private trimJobs(): void {
    const completed = [...this.jobs.values()].filter((state) => state.job.status !== 'running');
    for (const state of completed.slice(0, Math.max(0, completed.length - this.retention))) {
      this.jobs.delete(state.job.id);
      const key = projectKey(state.job.projectPath);
      if (this.latest.get(key) === state.job.id) this.latest.delete(key);
    }
  }

  private async execute(state: JobState, context: ProjectState): Promise<void> {
    const { project, tools, variants, hash } = context;
    const { config } = project;
    const signal = state.controller.signal;
    const deadline = Date.now() + config.timeoutMs;
    const env = childEnvironment(
      this.env,
      variants.env,
      Object.values(tools)
        .filter(Boolean)
        .map((file) => path.dirname(file))
    );
    const assertActive = (): void => {
      if (signal.aborted) throw new Error('cmake.cancelled');
      if (Date.now() >= deadline) throw new Error('cmake.timeout');
    };
    const invoke = async (command: CmakeCommand, cwd = project.buildDirectory): Promise<string> => {
      assertActive();
      await buildDirectory(project.projectPath, hash);
      this.append(state, `\n> ${JSON.stringify([command.executable, ...command.args])}\n`);
      const result = await this.runner({
        ...command,
        cwd,
        env,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal,
        onOutput: (text) => this.append(state, text),
      });
      assertActive();
      if (result.code !== 0)
        throw new Error(
          `cmake.processExit: ${path.basename(command.executable)} exit ${result.code}\n${result.output.slice(-4096)}`
        );
      return result.output;
    };
    assertActive();
    const marker = path.join(project.buildDirectory, '.woody-configured.json');
    if (['test', 'run'].includes(state.job.action)) {
      try {
        if (JSON.parse(await readBounded(marker)).hash !== hash) throw new Error('mismatch');
        if (!(await fs.stat(path.join(project.buildDirectory, 'CMakeCache.txt'))).isFile()) throw new Error('missing');
      } catch {
        throw new Error('cmake.notConfigured');
      }
      if (state.job.action === 'test') {
        await requireTools(tools, ['ctest']);
        const list = await invoke({ executable: tools.ctest, args: ['-N'] });
        const count = /Total Tests:\s*(\d+)/i.exec(list);
        if (!count || Number(count[1]) === 0) throw new Error('cmake.noTests');
        await invoke({ executable: tools.ctest, args: ['--output-on-failure', '-j', String(config.jobs)] });
      } else {
        const executable = await validateExecutable(project.buildDirectory, config.runExecutable, config.require32Bit);
        await invoke({ executable, args: config.runArguments });
      }
    } else {
      await buildDirectory(project.projectPath, hash, true);
      const lists = (await readBounded(path.join(project.projectPath, 'CMakeLists.txt'), 1048576)).replace(
        /#[^\n]*/g,
        ''
      );
      const declaration = /\bproject\s*\(([^)]*)\)/i.exec(lists)?.[1]?.split(/\s+/).filter(Boolean).slice(1) ?? [];
      const explicitLanguage = declaration.some((token) => ['C', 'CXX', 'NONE'].includes(token));
      const c = !explicitLanguage || declaration.includes('C');
      const cxx = !explicitLanguage || declaration.includes('CXX');
      await requireTools(tools, [
        'cmake',
        'ctest',
        'make',
        ...(c ? ['cCompiler' as const] : []),
        ...(cxx ? ['cxxCompiler' as const] : []),
      ]);
      const version = await invoke({ executable: tools.cmake, args: ['--version'] });
      const match = /cmake version\s+(\d+)\.(\d+)/i.exec(version);
      if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 5))
        throw new Error('cmake.version: CMake >= 3.5 required');
      for (const name of [
        'ctest',
        'make',
        ...(c ? ['cCompiler'] : []),
        ...(cxx ? ['cxxCompiler'] : []),
      ] as (keyof CmakeTools)[])
        await invoke({ executable: tools[name], args: ['--version'] });
      const probe = path.join(project.buildDirectory, `.woody-probe-${state.job.id}`);
      await fs.mkdir(probe);
      try {
        for (const [compiler, extension] of [
          [tools.cCompiler, 'c'],
          [tools.cxxCompiler, 'cpp'],
        ]) {
          if ((extension === 'c' && !c) || (extension === 'cpp' && !cxx)) continue;
          assertActive();
          const source = path.join(probe, `probe.${extension}`);
          const output = path.join(probe, `${extension}.exe`);
          await fs.writeFile(source, 'int main(void) { return 0; }\n');
          await invoke({
            executable: compiler,
            args: [...(config.require32Bit ? ['-m32'] : []), source, '-o', output],
          });
          await verifyArchitecture(output, config.require32Bit);
          this.append(state, `\n${extension}: ${config.require32Bit ? 'Win32 -m32' : 'Windows'} link probe passed\n`);
        }
      } finally {
        await fs.rm(probe, { recursive: true, force: true });
      }
      if (state.job.action !== 'check') {
        await fs.rm(marker, { force: true });
        await invoke(configureCommand(project.projectPath, config, variants, tools));
        await fs.writeFile(marker, JSON.stringify({ hash }));
        if (state.job.action === 'build') await invoke(buildCommand(config, tools));
      }
    }
    assertActive();
    state.job.status = 'succeeded';
  }
}
