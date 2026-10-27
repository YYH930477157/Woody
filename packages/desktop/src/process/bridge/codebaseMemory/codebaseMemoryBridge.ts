import { app, shell } from 'electron';
import path from 'node:path';
import { codebaseMemory } from '@/common/adapter/codebaseMemory';
import { createCodebaseMemoryService } from '@process/services/codebaseMemory/service';
import { resolveCodebaseMemoryResources } from '@process/services/codebaseMemory/resources';

export function initCodebaseMemoryBridge(): void {
  const service = createCodebaseMemoryService({
    ...resolveCodebaseMemoryResources({
      resourceRoot: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
      localAppData: process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined,
      userData: app.getPath('userData'),
    }),
    openExternal: (url) => shell.openExternal(url),
  });
  codebaseMemory.get.provider(({ repoPath }) => service.get(repoPath));
  codebaseMemory.save.provider(({ repoPath, config }) => service.save(repoPath, config));
  codebaseMemory.start.provider(({ repoPath }) => service.start(repoPath));
  codebaseMemory.cancel.provider(({ repoPath }) => service.cancel(repoPath));
  codebaseMemory.session.provider(({ repoPath }) => service.session(repoPath));
  codebaseMemory.openLens.provider(({ repoPath }) => service.openLens(repoPath));
  let stopped = false;
  let stopping: Promise<void> | undefined;
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    stopping ??= service
      .dispose()
      .catch((error: unknown) => {
        console.error('[CodebaseMemory] Lens shutdown failed', error);
      })
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
}
