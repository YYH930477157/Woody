import { ipcBridge } from '@/common';
import { app } from 'electron';
import {
  createStaticScanService,
  type StaticScanRequest,
  type StaticScanService,
} from '@process/services/sourceControl/staticScanService';
import {
  createStaticScanConfigStore,
  type StaticScanConfigStore,
} from '@process/services/sourceControl/staticScanConfigStore';

export function initStaticScanBridge(
  service: StaticScanService = createStaticScanService(),
  configStore?: StaticScanConfigStore
): void {
  const resolvedConfigStore = configStore ?? createStaticScanConfigStore(app.getPath('userData'));
  const run = (request: StaticScanRequest) => service.scan(request);
  ipcBridge.staticScan.scan.provider(run);
  ipcBridge.staticScan.test.provider(run);
  ipcBridge.staticScan.getMachineConfig.provider(() => resolvedConfigStore.getMachineConfig());
  ipcBridge.staticScan.saveMachineConfig.provider(async (config) => {
    await resolvedConfigStore.saveMachineConfig(config);
    return true;
  });
  ipcBridge.staticScan.getProjectConfig.provider(({ repoPath }) => resolvedConfigStore.getProjectConfig(repoPath));
  ipcBridge.staticScan.saveCommitChecks.provider(({ repoPath, checks }) =>
    resolvedConfigStore.saveCommitChecks(repoPath, checks)
  );
  ipcBridge.staticScan.saveProjectConfig.provider(async ({ repoPath, config }) => {
    await resolvedConfigStore.saveProjectConfig(repoPath, config);
    return true;
  });
}
