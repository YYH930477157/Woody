import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CmakeService } from '../../../packages/desktop/src/process/services/cmake/cmakeService';
import type { ProcessRequest, ProcessRunner } from '../../../packages/desktop/src/process/services/cmake/processRunner';
import type { CmakeJobRead } from '../../../packages/desktop/src/common/types/cmake';

let root: string;
let project: string;
let storage: string;
let toolsDir: string;
const services: CmakeService[] = [];

async function pe(file: string, machine = 0x14c): Promise<void> {
  const buffer = Buffer.alloc(256);
  buffer.write('MZ');
  buffer.writeUInt32LE(128, 60);
  buffer.write('PE\0\0', 128);
  buffer.writeUInt16LE(machine, 132);
  await fs.writeFile(file, buffer);
}

const normalRunner: ProcessRunner = async (request) => {
  const args = request.args;
  let output = '';
  if (args.includes('--version'))
    output = request.executable.includes('cmake') ? 'cmake version 3.5.0' : 'GNU tool 8.1';
  if (args.includes('-o')) await pe(args[args.indexOf('-o') + 1]);
  if (args.includes('-G')) await fs.writeFile(path.join(request.cwd, 'CMakeCache.txt'), 'configured');
  if (args.includes('-N')) output = 'Total Tests: 2';
  request.onOutput(output);
  return { code: 0, output };
};

async function service(
  runner: ProcessRunner = normalRunner,
  options: { maxLogChars?: number; maxCompletedJobs?: number } = {}
): Promise<CmakeService> {
  const instance = new CmakeService(storage, {
    runner,
    env: { PATH: toolsDir, AIONUI_BACKEND_TOKEN: 'secret' },
    ...options,
  });
  services.push(instance);
  return instance;
}

async function finish(instance: CmakeService, id: string): Promise<CmakeJobRead> {
  for (let i = 0; i < 100; i++) {
    const read = instance.read(id);
    if (read.job.status !== 'running') return read;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('job did not finish');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-cmake-'));
  project = path.join(root, 'project with spaces');
  storage = path.join(root, 'settings');
  toolsDir = path.join(root, 'tool bin');
  await fs.mkdir(project);
  await fs.mkdir(toolsDir);
  await fs.writeFile(
    path.join(project, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.5)\nproject(test LANGUAGES C CXX)'
  );
  for (const name of ['cmake', 'ctest', 'gcc', 'g++', 'mingw32-make'])
    await fs.writeFile(path.join(toolsDir, `${name}.exe`), 'fake');
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((instance) => instance.dispose()));
  await fs.rm(root, { recursive: true, force: true });
});

