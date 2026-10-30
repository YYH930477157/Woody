import { app } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { gitStorage } from '@/common/adapter/ipcBridge';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { ProjectDetailDto } from '@/common/types/project';
import { createProjectRootResolver } from '@process/services/sourceControl/workbench/workspace';
import { createGitStorageService } from '@process/services/sourceControl/workbench/storage';
import { createRecorderLifecycle } from './lifecycle';
import { getGitBridgeRuntime, type GitBridgeRuntime } from './runtime';

/** Bind bounded project storage to native IPC and renderer-owned recording lifetimes. */
export function initGitStorageBridge(runtimePromise: Promise<GitBridgeRuntime> = getGitBridgeRuntime()): void {
  const loadProject = (id: string) => httpRequest<ProjectDetailDto>('GET', `/api/projects/${encodeURIComponent(id)}`);
  const resolveRoot = createProjectRootResolver(loadProject);
  const servicePromise = runtimePromise.then((runtime) =>
    createGitStorageService({
      resolveRoot,
      storeDir: path.join(app.getPath('userData'), 'git-storage'),
      git: runtime.git,
      run: runtime.coordinator.run,
    })
  );
  const lifetimePromise = servicePromise.then((service) =>
    createRecorderLifecycle({ resolveRoot, start: service.historyStart, stop: service.historyStop })
  );
  gitStorage.shelfList.provider(async ({ scope }) => (await servicePromise).shelfList(scope));
  gitStorage.shelfRead.provider(async ({ scope, id }) => (await servicePromise).shelfRead(scope, id));
  gitStorage.shelfCreate.provider(async ({ scope, request }) => (await servicePromise).shelfCreate(scope, request));
  gitStorage.shelfRename.provider(async ({ scope, id, name }) => (await servicePromise).shelfRename(scope, id, name));
  gitStorage.shelfDelete.provider(async ({ scope, id, permanently }) =>
    (await servicePromise).shelfDelete(scope, id, permanently)
  );
  gitStorage.shelfRestore.provider(async ({ scope, id }) => (await servicePromise).shelfRestore(scope, id));
  gitStorage.shelfApply.provider(async ({ scope, request }) => (await servicePromise).shelfApply(scope, request));
  gitStorage.shelfImport.provider(async ({ scope, request }) => (await servicePromise).shelfImport(scope, request));
  gitStorage.shelfExport.provider(async ({ scope, request }) => (await servicePromise).shelfExport(scope, request));
  gitStorage.changelistRead.provider(async ({ scope }) => (await servicePromise).changelistRead(scope));
  gitStorage.changelistSync.provider(async ({ scope, changes }) =>
    (await servicePromise).changelistSync(scope, changes)
  );
  gitStorage.changelistMutate.provider(async ({ scope, request }) =>
    (await servicePromise).changelistMutate(scope, request)
  );
  gitStorage.historyList.provider(async ({ scope, query }) => (await servicePromise).historyList(scope, query));
  gitStorage.historyCapture.provider(async ({ scope, request }) =>
    (await servicePromise).historyCapture(scope, request)
  );
  gitStorage.historyLabel.provider(async ({ scope, label }) => (await servicePromise).historyLabel(scope, label));
  gitStorage.historyRead.provider(async ({ scope, request }) => (await servicePromise).historyRead(scope, request));
  gitStorage.historyCompare.provider(async ({ scope, request }) =>
    (await servicePromise).historyCompare(scope, request)
  );
  gitStorage.historyRestore.provider(async ({ scope, request }) =>
    (await servicePromise).historyRestore(scope, request)
  );
  gitStorage.historyStatus.provider(async ({ scope }) => (await servicePromise).historyStatus(scope));
  const owners = new Set<number>();
  const generations = new Map<number, number>();
  gitStorage.historyTrack.provider(async (request) => {
    const { projectId } = z
      .object({ projectId: z.string().min(1).max(1024).nullable() })
      .strict()
      .parse(request);
    const { getNativeBridgeSender } = await import('@/common/adapter/main');
    const sender = getNativeBridgeSender();
    if (!sender || sender.isDestroyed()) throw new Error('Local history recording requires a desktop window');
    const generation = (generations.get(sender.id) ?? 0) + 1;
    generations.set(sender.id, generation);
    if (!owners.has(sender.id)) {
      owners.add(sender.id);
      sender.once('destroyed', () => {
        owners.delete(sender.id);
        generations.delete(sender.id);
        void lifetimePromise
          .then((lifetime) => lifetime.set(sender.id, []))
          .catch((error: unknown) => console.error('[GitHistory] close failed', error));
      });
    }
    const project = projectId ? await loadProject(projectId) : undefined;
    if (sender.isDestroyed() || generations.get(sender.id) !== generation) return;
    const lifetime = await lifetimePromise;
    await lifetime.set(
      sender.id,
      project?.explorer.entries
        .filter((entry) => entry.runtime_status === 'available')
        .map((entry) => ({ projectId: project!.project_id, peId: entry.pe_id, relativePath: '' })) ?? []
    );
  });
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void servicePromise
      .then((service) => service.dispose())
      .catch((error: unknown) => console.error('[GitHistory] flush failed', error))
      .finally(() => app.quit());
  });
}
