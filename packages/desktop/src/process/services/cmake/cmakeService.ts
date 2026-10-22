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
  CmakeToolCheck,
  CmakeWorkspace,
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
  discoverProjects,
  loadWorkspaceSelection,
  storeWorkspaceSelection,
  loadConfiguration,
  loadVariantConfiguration,
  loadProjectWorkspace,
  storeProjectWorkspace,
  projectKey,
  readBounded,
  storeConfiguration,
  validateExecutable,
  verifyArchitecture,
  ConfigurationReader,
  isInside,
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
  private readonly reader: ConfigurationReader;
  private readonly toolChecks = new Map<string, { settings: string; checks: CmakeToolCheck[] }>();

  constructor(
    private readonly storagePath: string,
    dependencies: Dependencies = {}
  ) {
    this.runner = dependencies.runner ?? runProcess;
    this.env = { ...(dependencies.env ?? process.env) };
    this.reader = new ConfigurationReader({ env: this.env });
    this.logLimit = Math.max(1024, Math.min(dependencies.maxLogChars ?? 1048576, 4194304));
    this.retention = Math.max(1, Math.min(dependencies.maxCompletedJobs ?? 40, 100));
  }

  private async project(
    root: string,
    selection?: Record<string, string>,
    override?: CmakeConfiguration,
    recoverSelections = false,
    allowInvalidVariants = false
  ): Promise<ProjectState> {
    const config = override ?? (await loadConfiguration(this.storagePath, root));
    const workspacePath = await loadProjectWorkspace(this.storagePath, root);
    const loaded = await loadVariantConfiguration(root, workspacePath, config.read, this.reader);
    const checked = this.toolChecks.get(projectKey(root));
    const toolChecks = checked?.settings === JSON.stringify(config.tools) ? structuredClone(checked.checks) : undefined;
    const dimensions = loaded.dimensions;
    const invalidSelections: string[] = [];
    if (!loaded.error && recoverSelections) {
      for (const [name, id] of Object.entries(config.selections)) {
        const dimension = dimensions.find((candidate) => candidate.name === name);
        if (!dimension?.choices.some((choice) => choice.id === id)) {
          invalidSelections.push(`${name}=${id}`);
          delete config.selections[name];
        }
      }
    }
    let variants: ResolvedVariants = { selection: {}, settings: {}, env: {} };
    if (!loaded.error) {
      try {
        variants = resolveVariants(dimensions, { ...config.selections, ...selection });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('cmake.variantConflict')) throw error;
        loaded.error = `${error.message}\n${loaded.file || workspacePath}`;
        loaded.diagnostic = { kind: 'conflict', message: error.message, file: loaded.file };
      }
    }
    if (loaded.error && !allowInvalidVariants) throw new Error(loaded.error);
    const lastId = this.latest.get(projectKey(root));
    const last = lastId ? this.jobs.get(lastId)?.job : undefined;
    if (loaded.error) {
      return {
        project: {
          projectPath: root,
          workspacePath,
          variantsFile: loaded.file,
          configurationError: loaded.error,
          diagnostic: loaded.diagnostic,
          readInfo: loaded.readInfo,
          toolChecks,
          config,
          dimensions,
          selection: Object.fromEntries(
            dimensions.map((dimension) => [
              dimension.name,
              config.selections[dimension.name] ?? dimension.defaultChoice,
            ])
          ),
          buildDirectory: '',
          ...(last ? { latestJob: structuredClone(last) } : {}),
        },
        variants: { selection: {}, settings: {}, env: {} },
        tools: config.tools,
        hash: '',
      };
    }
    // Inspection must retain settings even when a tool cannot be accessed; execution stays strict.
    const toolErrors: Partial<Record<keyof CmakeTools, string>> | undefined = allowInvalidVariants ? {} : undefined;
    const tools = await resolveTools(config.tools, childEnvironment(this.env, variants.env, []), toolErrors);
    const identities = await toolIdentity(tools, toolErrors);
    const failedChecks: CmakeToolCheck[] = Object.entries(toolErrors ?? {}).map(([name, error]) => ({
      name: name as keyof CmakeTools,
      path: tools[name as keyof CmakeTools],
      status: 'failed',
      error,
    }));
    const hash = failedChecks.length ? '' : configurationHash(config, variants, tools, identities);
    const build = hash ? await buildDirectory(root, hash) : '';
    return {
      project: {
        projectPath: root,
        workspacePath,
        variantsFile: loaded.file,
        readInfo: loaded.readInfo,
        toolChecks: failedChecks.length ? failedChecks : toolChecks,
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

  /** Discover a workspace and remember only a validated, explicitly selected source root. */
  async discover(workspacePath: string, selection?: string): Promise<CmakeWorkspace> {
    if (this.disposed) throw new Error('cmake.disposed');
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath) || workspacePath.includes('\0'))
      throw new Error('cmake.invalidProject');
    const workspace = await fs.realpath(workspacePath).catch(() => {
      throw new Error(`cmake.projectMissing: ${workspacePath}`);
    });
    const remembered = await loadWorkspaceSelection(this.storagePath, workspace);
    let settingsRoot = workspace;
    if (remembered) {
      const candidate = path.resolve(workspace, remembered);
      if (projectKey(candidate) === projectKey(workspace) || isInside(workspace, candidate)) {
        const canonical = await canonicalProject(candidate).catch((): undefined => undefined);
        if (canonical && (projectKey(canonical) === projectKey(workspace) || isInside(workspace, canonical)))
          settingsRoot = canonical;
      }
    }
    const readerSettings = (await loadConfiguration(this.storagePath, settingsRoot)).read;
    const found = await discoverProjects(workspace, this.reader, readerSettings);
    const selected = selection ?? remembered;
    const candidate = found.projects.find((entry) => entry.relativePath === selected);
    if (selection !== undefined) {
      if (!candidate) throw new Error('cmake.invalidProject');
      await storeWorkspaceSelection(this.storagePath, found.workspacePath, candidate.relativePath);
    }
    found.selectedProjectPath =
      candidate?.projectPath ?? (found.projects.length === 1 ? found.projects[0].projectPath : undefined);
    if (found.selectedProjectPath) {
      const source = found.selectedProjectPath;
      const key = projectKey(source);
      if (this.disposed) throw new Error('cmake.disposed');
      if (this.locks.has(key)) {
        const current = await loadProjectWorkspace(this.storagePath, source);
        if (projectKey(current) !== projectKey(found.workspacePath)) throw new Error('cmake.busy');
      } else {
        this.locks.add(key);
        try {
          await storeProjectWorkspace(this.storagePath, source, found.workspacePath);
          await storeWorkspaceSelection(
            this.storagePath,
            found.workspacePath,
            found.projects.find((entry) => entry.projectPath === source)!.relativePath
          );
        } finally {
          this.locks.delete(key);
        }
      }
    }
    return found;
  }

  /** Inspect settings, variants and the latest operation without launching tools. */
  async inspect(projectPath: string, discover = false): Promise<CmakeProject> {
    if (this.disposed) throw new Error('cmake.disposed');
    let root: string;
    if (discover) {
      const found = await this.discover(projectPath);
      if (!found.projects.length) throw new Error(`cmake.projectMissing: ${found.workspacePath}`);
      if (!found.selectedProjectPath)
        throw new Error(`cmake.ambiguousProject: ${found.projects.map((entry) => entry.relativePath).join(', ')}`);
      root = found.selectedProjectPath;
    } else root = await canonicalProject(projectPath);
    return (await this.project(root, undefined, undefined, true, true)).project;
  }

  /** Refresh project diagnostics without discarding the caller's unsaved form fields. */
  async reload(projectPath: string): Promise<CmakeProject> {
    const root = await canonicalProject(projectPath);
    if (this.disposed) throw new Error('cmake.disposed');
    if (this.locks.has(projectKey(root))) throw new Error('cmake.busy');
    this.reader.clear();
    return this.inspect(root);
  }

  /** Reveal only the selected configuration within the canonical workspace. */
  async configurationPath(projectPath: string): Promise<string> {
    const project = await this.inspect(projectPath);
    if (!project.variantsFile) throw new Error('cmake.configurationMissing');
    const file = await fs.realpath(project.variantsFile);
    const workspace = project.workspacePath || project.projectPath;
    if (!isInside(workspace, file) || !(await fs.stat(file)).isFile()) throw new Error('cmake.invalidProject');
    return file;
  }

  /** Save validated settings outside the source tree. */
  async save(projectPath: string, config: CmakeConfiguration): Promise<CmakeProject> {
    const root = await canonicalProject(projectPath);
    const key = projectKey(root);
    if (this.disposed) throw new Error('cmake.disposed');
    if (this.locks.has(key)) throw new Error('cmake.busy');
    this.locks.add(key);
    try {
      const normalized = normalizeConfiguration(config);
      const old = await loadConfiguration(this.storagePath, root);
      const readerChanged = JSON.stringify(old.read) !== JSON.stringify(normalized.read);
      if (readerChanged) this.reader.clear();
      const next = await this.project(root, undefined, normalized, readerChanged, true);
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
      // Tool inspection deliberately avoids variants and CMakeLists contents.
      const context = action === 'check' ? await this.toolContext(root) : await this.project(root, selection);
      if (this.disposed) throw new Error('cmake.disposed');
      if (action === 'check') this.toolChecks.delete(key);
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
          // Retained jobs keep only the readable part of their log.
          this.compact(state);
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
    // Expose only the newest logLimit characters while a batched trim is pending.
    const start = Math.max(state.offset, end - this.logLimit);
    return {
      job: structuredClone(state.job),
      output: state.output.slice(Math.max(cursor, start) - state.offset),
      cursor: end,
      truncated: cursor < start,
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
    const readersStopped = this.reader.dispose();
    const active = [...this.jobs.values()];
    active.forEach((state) => {
      if (state.job.status === 'running') state.controller.abort();
    });
    await Promise.all([readersStopped, ...active.map((state) => state.completion)]);
  }

  private async toolContext(root: string): Promise<ProjectState> {
    const config = await loadConfiguration(this.storagePath, root);
    return {
      project: { projectPath: root, config, dimensions: [], selection: {}, buildDirectory: '' },
      variants: { selection: {}, settings: {}, env: {} },
      tools: config.tools,
      hash: '',
    };
  }

  private async checkInstalledTools(state: JobState, context: ProjectState): Promise<void> {
    const { config, projectPath } = context.project;
    const checks: CmakeToolCheck[] = [];
    state.job.toolChecks = checks;
    const env = childEnvironment(this.env, {}, []);
    const problems: Partial<Record<keyof CmakeTools, string>> = {};
    const resolved = await resolveTools(config.tools, env, problems);
    const deadline = Date.now() + Math.min(config.timeoutMs, 60000);
    for (const name of Object.keys(config.tools) as (keyof CmakeTools)[]) {
      if (state.controller.signal.aborted) throw new Error('cmake.cancelled');
      if (Date.now() >= deadline) throw new Error('cmake.timeout');
      const entry: CmakeToolCheck = { name, path: config.tools[name], status: 'failed' };
      checks.push(entry);
      try {
        entry.path = resolved[name];
        if (problems[name]) throw new Error(problems[name]);
        await requireTools({ ...config.tools, [name]: entry.path }, [name]);
        entry.status = 'failed';
        const result = await this.runner({
          executable: entry.path,
          args: ['--version'],
          cwd: projectPath,
          env: childEnvironment(env, {}, [path.dirname(entry.path)]),
          timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())),
          signal: state.controller.signal,
          onOutput: (text) => this.append(state, text),
        });
        if (state.controller.signal.aborted) throw new Error('cmake.cancelled');
        if (result.code !== 0) throw new Error(`cmake.processExit: ${name} exit ${result.code}`);
        if (name === 'cmake') {
          const version = /cmake version\s+(\d+)\.(\d+)/i.exec(result.output);
          if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 5))
            throw new Error('cmake.version');
        }
        entry.status = 'found';
        entry.version = result.output
          .split(/[\r\n]/)
          .find((line) => line.trim())
          ?.slice(0, 240);
      } catch (error) {
        if (state.controller.signal.aborted) throw error;
        entry.error = error instanceof Error ? error.message : 'cmake.failed';
        if (entry.error.startsWith('cmake.toolNotFound:')) entry.status = 'missing';
      }
      this.append(state, `\n${name}: ${entry.path || '-'} [${entry.status}]${entry.error ? ` ${entry.error}` : ''}\n`);
    }
    this.toolChecks.set(projectKey(projectPath), {
      settings: JSON.stringify(config.tools),
      checks: structuredClone(checks),
    });
    if (checks.some((tool) => tool.status !== 'found')) throw new Error('cmake.toolsIncomplete');
    state.job.status = 'succeeded';
  }

  /** Trim in batches: slicing the capped log for every line would copy all of it once per line. */
  private append(state: JobState, output: string): void {
    state.output += output;
    if (state.output.length > this.logLimit * 2) this.compact(state);
  }

  private compact(state: JobState): void {
    const removed = Math.max(0, state.output.length - this.logLimit);
    if (!removed) return;
    state.output = state.output.slice(removed);
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
    if (state.job.action === 'check') return this.checkInstalledTools(state, context);
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
      const lists = (
        await this.reader.read(path.join(project.projectPath, 'CMakeLists.txt'), config.read, 1048576)
      ).text.replace(/#[^\n]*/g, '');
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
      await fs.rm(marker, { force: true });
      await invoke(configureCommand(project.projectPath, config, variants, tools));
      await fs.writeFile(marker, JSON.stringify({ hash }));
      if (state.job.action === 'build') await invoke(buildCommand(config, tools));
    }
    assertActive();
    state.job.status = 'succeeded';
  }
}
