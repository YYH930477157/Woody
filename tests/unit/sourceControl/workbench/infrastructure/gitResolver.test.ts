import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GitResolutionError,
  createGitRuntimeResolver,
  parseGitVersion,
  resolveGitRuntime,
  systemGitCandidates,
} from '@process/services/sourceControl/workbench/executor/runtime';

const exists = async (candidate: string) => candidate;

describe('Git runtime resolution', () => {
  it('uses an explicitly configured executable and never silently falls back', async () => {
    const probe = vi.fn(async () => 'git version 2.54.0.windows.1');
    const systemCandidates = [path.resolve('system/git.exe')];
    const runtime = await resolveGitRuntime({
      configuredPath: path.resolve('trusted/git.exe'),
      systemCandidates,
      inspectPath: exists,
      probe,
    });

    expect(runtime).toMatchObject({
      source: 'configured',
      executable: path.resolve('trusted/git.exe'),
      version: { major: 2, minor: 54, patch: 0 },
      capabilities: { updateRefs: true, memoryHistoryEdit: true },
    });
    expect(probe).toHaveBeenCalledTimes(1);

    const failedProbe = vi.fn(async () => {
      throw new Error('Access denied by file encryption policy');
    });
    await expect(
      resolveGitRuntime({
        configuredPath: path.resolve('trusted/git.exe'),
        systemCandidates,
        inspectPath: exists,
        probe: failedProbe,
      })
    ).rejects.toMatchObject({
      name: 'GitResolutionError',
      attempts: [
        {
          source: 'configured',
          path: path.resolve('trusted/git.exe'),
          reason: 'Access denied by file encryption policy',
        },
      ],
    });
    expect(failedProbe).toHaveBeenCalledTimes(1);
  });

  it('prefers a supported system Git when no path is configured', async () => {
    const system = path.resolve('system/git.exe');
    const bundled = path.resolve('bundle/git.exe');
    const runtime = await resolveGitRuntime({
      systemCandidates: [path.resolve('missing/git.exe'), system],
      bundledExecutable: bundled,
      inspectPath: async (candidate) => {
        if (candidate.includes('missing')) throw new Error('ENOENT');
        return candidate;
      },
      probe: async (candidate) => (candidate === bundled ? 'git version 2.54.0' : 'git version 2.39.3.windows.1'),
    });

    expect(runtime.source).toBe('system');
    expect(runtime.executable).toBe(system);
    expect(runtime.capabilities.updateRefs).toBe(true);
    expect(runtime.capabilities.memoryHistoryEdit).toBe(false);
  });

  it('falls back to the packaged Git when system Git is missing or unsupported', async () => {
    const bundled = path.resolve('bundle/git.exe');
    const system = path.resolve('system/git.exe');
    const runtime = await resolveGitRuntime({
      systemCandidates: [system],
      bundledExecutable: bundled,
      inspectPath: exists,
      probe: async (candidate) => (candidate === bundled ? 'git version 2.54.0' : 'git version 2.24.4.windows.1'),
    });

    expect(runtime.source).toBe('bundled');
    expect(runtime.executable).toBe(bundled);
    expect(runtime.capabilities).toEqual({ updateRefs: true, memoryHistoryEdit: true });
  });

  it('reports all attempted paths when no supported runtime exists', async () => {
    const failure = resolveGitRuntime({
      systemCandidates: [path.resolve('system/git.exe')],
      bundledExecutable: path.resolve('bundle/git.exe'),
      inspectPath: async (candidate) => {
        if (candidate.includes('bundle')) throw new Error('Missing bundled Git');
        return candidate;
      },
      probe: async () => 'git version 2.20.0',
    });

    await expect(failure).rejects.toBeInstanceOf(GitResolutionError);
    await expect(failure).rejects.toMatchObject({
      attempts: [
        { source: 'system', reason: 'Git 2.20.0 is older than the supported minimum 2.25.0' },
        { source: 'bundled', path: path.resolve('bundle/git.exe'), reason: 'Missing bundled Git' },
      ],
    });
  });

  it('caches the verified executable for the application lifetime', async () => {
    const probe = vi.fn(async () => 'git version 2.54.0');
    const resolver = createGitRuntimeResolver({
      systemCandidates: [path.resolve('system/git.exe')],
      inspectPath: exists,
      probe,
    });
    const [first, second] = await Promise.all([resolver.get(), resolver.get()]);
    expect(first).toBe(second);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('parses Git for Windows versions and builds PATH candidates without a shell', () => {
    expect(parseGitVersion('git version 2.25.2.windows.1')).toMatchObject({
      major: 2,
      minor: 25,
      patch: 2,
      raw: '2.25.2.windows.1',
    });
    expect(systemGitCandidates({ PATH: `${path.resolve('a')};${path.resolve('b')}` }, 'win32')).toEqual([
      // `.cmd`/`.bat` shims are not spawnable without a shell, so they are not candidates.
      path.join(path.resolve('a'), 'git.exe'),
      path.join(path.resolve('b'), 'git.exe'),
    ]);
  });
});
