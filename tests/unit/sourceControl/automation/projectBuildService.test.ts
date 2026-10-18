import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectBuildService } from '@/process/services/sourceControl/projectBuildService';
import type { StaticScanProjectConfig } from '@/common/types/sourceControl/staticScanTypes';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aion-build-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const configure = async (config: StaticScanProjectConfig): Promise<void> => {
  await mkdir(join(root, '.woody'), { recursive: true });
  await writeFile(join(root, '.woody/static-scan.json'), JSON.stringify(config));
};
const runner = () => vi.fn(async () => ({ exitCode: 0, stdout: 'built\n', stderr: '' }));

describe('project build verification', () => {
  it('blocks when the project has no build configuration or recognizable project', async () => {
    const run = runner();
    const result = await createProjectBuildService(run).compile({ repoPath: root });
    expect(result.reasonCode).toBe('buildConfigRequired');
    expect(run).not.toHaveBeenCalled();
  });

  it('prefers an explicit command and executes in the original repository', async () => {
    await configure({ build: { executable: 'builder', arguments: ['a b', ';literal'], timeoutMs: 1000 } });
    const run = runner();
    const result = await createProjectBuildService(run).compile({ repoPath: root });
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(
      'builder',
      ['a b', ';literal'],
      expect.objectContaining({ cwd: root, timeoutMs: 1000 })
    );
    expect(result.stdout).toBe('built\n');
  });

  it('does not silently select between IAR and CMake', async () => {
    await writeFile(join(root, 'firmware.ewp'), '');
    await writeFile(join(root, 'CMakeLists.txt'), '');
    const run = runner();
    const result = await createProjectBuildService(run).compile({ repoPath: root });
    expect(result.reasonCode).toBe('buildAmbiguous');
    expect(run).not.toHaveBeenCalled();
  });

  it('configures and builds the original CMake source with selected configuration', async () => {
    await writeFile(join(root, 'CMakeLists.txt'), '');
    await configure({ build: { system: 'cmake', configuration: 'Debug', buildDirectory: 'output' } });
    const run = runner();
    const result = await createProjectBuildService(run).compile({ repoPath: root });
    expect(result.ok).toBe(true);
    expect(run.mock.calls).toEqual([
      ['cmake', ['-S', root, '-B', join(root, 'output')], expect.objectContaining({ cwd: root })],
      ['cmake', ['--build', join(root, 'output'), '--config', 'Debug'], expect.objectContaining({ cwd: root })],
    ]);
  });

  it('detects an IAR project in a nested directory and builds all configurations by default', async () => {
    await mkdir(join(root, 'iar'));
    await writeFile(join(root, 'iar/firmware.ewp'), '');
    const run = runner();
    await createProjectBuildService(run).compile({ repoPath: root });
    expect(run).toHaveBeenCalledWith('IarBuild', [join(root, 'iar/firmware.ewp'), '-build', '*'], expect.any(Object));
  });

  it('requires an explicit project when multiple IAR projects exist', async () => {
    await writeFile(join(root, 'a.ewp'), '');
    await writeFile(join(root, 'b.ewp'), '');
    expect((await createProjectBuildService(runner()).compile({ repoPath: root })).reasonCode).toBe('buildAmbiguous');
  });

  it.each([{ exitCode: 2 }, { exitCode: 0, timedOut: true }, { exitCode: 0, executableMissing: true }])(
    'retains output and stops after a failed build step: %j',
    async (failure) => {
      await writeFile(join(root, 'CMakeLists.txt'), '');
      const run = vi.fn(async () => ({ stdout: 'configuration output', stderr: 'failure', ...failure }));
      const result = await createProjectBuildService(run).compile({ repoPath: root });
      expect(result).toMatchObject({
        ok: false,
        reasonCode: 'buildFailed',
        stdout: 'configuration output',
        stderr: 'failure',
      });
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it('rejects a malformed configuration instead of silently probing a different build', async () => {
    await mkdir(join(root, '.woody'));
    await writeFile(join(root, '.woody/static-scan.json'), '{bad');
    expect((await createProjectBuildService(runner()).compile({ repoPath: root })).reasonCode).toBe('buildFailed');
  });

  it('rejects build directories outside the repository', async () => {
    await configure({ build: { system: 'cmake', project: '.', buildDirectory: '../elsewhere' } });
    const run = runner();
    expect((await createProjectBuildService(run).compile({ repoPath: root })).ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a real command and preserves its failure output', async () => {
    await configure({
      build: { executable: process.execPath, arguments: ['-e', 'console.error("build-error");process.exit(7)'] },
    });
    const result = await createProjectBuildService().compile({ repoPath: root });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('build-error');
  });
});
