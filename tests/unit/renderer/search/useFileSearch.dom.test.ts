import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/renderer/pages/conversation/explorer/monitorTransport', () => ({ initExplorerRuntime: vi.fn() }));
import { useFileSearch, FILE_SEARCH_DEBOUNCE_MS } from '@/renderer/pages/conversation/explorer/search/useFileSearch';
import {
  applySearchMatch,
  configureSearchStore,
  resetSearchStoreForTest,
} from '@/renderer/pages/conversation/explorer/search/searchStore';

beforeEach(() => {
  vi.useFakeTimers();
  resetSearchStoreForTest();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('search binding changes', () => {
  it('clears old matches immediately and rejects late matches after a same-id relocation', () => {
    const cancel = vi.fn();
    const search = vi.fn(() => ({ id: 1, result: new Promise<never>(() => {}) }));
    configureSearchStore({ search, cancel, abandon: vi.fn() });
    const { result, rerender } = renderHook(
      ({ path }) => useFileSearch('panel', [{ pe_id: 'stable', relative_path: '', rootPath: path }]),
      { initialProps: { path: 'C:/old' } }
    );
    act(() => {
      result.current.runSearch('file');
      vi.advanceTimersByTime(FILE_SEARCH_DEBOUNCE_MS);
    });
    act(() =>
      applySearchMatch({ search_id: 1, matches: [{ pe_id: 'stable', relative_path: 'old.txt', name: 'file' }] })
    );
    expect(result.current.view.hits).toHaveLength(1);
    rerender({ path: 'D:/new' });
    act(() =>
      applySearchMatch({ search_id: 1, matches: [{ pe_id: 'stable', relative_path: 'late.txt', name: 'file' }] })
    );
    expect(result.current.view.hits).toEqual([]);
    expect(cancel).toHaveBeenCalledWith(1);
  });
});
