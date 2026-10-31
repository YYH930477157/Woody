import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ read: vi.fn(), sync: vi.fn(), mutate: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    gitStorage: {
      changelistRead: { invoke: api.read },
      changelistSync: { invoke: api.sync },
      changelistMutate: { invoke: api.mutate },
    },
  },
}));

import {
  changelistChanges,
  useChangelists,
} from '@/renderer/pages/conversation/SourceControl/Workbench/Storage/Changelists';
import { fileKey, type ScmResource } from '@/renderer/pages/conversation/SourceControl/scmModel';

const scope = { projectId: 'p', peId: 'e', relativePath: '' };
const saved = (assignments: Record<string, string>) => ({
  activeId: 'default',
  lists: [
    { id: 'default', name: 'Changes', comment: '' },
    { id: 'custom', name: 'Later', comment: '' },
  ],
  assignments,
});
const resource = (staged: boolean): ScmResource =>
  ({
    file: { pe_id: 'e', relative_path: 'src/a.ts' },
    repo_relative_path: 'src/a.ts',
    staged,
  }) as unknown as ScmResource;

describe('useChangelists', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps saved assignments while the repository status is still loading', async () => {
    api.read.mockResolvedValue(saved({ a: 'custom' }));

    const { result } = renderHook(() => useChangelists(scope, undefined));

    await waitFor(() => expect(result.current.data?.assignments).toEqual({ a: 'custom' }));
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('syncs when the status is known, even if nothing has changed', async () => {
    api.sync.mockResolvedValue(saved({}));

    renderHook(() => useChangelists(scope, []));

    await waitFor(() => expect(api.sync).toHaveBeenCalledWith({ scope, changes: [] }));
  });

  it('keeps showing the lists during a reload, so a filtered view does not empty', async () => {
    api.sync.mockResolvedValue(saved({ a: 'custom' }));
    const { result, rerender } = renderHook(({ changes }) => useChangelists(scope, changes), {
      initialProps: { changes: [{ key: 'a', path: 'a' }] },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.setFilter('custom'));

    let finish: (value: unknown) => void = () => {};
    api.sync.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    rerender({
      changes: [
        { key: 'a', path: 'a' },
        { key: 'b', path: 'b' },
      ],
    });

    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.includes('a')).toBe(true);
    await act(async () => finish(saved({ a: 'custom', b: 'default' })));
  });

  it('reports a failed read', async () => {
    api.read.mockRejectedValue(new Error('store unavailable'));

    const { result } = renderHook(() => useChangelists(scope, undefined));

    await waitFor(() => expect(result.current.error).toBe('store unavailable'));
  });
});

describe('changelistChanges', () => {
  it('lists a partly staged file once, under a key that survives staging', () => {
    const changes = changelistChanges([resource(false), resource(true)]);

    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe(fileKey(resource(true)));
    expect(fileKey(resource(true))).toBe(fileKey(resource(false)));
  });
});
