import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';
import { createGitStorageService } from '@process/services/sourceControl/workbench/storage';

export const scope = { projectId: 'registered', peId: 'entry', relativePath: '' };
export const git = createGitExecutor();
export async function fixture(repository = true) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'woody-storage-'));
  const root = path.join(temp, 'project');
  const storeDir = path.join(temp, 'userData');
  await mkdir(root);
  const options = {
    storeDir,
    resolveRoot: async (value: typeof scope) => {
      if (value.projectId !== scope.projectId) throw new Error('Unknown project');
      return root;
    },
  };
  if (repository) {
    await git(root, ['init']);
    await git(root, ['config', 'user.name', 'Storage Test']);
    await git(root, ['config', 'user.email', 'test@example.invalid']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(root, 'one.txt'), 'base\n');
    await writeFile(path.join(root, 'other.txt'), 'other\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'base']);
  }
  const service = createGitStorageService(options);
  return {
    root,
    storeDir,
    options,
    service,
    cleanup: async () => {
      await service.dispose();
      await rm(temp, { recursive: true, force: true, maxRetries: 4 });
    },
  };
}
