import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GdbSession } from '@/common/types/cmake/gdb';
import { useGdb } from '@/renderer/pages/cmake/useGdb';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  debugAiEnabled: vi.fn(),
  setDebugAiEnabled: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/common/adapter/cmake', () => ({
  cmake: Object.fromEntries(Object.entries(mocks).map(([key, invoke]) => [key, { invoke }])),
}));
const session: GdbSession = {
  id: 'one',
  projectPath: 'D:/one',
  state: 'stopped',
  revision: 1,
  breakpoints: [],
  output: '',
  outputTruncated: false,
  executable: 'a.exe',
  gdbPath: 'gdb.exe',
  buildDirectory: 'build',
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.debug.mockResolvedValue({ session });
  mocks.debugAiEnabled.mockResolvedValue(false);
});
afterEach(cleanup);
describe('shared GDB session state', () => {
  it('invalidates inspected values when the execution revision changes', async () => {
    const { result } = renderHook(() => useGdb('D:/one'));
    await waitFor(() => expect(result.current.session?.id).toBe('one'));
    mocks.debug.mockResolvedValueOnce({ session, value: '42' });
    await act(async () => {
      await result.current.execute({ operation: 'evaluate', expression: 'count' });
    });
    expect(result.current.inspection?.reply.value).toBe('42');
    mocks.debug.mockResolvedValueOnce({ session: { ...session, state: 'running', revision: 2 } });
    await act(async () => {
      await result.current.execute({ operation: 'continue' });
    });
    expect(result.current.inspection).toBeUndefined();
    expect(mocks.debug).toHaveBeenLastCalledWith({ projectPath: 'D:/one', sessionId: 'one', operation: 'continue' });
  });
  it('ignores late operation replies after switching projects', async () => {
    const { result, rerender } = renderHook(({ path }) => useGdb(path), { initialProps: { path: 'D:/one' } });
    await waitFor(() => expect(result.current.session?.id).toBe('one'));
    let finish!: (reply: { session: GdbSession; value: string }) => void;
    mocks.debug.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let operation!: Promise<unknown>;
    act(() => {
      operation = result.current.execute({ operation: 'evaluate', expression: 'count' });
    });
    mocks.debug.mockResolvedValue({});
    rerender({ path: 'D:/two' });
    await act(async () => {
      finish({ session, value: 'old' });
      await operation;
    });
    expect(result.current.session).toBeUndefined();
    expect(result.current.inspection).toBeUndefined();
  });
});
