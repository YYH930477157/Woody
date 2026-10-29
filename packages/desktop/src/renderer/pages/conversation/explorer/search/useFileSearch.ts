/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * React binding for project filename search — the shared driver behind both UI
 * skins (the `@`-mention dropdown and the search result panel, search.md §结果
 * UI). Debounces query changes into `fs/search` (the backend cheaply supersedes
 * the prior in-flight search on each new one) and exposes the streaming view.
 *
 * Ensures the monitor runtime is wired (idempotent) so the search port is
 * configured even when the Explorer column is not mounted. The underlying
 * `searchStore` is a single global stream; the two skins are not active at the
 * same time, so they share it (one focused search surface at a time).
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { useLatestRef } from '@renderer/hooks/ui/useLatestRef';

import { type SearchRoot, searchRootsIdentity } from './searchModel';
import { initExplorerRuntime } from '../monitorTransport';
import { cancelSearch, type SearchView, startSearch, useSearch } from './searchStore';

/** Debounce for query→fs/search (search.md §触发: front-end debounce). */
export const FILE_SEARCH_DEBOUNCE_MS = 150;

export type FileSearch = {
  view: SearchView;
  /** Debounced: issue (or supersede) a search for `query` over the current roots. */
  runSearch: (query: string) => void;
  /** Cancel the active search now (box closed / query cleared) and reset. */
  cancel: () => void;
};

export const useFileSearch = (owner: string, roots: SearchRoot[]): FileSearch => {
  const view = useSearch();
  const rootsRef = useLatestRef(roots);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootsKey = searchRootsIdentity(roots);
  const previousRootsKey = useRef(rootsKey);
  const rootsChanged = previousRootsKey.current !== rootsKey;

  // Wire the monitor runtime once (idempotent) so the search port is configured.
  useEffect(() => {
    initExplorerRuntime();
  }, []);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runSearch = useCallback(
    (query: string): void => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startSearch(
          owner,
          rootsRef.current.map(({ pe_id, relative_path }) => ({ pe_id, relative_path })),
          query
        );
      }, FILE_SEARCH_DEBOUNCE_MS);
    },
    [clearTimer, owner, rootsRef]
  );

  const cancel = useCallback((): void => {
    clearTimer();
    cancelSearch(owner); // owner-guarded: only releases if this skin owns the stream
  }, [clearTimer, owner]);

  useLayoutEffect(() => {
    if (previousRootsKey.current === rootsKey) return;
    previousRootsKey.current = rootsKey;
    cancel();
  }, [rootsKey, cancel]);

  // Drop any pending debounce on unmount (do not cancel the shared stream here —
  // another mount of the same surface may own it).
  useEffect(() => clearTimer, [clearTimer]);

  return { view: rootsChanged ? { ...view, hits: [], owner: null } : view, runSearch, cancel };
};
