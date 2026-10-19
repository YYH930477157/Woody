import { app } from 'electron';
import path from 'node:path';
import { TerminalConnectionService } from './connectionService';
import { TerminalProfileStore } from './profileStore';
import { createNativeTransport, listSerialPorts } from './nativeTransport';
import { startTerminalRpc } from './terminalRpc';

let runtime:
  | {
      service: TerminalConnectionService;
      profiles: TerminalProfileStore;
      close: () => Promise<void>;
    }
  | undefined;
let starting: Promise<NonNullable<typeof runtime>> | undefined;

/** Start before aioncore so only its child MCP processes inherit the bridge secret. */
export function getTerminalRuntime(): Promise<NonNullable<typeof runtime>> {
  if (runtime) return Promise.resolve(runtime);
  if (starting) return starting;
  starting = (async () => {
    const service = new TerminalConnectionService(createNativeTransport);
    const profiles = new TerminalProfileStore(path.join(app.getPath('userData'), 'terminal', 'profiles.json'));
    const rpc = await startTerminalRpc(service, listSerialPorts);
    process.env.AIONUI_TERMINAL_PORT = String(rpc.port);
    process.env.AIONUI_TERMINAL_TOKEN = rpc.token;
    runtime = {
      service,
      profiles,
      close: async () => {
        await service.dispose();
        await rpc.close();
        delete process.env.AIONUI_TERMINAL_PORT;
        delete process.env.AIONUI_TERMINAL_TOKEN;
        runtime = undefined;
        starting = undefined;
      },
    };
    return runtime;
  })().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/** Quit cleanup must await resource release before Electron exits. */
export async function closeTerminalRuntime(): Promise<void> {
  if (runtime) await runtime.close();
}
