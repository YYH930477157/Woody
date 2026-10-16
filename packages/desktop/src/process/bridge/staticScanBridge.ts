import { ipcBridge } from '@/common';
import {
  createStaticScanService,
  type StaticScanRequest,
  type StaticScanService,
} from '@process/services/sourceControl/staticScanService';

export function initStaticScanBridge(service: StaticScanService = createStaticScanService()): void {
  const run = (request: StaticScanRequest) => service.scan(request);
  ipcBridge.staticScan.scan.provider(run);
  ipcBridge.staticScan.test.provider(run);
}
