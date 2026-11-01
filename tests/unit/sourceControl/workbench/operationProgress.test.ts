import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitOperationProgress } from '@/common/types/sourceControl/operationTypes';
import { createGitOperationService } from '@process/services/sourceControl/workbench/operations';
import { createProgressReader } from '@process/services/sourceControl/workbench/operations/engine';

const CR = String.fromCharCode(13);

describe('createProgressReader', () => {
  it('reports the newest line of a chunk', () => {
    const report = vi.fn();

    createProgressReader(report)(`Receiving objects:  10% (1/10)${CR}Receiving objects:  45% (5/10)${CR}`);

    expect(report).toHaveBeenCalledExactlyOnceWith({ phase: 'receiving', percent: 45 });
  });

  it('skips a repeat of the same phase and percent', () => {
    const report = vi.fn();
    const read = createProgressReader(report);

    read('Writing objects:  50% (1/2)');
    read('Writing objects:  50% (1/2)');
    read('Resolving deltas: 100% (2/2)');

    expect(report.mock.calls.map(([progress]) => progress)).toEqual([
      { phase: 'writing', percent: 50 },
      { phase: 'resolving', percent: 100 },
    ]);
  });

  it('ignores ordinary Git messages', () => {
    const report = vi.fn();

    createProgressReader(report)('From example.test:org/repo');

    expect(report).not.toHaveBeenCalled();
  });
});

describe('remote operations', () => {
  const scope = { projectId: 'project', peId: 'root', relativePath: '' };
  let base: string;
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'woody-progress-'));
    root = path.join(base, 'work');
    const origin = path.join(base, 'origin.git');
    git(base, 'init', '-q', '--bare', origin);
    git(base, 'init', '-q', '-b', 'main', root);
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.test');
    await writeFile(path.join(root, 'file.txt'), 'x'.repeat(4096));
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'base');
    git(root, 'remote', 'add', 'origin', origin);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reports push progress and keeps it out of the final report', async () => {
    const updates: GitOperationProgress[] = [];
    const service = createGitOperationService({
      resolveRoot: async () => root,
      onProgress: (_operationId, progress) => updates.push(progress),
    });
    const expectedHead = git(root, 'rev-parse', 'HEAD');

    const result = await service.operate(
      scope,
      { kind: 'push', remote: 'origin', branch: 'main', expectedHead, confirmed: true },
      'operation-1'
    );

    expect(result.state).toBe('complete');
    expect(updates.at(-1)).toMatchObject({ phase: 'writing', percent: 100 });
    expect(result.output).not.toContain(CR);
  });
});
