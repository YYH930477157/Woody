import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { bridge, type BridgeEventEmitter } from '@/common/platform/bridge';
import { codebaseMemory } from '@/common/adapter/codebaseMemory';

let dispose: (() => void) | undefined;
beforeEach(() => {
  let receiver: BridgeEventEmitter;
  bridge.adapter({
    emit: (name, data) => receiver.emit(name, data),
    on: (emitter) => {
      receiver = emitter;
    },
  });
});
afterEach(() => {
  dispose?.();
});

describe('codebase native bridge error delivery', () => {
  it('delivers Lens errors to the panel', async () => {
    dispose = codebaseMemory.openLens.provider(async () => {
      throw new Error('Lens did not start');
    });
    await expect(codebaseMemory.openLens.invoke({ repoPath: 'D:/repo' })).rejects.toThrow('Lens did not start');
  });
  it('returns configuration errors to the caller rather than leaving the promise pending', async () => {
    dispose = codebaseMemory.get.provider(() => {
      throw new Error('Invalid config');
    });
    await expect(codebaseMemory.get.invoke({ repoPath: 'D:/repo' })).rejects.toThrow('Invalid config');
  });
  it('carries async errors and successful project session responses', async () => {
    dispose = codebaseMemory.session.provider(async ({ repoPath }) => {
      if (!repoPath) throw new Error('Project required');
      return { enabled: false };
    });
    await expect(codebaseMemory.session.invoke({ repoPath: '' })).rejects.toThrow('Project required');
    await expect(codebaseMemory.session.invoke({ repoPath: 'D:/repo' })).resolves.toEqual({ enabled: false });
  });
});
