import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handler: undefined as undefined | ((input: unknown) => Promise<unknown>) }));
vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: () => ({
      provider: (handler: (input: unknown) => Promise<unknown>) => {
        state.handler = handler;
      },
      invoke: (input: unknown) => state.handler!(input),
    }),
  },
}));
import { replyProvider } from '@/common/platform/replyProvider';
beforeEach(() => {
  state.handler = undefined;
});
describe('native provider error replies', () => {
  it('returns the original value through the transport envelope', async () => {
    const endpoint = replyProvider<number, number>('test');
    endpoint.provider(async (value) => value * 2);
    expect(await endpoint.invoke(4)).toBe(8);
  });
  it('rejects the caller when a provider fails instead of leaving it pending', async () => {
    const endpoint = replyProvider<number, number>('test');
    endpoint.provider(() => {
      throw new Error('repository unavailable');
    });
    await expect(endpoint.invoke(4)).rejects.toThrow('repository unavailable');
  });
});
