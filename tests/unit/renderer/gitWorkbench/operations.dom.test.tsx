import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ operate: vi.fn(), cancel: vi.fn(), refs: vi.fn(), refresh: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({
  gitWorkbench: { operate: { invoke: api.operate }, cancel: { invoke: api.cancel }, refs: { invoke: api.refs } },
}));
vi.mock('@/renderer/pages/conversation/SourceControl/scmStore', () => ({ refreshRepo: api.refresh }));
import { useOperations } from '@/renderer/pages/conversation/SourceControl/Workbench/Operations/useOperations';
import { Operations } from '@/renderer/pages/conversation/SourceControl/Workbench/Operations';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const scope = { projectId: 'p', peId: 'root', relativePath: '' };
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.refs.mockResolvedValue([]);
  api.operate.mockImplementation(async ({ request }) => ({
    state: 'complete',
    output: '',
    data: request.kind === 'inspect' ? { head: 'a'.repeat(40), branch: 'main' } : {},
  }));
  api.refresh.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue({ cancelled: true });
});
describe('native repository actions', () => {
  it('cancels only the currently running remote request', async () => {
    const { result } = renderHook(() => useOperations(scope, 'repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finish!: (value: unknown) => void;
    api.operate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let request!: Promise<void>;
    act(() => {
      request = result.current.run({ kind: 'fetch', remote: 'origin' });
    });
    const input = api.operate.mock.calls.at(-1)![0];
    expect(input.operationId).toEqual(expect.any(String));
    await act(() => result.current.cancel());
    expect(api.cancel).toHaveBeenCalledWith({ scope, operationId: input.operationId });
    await act(async () => {
      finish({ state: 'cancelled', output: 'cancelled' });
      await request;
    });
    expect(result.current.busy).toBe(false);
  });
  it('asks for confirmation before deleting a branch', async () => {
    api.refs.mockResolvedValue([
      { name: 'feature', fullName: 'refs/heads/feature', type: 'local', hash: 'b'.repeat(40) },
    ]);
    render(<Operations scope={scope} repoId='repo' />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'conversation.gitWorkbench.operations.branch.delete' })
      ).not.toBeDisabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'conversation.gitWorkbench.operations.branch.delete' }));
    expect(api.operate.mock.calls.some(([arg]) => arg.request.kind === 'branch.delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.operate.mock.calls.some(([arg]) => arg.request.kind === 'branch.delete')).toBe(false);
  });
  it('loads local state without automatically fetching or pushing', async () => {
    const { result } = renderHook(() => useOperations(scope, 'repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.head).toBe('a'.repeat(40));
    expect(api.operate.mock.calls.map(([arg]) => arg.request.kind).toSorted()).toEqual([
      'inspect',
      'remote.list',
      'stash.list',
      'worktree.list',
    ]);
  });
  it('does not duplicate mutations and refreshes SCM even after a failed action', async () => {
    const { result } = renderHook(() => useOperations(scope, 'repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finish!: (value: unknown) => void;
    api.operate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let request!: Promise<void>;
    act(() => {
      request = result.current.run({ kind: 'fetch', remote: 'origin' });
    });
    await act(() => result.current.run({ kind: 'fetch', remote: 'origin' }));
    expect(api.operate.mock.calls.filter(([arg]) => arg.request.kind === 'fetch')).toHaveLength(1);
    await act(async () => {
      finish({ state: 'error', output: 'offline' });
      await request;
    });
    expect(result.current.outcome?.output).toBe('offline');
    expect(api.refresh).toHaveBeenCalledWith('repo');
  });
  it('ignores a delayed mutation result after the repository changes', async () => {
    const { result, rerender } = renderHook(({ selected }) => useOperations(selected, selected.peId), {
      initialProps: { selected: scope },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    let finish!: (value: unknown) => void;
    api.operate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let request!: Promise<void>;
    act(() => {
      request = result.current.run({ kind: 'fetch', remote: 'origin' });
    });
    rerender({ selected: { ...scope, peId: 'other' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      finish({ state: 'error', output: 'old error' });
      await request;
    });
    expect(result.current.outcome).toBeUndefined();
  });
});
