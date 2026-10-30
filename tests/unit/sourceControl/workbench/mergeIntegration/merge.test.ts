import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as mergeModule from '@process/services/sourceControl/workbench/merge';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const scope = { projectId: 'project', peId: 'root', relativePath: '' };
let root: string;
let storeDir: string;
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-merge-'));
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'woody-recovery-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(root, 'file.txt'), 'base\r\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'incoming');
  await writeFile(path.join(root, 'file.txt'), 'theirs\r\n');
  git('commit', '-qam', 'incoming');
  git('checkout', '-q', 'main');
  await writeFile(path.join(root, 'file.txt'), 'ours\r\n');
  git('commit', '-qam', 'current');
  try {
    git('merge', '--no-edit', 'incoming');
  } catch {
    /* expected conflict */
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
  await rm(storeDir, { recursive: true, force: true, maxRetries: 3 });
});
const service = () => mergeModule.createGitMergeService({ resolveRoot: async () => root, storeDir });
describe('merge document recovery and scoped resolution', { timeout: 30_000 }, () => {
  it('provides an implemented merge service', () => {
    expect(mergeModule.createGitMergeService).toBeTypeOf('function');
  });
  it('saves partial text without staging and restores progress after service restart', async () => {
    const doc = await service().read(scope, 'file.txt');
    const progress = { lines: ['partial', ''], states: [], contentModified: true };
    await service().save(scope, { file: doc.file, version: doc.version, result: 'partial\r\n', progress });
    const reopened = await service().read(scope, doc.file);
    expect(reopened.progress).toEqual(progress);
    expect(git('ls-files', '-u')).toContain('file.txt');
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('partial\r\n');
  });
  it('blocks stale working data and retains partial recovery', async () => {
    const doc = await service().read(scope, 'file.txt');
    await writeFile(path.join(root, doc.file), 'external\n');
    const result = await service().finish(scope, {
      file: doc.file,
      version: doc.version,
      resolution: 'ours',
      confirmed: true,
    });
    expect(result.state).toBe('blocked');
    expect(await readFile(path.join(root, doc.file), 'utf8')).toBe('external\n');
  });
  it('accepts exact side bytes and stages only that file', async () => {
    const doc = await service().read(scope, 'file.txt');
    await writeFile(path.join(root, 'unrelated'), 'leave me');
    const result = await service().finish(scope, {
      file: doc.file,
      version: doc.version,
      resolution: 'theirs',
      confirmed: true,
    });
    expect(result.state).toBe('complete');
    expect(await readFile(path.join(root, doc.file), 'utf8')).toBe('theirs\r\n');
    expect(git('status', '--porcelain')).toContain('?? unrelated');
  });
  it('blocks marker output unless explicitly reviewed as manual resolution', async () => {
    const doc = await service().read(scope, 'file.txt');
    const request = {
      file: doc.file,
      version: doc.version,
      resolution: 'result' as const,
      result: doc.result!,
      confirmed: true as const,
    };
    expect((await service().finish(scope, request)).state).toBe('blocked');
    expect((await service().finish(scope, { ...request, reviewedManual: true })).state).toBe('complete');
  });
  it('rejects traversal and git metadata paths', async () => {
    await expect(service().read(scope, '../escape')).rejects.toThrow();
    await expect(service().read(scope, '.git/config')).rejects.toThrow();
  });
  it('accepts binary and non-UTF8 blobs byte-for-byte without permitting text replacement', async () => {
    git('merge', '--abort');
    git('checkout', '-q', 'incoming');
    await writeFile(path.join(root, 'file.txt'), Buffer.from([0, 255, 10, 128]));
    git('commit', '-qam', 'binary incoming');
    git('checkout', '-q', 'main');
    await writeFile(path.join(root, 'file.txt'), Buffer.from([0, 254, 13, 10]));
    git('commit', '-qam', 'binary current');
    try {
      git('merge', '--no-edit', 'incoming');
    } catch {
      /* expected */
    }
    const doc = await service().read(scope, 'file.txt');
    expect(doc.binary).toBe(true);
    expect(
      (
        await service().finish(scope, {
          file: doc.file,
          version: doc.version,
          resolution: 'result',
          result: 'replacement',
          confirmed: true,
        })
      ).state
    ).toBe('blocked');
    await service().finish(scope, { file: doc.file, version: doc.version, resolution: 'theirs', confirmed: true });
    expect(await readFile(path.join(root, doc.file))).toEqual(Buffer.from([0, 255, 10, 128]));
  });
  it('accepts a deleted side and removes only the selected index entry', async () => {
    git('merge', '--abort');
    git('rm', 'file.txt');
    git('commit', '-qm', 'delete current');
    try {
      git('merge', '--no-edit', 'incoming');
    } catch {
      /* expected */
    }
    const doc = await service().read(scope, 'file.txt');
    expect(doc.stages.ours.deleted).toBe(true);
    expect(
      (await service().finish(scope, { file: doc.file, version: doc.version, resolution: 'ours', confirmed: true }))
        .state
    ).toBe('complete');
    expect(git('ls-files', 'file.txt')).toBe('');
  });
  it('invalidates documents when another index entry changes', async () => {
    const doc = await service().read(scope, 'file.txt');
    await writeFile(path.join(root, 'other'), 'new');
    git('add', 'other');
    expect(
      (await service().finish(scope, { file: doc.file, version: doc.version, resolution: 'ours', confirmed: true }))
        .state
    ).toBe('blocked');
  });
  it('rejects a directory junction and never writes to its outside target', async () => {
    git('merge', '--abort');
    git('checkout', '-q', 'incoming');
    await mkdir(path.join(root, 'nested'));
    git('mv', 'file.txt', 'nested/file.txt');
    git('commit', '-qm', 'move incoming');
    git('checkout', '-q', 'main');
    await mkdir(path.join(root, 'nested'), { recursive: true });
    git('mv', 'file.txt', 'nested/file.txt');
    git('commit', '-qm', 'move current');
    try {
      git('merge', '--no-edit', 'incoming');
    } catch {
      /* expected */
    }
    const doc = await service().read(scope, 'nested/file.txt');
    const outside = path.join(storeDir, 'outside');
    await rename(path.join(root, 'nested'), outside);
    await symlink(outside, path.join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    const before = await readFile(path.join(outside, 'file.txt'));
    expect(
      (await service().finish(scope, { file: doc.file, version: doc.version, resolution: 'ours', confirmed: true }))
        .state
    ).toBe('blocked');
    expect(await readFile(path.join(outside, 'file.txt'))).toEqual(before);
  });
  it('labels Git stage 2/current and stage 3/incoming without swapping during rebase', async () => {
    git('merge', '--abort');
    try {
      git('rebase', 'incoming');
    } catch {
      /* expected */
    }
    const doc = await service().read(scope, 'file.txt');
    expect(doc.operation).toBe('rebase');
    expect(doc.stages.ours.text).toBe('theirs\r\n');
    expect(doc.stages.theirs.text).toBe('ours\r\n');
  });
  it('rejects files larger than the editable merge size bound', async () => {
    await writeFile(path.join(root, 'file.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(service().read(scope, 'file.txt')).rejects.toThrow(/size limit/);
  });
  it('retains recovery text and progress when Git staging fails', async () => {
    const doc = await service().read(scope, 'file.txt');
    const progress = { lines: ['reviewed', ''], states: [], contentModified: true };
    const saved = await service().save(scope, { file: doc.file, version: doc.version, result: 'reviewed\n', progress });
    const realGit = createGitExecutor();
    const failing = mergeModule.createGitMergeService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        if (args[0] === 'update-index') throw new Error('Index write failed');
        return realGit(cwd, args, allowed, options);
      },
    });
    expect(
      (
        await failing.finish(scope, {
          file: saved.file,
          version: saved.version,
          resolution: 'result',
          result: 'reviewed\n',
          confirmed: true,
        })
      ).state
    ).toBe('error');
    expect((await service().read(scope, doc.file)).progress).toEqual(progress);
  });
  it('does not attach old progress to an external working write during partial save readback', async () => {
    const doc = await service().read(scope, 'file.txt');
    const realGit = createGitExecutor();
    let changed = false;
    const racing = mergeModule.createGitMergeService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        if (
          !changed &&
          args[0] === 'rev-parse' &&
          (await readFile(path.join(root, 'file.txt'), 'utf8')) === 'partial\n'
        ) {
          changed = true;
          await writeFile(path.join(root, 'file.txt'), 'external\n');
        }
        return realGit(cwd, args, allowed, options);
      },
    });
    await expect(
      racing.save(scope, {
        file: doc.file,
        version: doc.version,
        result: 'partial\n',
        progress: { lines: ['partial', ''], states: [], contentModified: true },
      })
    ).rejects.toThrow(/changed/);
    expect((await service().read(scope, doc.file)).progress).toBeUndefined();
  });
  it('never stages external bytes changed immediately before the index mutation', async () => {
    const doc = await service().read(scope, 'file.txt');
    const realGit = createGitExecutor();
    let changed = false;
    const racing = mergeModule.createGitMergeService({
      resolveRoot: async () => root,
      storeDir,
      git: async (cwd, args, allowed, options) => {
        if (!changed && ['add', 'update-index'].includes(args[0])) {
          changed = true;
          await writeFile(path.join(root, 'file.txt'), 'UNREVIEWED EXTERNAL CONTENT\n');
        }
        return realGit(cwd, args, allowed, options);
      },
    });
    expect(
      (await racing.finish(scope, { file: doc.file, version: doc.version, resolution: 'ours', confirmed: true })).state
    ).toBe('blocked');
    expect(git('ls-files', '-u')).toContain('file.txt');
    expect((await service().read(scope, 'file.txt')).recoveryResult).toBe('ours\r\n');
  });
  it.skipIf(process.platform !== 'win32')(
    'exposes saved draft after a failed read-only file replacement and service restart',
    async () => {
      const doc = await service().read(scope, 'file.txt');
      await chmod(path.join(root, 'file.txt'), 0o444);
      try {
        await expect(
          service().save(scope, { file: doc.file, version: doc.version, result: 'VALUABLE MANUAL DRAFT\n' })
        ).rejects.toThrow();
      } finally {
        await chmod(path.join(root, 'file.txt'), 0o644);
      }
      const reopened = await service().read(scope, 'file.txt');
      expect(reopened.recoveryResult).toBe('VALUABLE MANUAL DRAFT\n');
      expect(reopened.result).toBe(doc.result);
    }
  );
  it('preserves the selected executable stage mode even when core.filemode is disabled', async () => {
    git('merge', '--abort');
    git('config', 'core.filemode', 'false');
    git('checkout', '-q', 'incoming');
    git('update-index', '--chmod=+x', 'file.txt');
    git('commit', '-qm', 'executable incoming');
    git('checkout', '-q', 'main');
    try {
      git('merge', '--no-edit', 'incoming');
    } catch {
      /* expected conflict */
    }
    const doc = await service().read(scope, 'file.txt');
    expect(doc.stages.theirs.mode).toBe('100755');
    expect(
      (await service().finish(scope, { file: doc.file, version: doc.version, resolution: 'theirs', confirmed: true }))
        .state
    ).toBe('complete');
    expect(git('ls-files', '--stage', 'file.txt')).toMatch(/^100755 /);
  });
  it('applies Git clean EOL semantics to the reviewed stdin text while retaining working CRLF', async () => {
    git('config', 'core.autocrlf', 'true');
    const doc = await service().read(scope, 'file.txt');
    expect(
      (
        await service().finish(scope, {
          file: doc.file,
          version: doc.version,
          resolution: 'result',
          result: 'reviewed\r\n',
          confirmed: true,
        })
      ).state
    ).toBe('complete');
    expect(execFileSync('git', ['show', ':file.txt'], { cwd: root })).toEqual(Buffer.from('reviewed\n'));
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('reviewed\r\n');
  });
});
