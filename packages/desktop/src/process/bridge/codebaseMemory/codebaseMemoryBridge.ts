import { app } from 'electron';
import path from 'node:path';
import { codebaseMemory } from '@/common/adapter/codebaseMemory';
import { createCodebaseMemoryService } from '@process/services/codebaseMemory/service';
import { resolveCodebaseMemoryResources } from '@process/services/codebaseMemory/resources';

export function initCodebaseMemoryBridge(): void {
  const service = createCodebaseMemoryService(
    resolveCodebaseMemoryResources({
      resourceRoot: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
      localAppData: process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined,
      userData: app.getPath('userData'),
    })
  );
  codebaseMemory.get.provider(({ repoPath }) => service.get(repoPath));
  codebaseMemory.save.provider(({ repoPath, config }) => service.save(repoPath, config));
  codebaseMemory.start.provider(({ repoPath }) => service.start(repoPath));
  codebaseMemory.cancel.provider(({ repoPath }) => service.cancel(repoPath));
  codebaseMemory.session.provider(({ repoPath }) => service.session(repoPath));
  app.on('before-quit', () => service.dispose());
}
