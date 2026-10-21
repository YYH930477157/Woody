import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridge, type BridgeEventEmitter } from '@/common/platform/bridge';
import { cmake } from '@/common/adapter/cmake';

describe('CMake IPC error transport', () => {
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
  it('returns validation errors to the panel instead of leaving its request pending', async () => {
    cleanups.push(
      cmake.inspect.provider(() => {
        throw new Error('cmake.projectMissing');
      })
    );
    await expect(cmake.inspect.invoke({ projectPath: '/missing' })).rejects.toThrow('cmake.projectMissing');
  });
  it('unwraps successful cancellation', async () => {
    cleanups.push(cmake.cancel.provider(() => undefined));
    await expect(cmake.cancel.invoke({ jobId: 'build' })).resolves.toBeUndefined();
  });
});