describe('CMake workbench service', () => {
  it('uses workspace variants for actual configure arguments after selecting a nested source', async () => {
    const calls: ProcessRequest[] = [];
    const instance = await service(async (request) => {
      calls.push(request);
      return normalRunner(request);
    });
    await fs.writeFile(
      path.join(root, 'cmake-variants.json'),
      JSON.stringify({
        meter: { choices: { unit: { settings: { UNIT_TEST: true, METER: '3P4W_CT' } } } },
      })
    );
    await instance.discover(root);
    const job = await instance.start(project, 'build');
    expect((await finish(instance, job.id)).job.status).toBe('succeeded');
    const configure = calls.find((call) => call.args.includes('-G'))!;
    expect(configure.args).toContain('-DUNIT_TEST=ON');
    expect(configure.args).toContain('-DMETER=3P4W_CT');
  });
  it('configures and builds the source root discovered inside a workspace', async () => {
    const calls: ProcessRequest[] = [];
    const instance = await service(async (request) => {
      calls.push(request);
      return normalRunner(request);
    });
    const found = await instance.inspect(root, true);
    const job = await instance.start(found.projectPath, 'build');
    expect((await finish(instance, job.id)).job.status).toBe('succeeded');
    expect(calls.find((call) => call.args.includes('-G'))?.args.at(-1)).toBe(await fs.realpath(project));
    expect(job.buildDirectory.startsWith(path.join(found.projectPath, 'build'))).toBe(true);
  });
  it('leases the configured executable for debugging and excludes GDB settings from build identity', async () => {
    const instance = await service();
    const initial = await instance.inspect(project);
    const debuggerDir = path.join(root, 'debugger bin');
    await fs.mkdir(debuggerDir);
    const gdbPath = path.join(debuggerDir, 'gdb.exe');
    await fs.writeFile(gdbPath, 'fake');
    const saved = await instance.save(project, { ...initial.config, gdbPath, runExecutable: 'meter.exe' });
    expect(saved.buildDirectory).toBe(initial.buildDirectory);
    await finish(instance, (await instance.start(project, 'configure')).id);
    await pe(path.join(saved.buildDirectory, 'meter.exe'));
    const target = await instance.acquireDebugTarget(project);
    await expect(instance.start(project, 'build')).rejects.toThrow('cmake.busy');
    await expect(instance.save(project, saved.config)).rejects.toThrow('cmake.busy');
    expect(target.gdbPath).toBe(await fs.realpath(gdbPath));
    expect(target.env.AIONUI_BACKEND_TOKEN).toBeUndefined();
    expect(target.env.PATH?.split(path.delimiter)[0]).toBe(await fs.realpath(toolsDir));
    target.release();
    target.release();
    await expect(instance.save(project, saved.config)).resolves.toBeDefined();
  });
  it('releases a failed debug acquisition and refuses unconfigured variants', async () => {
    const instance = await service();
    await expect(instance.acquireDebugTarget(project)).rejects.toThrow('cmake.notConfigured');
    await expect(instance.save(project, (await instance.inspect(project)).config)).resolves.toBeDefined();
  });

  it('allows reopening the same workspace during a running build but rejects rebinding it', async () => {
    const instance = await service(
      async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('cmake.cancelled')), { once: true });
          if (request.signal.aborted) reject(new Error('cmake.cancelled'));
        })
    );
    await instance.discover(root);
    const job = await instance.start(project, 'check');
    try {
      expect((await instance.discover(root)).selectedProjectPath).toBe(await fs.realpath(project));
      expect((await instance.inspect(project)).latestJob?.id).toBe(job.id);
      await expect(instance.discover(project)).rejects.toThrow('cmake.busy');
    } finally {
      await instance.cancel(job.id);
    }
  });
  it('persists configuration outside the project and restores it in a new service', async () => {
    const first = await service();
    const inspected = await first.inspect(project);
    await first.save(project, { ...inspected.config, jobs: 7, selections: { buildType: 'Release' } });
    const restored = await (await service()).inspect(project);
    expect(restored.config.jobs).toBe(7);
    expect(restored.selection).toEqual({ buildType: 'Release' });
    expect(await fs.readdir(project)).toEqual(['CMakeLists.txt']);
  });
  it('records one-off job selections while preserving saved defaults', async () => {
    const instance = await service();
    const job = await instance.start(project, 'check', { buildType: 'Release' });
    expect(job.selection).toEqual({ buildType: 'Release' });
    expect((await finish(instance, job.id)).job.selection).toEqual({ buildType: 'Release' });
    expect((await instance.inspect(project)).selection).toEqual({ buildType: 'Debug' });
  });
  it('recovers obsolete saved selections for inspection without persisting or hiding the latest job', async () => {
    const file = path.join(project, 'cmake-variants.yaml');
    await fs.writeFile(file, 'mode: {choices: {old: {short: Old}}}\nremoved: {choices: {x: {short: X}}}');
    const instance = await service();
    const initial = await instance.inspect(project);
    await instance.save(project, { ...initial.config, selections: { mode: 'old', removed: 'x' } });
    const previous = await finish(instance, (await instance.start(project, 'check')).id);
    await fs.writeFile(file, 'mode: {choices: {current: {short: Current}}}');
    const recovered = await instance.inspect(project);
    expect(recovered.invalidSelections).toEqual(['mode=old', 'removed=x']);
    expect(recovered.config.selections).toEqual({});
    expect(recovered.selection).toEqual({ mode: 'current' });
    expect(recovered.latestJob?.id).toBe(previous.job.id);
    await expect(instance.start(project, 'check')).rejects.toThrow(/selection/);
    await instance.save(project, recovered.config);
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.status).toBe('succeeded');
  });
  it('continues rejecting explicit invalid AI selections after inspection recovery', async () => {
    const instance = await service();
    const initial = await instance.inspect(project);
    await instance.save(project, { ...initial.config, selections: { buildType: 'Release' } });
    await fs.writeFile(path.join(project, 'cmake-variants.yaml'), 'buildType: {choices: {Debug: {buildType: Debug}}}');
    const recovered = await instance.inspect(project);
    await instance.save(project, recovered.config);
    await expect(instance.start(project, 'check', { buildType: 'Release' })).rejects.toThrow(/selection/);
    await expect(instance.start(project, 'check', { obsolete: 'x' })).rejects.toThrow(/selection/);
  });
  it('preserves flags while configuring and building in a managed isolated directory', async () => {
    const calls: ProcessRequest[] = [];
    await fs.writeFile(
      path.join(project, 'cmake-variants.yaml'),
      'buildType: {choices: {Debug: {buildType: Debug, settings: {CMAKE_C_FLAGS: "-m32 -Wall", METER: A}}}}'
    );
    const instance = await service(async (request) => {
      calls.push(request);
      return normalRunner(request);
    });
    const job = await instance.start(project, 'build');
    expect((await finish(instance, job.id)).job.status).toBe('succeeded');
    const configure = calls.find((call) => call.args.includes('-G'))!;
    expect(configure.args).toContain('-DCMAKE_C_FLAGS=-m32 -Wall');
    expect(configure.cwd).toBe(job.buildDirectory);
    expect(calls.some((call) => call.args.join(' ') === '--build . -- -j2')).toBe(true);
  });
  it('rejects concurrent operations and releases its project lock after child exit', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const instance = await service(async (request) => {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
        request.signal.addEventListener('abort', () => {}, { once: true });
      });
      if (request.signal.aborted) throw new Error('cmake.cancelled');
      return normalRunner(request);
    });
    const job = await instance.start(project, 'check');
    await waiting;
    const cancelled = instance.cancel(job.id);
    await expect(instance.start(project, 'check')).rejects.toThrow(/busy/);
    release?.();
    await cancelled;
    expect(instance.read(job.id).job.status).toBe('cancelled');
  });
  it('fails a test operation before running CTest when no configured build exists', async () => {
    const instance = await service();
    const job = await instance.start(project, 'test');
    expect((await finish(instance, job.id)).job.error).toMatch(/notConfigured/);
  });
  it('fails rather than claiming success when CTest discovers no tests', async () => {
    const calls: ProcessRequest[] = [];
    const instance = await service(async (request) => {
      calls.push(request);
      if (request.args.includes('-N')) return { code: 0, output: 'Total Tests: 0' };
      return normalRunner(request);
    });
    await finish(instance, (await instance.start(project, 'configure')).id);
    const test = await finish(instance, (await instance.start(project, 'test')).id);
    expect(test.job.error).toMatch(/noTests/);
    expect(calls.some((call) => call.args.includes('--output-on-failure'))).toBe(false);
  });
  it('reports an unavailable compiler or failed 32-bit link probe', async () => {
    const instance = await service(async (request) =>
      request.args.includes('-m32') ? { code: 1, output: 'cannot find -lstdc++' } : normalRunner(request)
    );
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.error).toMatch(/exit|probe/i);
    await fs.rm(path.join(toolsDir, 'gcc.exe'));
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.error).toMatch(/toolNotFound/);
  });
  it('rejects a successful compiler that actually produced an x64 executable', async () => {
    const instance = await service(async (request) => {
      const result = await normalRunner(request);
      if (request.args.includes('-o')) await pe(request.args[request.args.indexOf('-o') + 1], 0x8664);
      return result;
    });
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.error).toMatch(/architecture/);
  });
  it('does not run an executable outside the managed build tree', async () => {
    const instance = await service();
    const initial = await instance.inspect(project);
    await instance.save(project, { ...initial.config, runExecutable: path.join(root, 'outside.exe') });
    await pe(path.join(root, 'outside.exe'));
    await finish(instance, (await instance.start(project, 'configure')).id);
    expect((await finish(instance, (await instance.start(project, 'run')).id)).job.error).toMatch(/executablePath/);
  });
  it('runs only an explicitly selected existing PE executable inside the build tree', async () => {
    const calls: ProcessRequest[] = [];
    const instance = await service(async (request) => {
      calls.push(request);
      return normalRunner(request);
    });
    const initial = await instance.inspect(project);
    await instance.save(project, { ...initial.config, runExecutable: 'app.exe', runArguments: ['literal & argument'] });
    const configured = await finish(instance, (await instance.start(project, 'configure')).id);
    await pe(path.join(configured.job.buildDirectory, 'app.exe'));
    expect((await finish(instance, (await instance.start(project, 'run')).id)).job.status).toBe('succeeded');
    expect(calls.at(-1)?.args).toEqual(['literal & argument']);
    expect(calls.at(-1)?.env.AIONUI_BACKEND_TOKEN).toBeUndefined();
  });
  it('bounds logs with absolute cursors and retains the latest job in inspect', async () => {
    const instance = await service(
      async (request) => {
        request.onOutput('x'.repeat(3000));
        return normalRunner(request);
      },
      { maxLogChars: 1024 }
    );
    const job = await instance.start(project, 'check');
    await finish(instance, job.id);
    const read = instance.read(job.id, 0);
    expect(read.output.length).toBeLessThanOrEqual(1024);
    expect(read.truncated).toBe(true);
    expect((await instance.inspect(project)).latestJob?.id).toBe(job.id);
    expect(instance.read(job.id, read.cursor).output).toBe('');
  });
  it('exposes at most the log limit while the job is still writing', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing = true;
    const instance = await service(
      async (request) => {
        if (writing) {
          for (let index = 0; index < 150; index++) request.onOutput(`line ${index}\n`);
          writing = false;
          await blocked;
        }
        return normalRunner(request);
      },
      { maxLogChars: 1024 }
    );
    const job = await instance.start(project, 'check');
    await expect.poll(() => writing).toBe(false);
    const read = instance.read(job.id, 0);
    release();
    expect([read.output.length, read.output.endsWith('line 149\n'), read.truncated]).toEqual([1024, true, true]);
  });
  it('keeps cursors exact after the log is trimmed in batches', async () => {
    const instance = await service(
      async (request) => {
        for (let index = 0; index < 400; index++) request.onOutput(`line ${index}\n`);
        return normalRunner(request);
      },
      { maxLogChars: 1024 }
    );
    const job = await instance.start(project, 'check');
    const all = await finish(instance, job.id);
    const tail = instance.read(job.id, all.cursor - 10);
    expect([tail.output, tail.truncated]).toEqual([all.output.slice(-10), false]);
  });
  it('limits completed job retention without evicting running operations', async () => {
    const instance = await service(normalRunner, { maxCompletedJobs: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await instance.start(project, 'check');
      ids.push(job.id);
      await finish(instance, job.id);
    }
    expect(() => instance.read(ids[0])).toThrow(/jobNotFound/);
    expect(instance.read(ids[2]).job.status).toBe('succeeded');
  });
  it('rejects build-directory junctions escaping the project root', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(project, 'build'), 'junction');
    await expect((await service()).inspect(project)).rejects.toThrow(/buildPath/);
    expect(await fs.readdir(path.join(root, 'outside'))).toEqual([]);
  });
  it('rejects older CMake versions before configuring', async () => {
    const instance = await service(async (request) =>
      request.executable.includes('cmake') && request.args.includes('--version')
        ? { code: 0, output: 'cmake version 3.4.3' }
        : normalRunner(request)
    );
    expect((await finish(instance, (await instance.start(project, 'configure')).id)).job.error).toMatch(/version/);
  });
  it('uses a new build directory when a tool is replaced at the same path', async () => {
    const instance = await service();
    const before = await instance.inspect(project);
    await fs.writeFile(path.join(toolsDir, 'gcc.exe'), 'updated compiler binary');
    expect((await instance.inspect(project)).buildDirectory).not.toBe(before.buildDirectory);
  });
  it('does not require C++ for a C-only project but does for project named C', async () => {
    const instance = await service();
    await fs.rm(path.join(toolsDir, 'g++.exe'));
    await fs.writeFile(path.join(project, 'CMakeLists.txt'), 'project(test LANGUAGES C)');
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.status).toBe('succeeded');
    await fs.writeFile(path.join(project, 'CMakeLists.txt'), 'project(C)');
    expect((await finish(instance, (await instance.start(project, 'check')).id)).job.error).toMatch(/cxxCompiler/);
  });
  it('does not launch a job racing service shutdown', async () => {
    let calls = 0;
    const instance = await service(async (request) => {
      calls++;
      return normalRunner(request);
    });
    const starting = instance.start(project, 'check');
    await instance.dispose();
    await expect(starting).rejects.toThrow(/disposed/);
    expect(calls).toBe(0);
  });
  it('shares a lock for project aliases resolved to the same canonical root', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(project, alias, 'junction');
    const instance = await service(
      async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('cmake.cancelled')), { once: true });
          if (request.signal.aborted) reject(new Error('cmake.cancelled'));
        })
    );
    const job = await instance.start(project, 'check');
    await expect(instance.start(alias, 'check')).rejects.toThrow(/busy/);
    await instance.cancel(job.id);
  });
});
