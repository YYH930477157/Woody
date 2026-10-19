import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridge, type BridgeEventEmitter } from '../../../packages/desktop/src/common/platform/bridge';
import { terminal } from '../../../packages/desktop/src/common/adapter/terminal';

describe('terminal IPC error transport', () => {
  let emitter: BridgeEventEmitter;
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    bridge.adapter({
      on: (value) => {
        emitter = value;
      },
      emit: (name, data) => emitter.emit(name, data),
    });
  });
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  it('rejects an unavailable device without leaving the caller pending', async () => {
    cleanups.push(
      terminal.open.provider(async () => {
        throw new Error('port in use');
      })
    );
    await expect(terminal.open.invoke({ id: 'p', name: 'Shell', kind: 'shell' })).rejects.toThrow('port in use');
  });
  it('transports a synchronous validation failure to the caller', async () => {
    cleanups.push(
      terminal.saveProfile.provider(() => {
        throw new Error('invalid profile');
      })
    );
    await expect(terminal.saveProfile.invoke({ id: 'p', name: '', kind: 'shell' })).rejects.toThrow('invalid profile');
  });
  it('unwraps successful void operations', async () => {
    cleanups.push(terminal.takeover.provider(() => undefined));
    await expect(terminal.takeover.invoke({ id: 'connection' })).resolves.toBeUndefined();
  });
});
