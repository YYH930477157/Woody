import fs from 'node:fs/promises';
import path from 'node:path';
import { app, shell } from 'electron';
import { httpRequest } from '@/common/adapter/httpBridge';
import { memory } from '@/common/adapter/memory';
import { createMemoryService } from '@process/services/memory/service';
import { onConfirmedQuit } from '@process/startup/quitCleanup';

/** The aionrs agent's per-project memories: panel, recall before sending, distill when quiet. */
export function initMemoryBridge(): void {
  const service = createMemoryService({
    request: (method, requestPath, body) => httpRequest(method, requestPath, body),
    appData: app.getPath('appData'),
    statePath: path.join(app.getPath('userData'), 'memory', 'state.json'),
    trash: (target) => shell.trashItem(target),
  });
  memory.list.provider(({ workspace }) => service.list(workspace));
  memory.search.provider(({ workspace, query }) => service.search(workspace, query));
  memory.save.provider(({ workspace, input }) => service.save(workspace, input));
  memory.remove.provider(({ workspace, file }) => service.remove(workspace, file));
  memory.openFolder.provider(async ({ workspace }) => {
    const directory = service.directoryFor(workspace);
    await fs.mkdir(directory, { recursive: true });
    const failure = await shell.openPath(directory);
    if (failure) throw new Error(failure);
  });
  memory.distill.provider(({ conversationId }) => service.distill(conversationId));
  memory.recall.provider(({ conversationId, text }) => service.recall(conversationId, text));
  memory.workspaceOf.provider(async ({ conversationId }) => (await service.workspaceOf(conversationId)) ?? null);
  memory.getSettings.provider(() => service.getSettings());
  memory.setSettings.provider((settings) => service.setSettings(settings));
  service.start();
  onConfirmedQuit(() =>
    service.dispose().catch((error: unknown) => {
      console.error('[Memory] Stopping the memory service failed', error);
    })
  );
}
