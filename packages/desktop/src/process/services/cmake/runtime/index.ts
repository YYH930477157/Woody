import { app } from 'electron';
import path from 'node:path';
import { CmakeService } from '../cmakeService';
import { startCmakeRpc } from './cmakeRpc';
import { GdbService } from '../gdb';

type Runtime = { service: CmakeService; debug: GdbService; rpc: Awaited<ReturnType<typeof startCmakeRpc>> };
let runtime: Runtime | undefined;
let starting: Promise<Runtime> | undefined;

/** Publish credentials before aioncore spawns its managed MCP processes. */
export function getCmakeRuntime(): Promise<Runtime> {
  if (runtime) return Promise.resolve(runtime);
  if (starting) return starting;
  starting = (async () => {
    const service = new CmakeService(path.join(app.getPath('userData'), 'cmake', 'projects'));
    const debug = new GdbService((root) => service.acquireDebugTarget(root));
    const rpc = await startCmakeRpc(service, debug);
    process.env.AIONUI_CMAKE_PORT = String(rpc.port);
    process.env.AIONUI_CMAKE_TOKEN = rpc.token;
    runtime = { service, debug, rpc };
    return runtime;
  })().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/** Stop accepting AI requests before cancelling outstanding build processes. */
export async function closeCmakeRuntime(): Promise<void> {
  const current = runtime ?? (await starting);
  if (!current) return;
  await current.rpc.close();
  await current.debug.dispose();
  await current.service.dispose();
  delete process.env.AIONUI_CMAKE_PORT;
  delete process.env.AIONUI_CMAKE_TOKEN;
  runtime = undefined;
  starting = undefined;
}
