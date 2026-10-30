/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SCM panel UI-state store: per-project persistence of collapse / drag-height /
 * view-mode / tree-expansion, mirroring the `explorer-ui:` pattern. These tests pin
 * the persistence contract (restore on reopen, per-project isolation, corrupt-record
 * degradation) and the id-keyed generalization that lets a third section drop in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearSectionHeight,
  getScmUiSnapshot,
  migrateLegacyScmRepository,
  openScmUi,
  resetScmUiStoreForTest,
  setScmMonitorScope,
  setScmSelectedRepo,
  setScmTreeExpanded,
  setScmViewMode,
  setSectionCollapsed,
  setSectionHeight,
} from '@/renderer/pages/conversation/SourceControl/scmUiStore';

const lsKey = (id: string): string => `scm-ui-v2:${id}`;
const readRaw = (id: string): Record<string, unknown> => {
  const raw = localStorage.getItem(lsKey(id));
  return raw ? (JSON.parse(raw) as { preferences: Record<string, unknown> }).preferences : {};
};

beforeEach(() => {
  resetScmUiStoreForTest();
  localStorage.clear();
});
afterEach(() => localStorage.clear());

describe('scmUiStore defaults', () => {
  it('uses a tree for a new managed workspace while preserving an explicit saved list preference', () => {
    openScmUi('managed', 'tree');
    expect(getScmUiSnapshot().viewMode).toBe('tree');
    setScmViewMode('list');
    resetScmUiStoreForTest();
    openScmUi('managed', 'tree');
    expect(getScmUiSnapshot().viewMode).toBe('list');
  });
  it('opens a fresh project expanded, list mode, no heights', () => {
    openScmUi('p1');
    const s = getScmUiSnapshot();
    expect(s.projectId).toBe('p1');
    expect(s.viewMode).toBe('list');
    expect(s.collapsed).toEqual({});
    expect(s.heights).toEqual({});
    expect(s.treeExpanded).toEqual([]);
    expect(s.monitorScope).toBe('project');
  });

  it('is idempotent on reopen of the same project (does not reset live state)', () => {
    openScmUi('p1');
    setScmViewMode('tree');
    openScmUi('p1'); // same id → no-op
    expect(getScmUiSnapshot().viewMode).toBe('tree');
  });
});

describe('scmUiStore persistence (per project)', () => {
  it('restores the selected repository without carrying it into another project', () => {
    openScmUi('p1');
    setScmSelectedRepo('repo-library');
    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().selectedRepoId).toBe('repo-library');
    openScmUi('p2');
    expect(getScmUiSnapshot().selectedRepoId).toBeNull();
    localStorage.setItem(lsKey('bad'), JSON.stringify({ selectedRepoId: 42 }));
    openScmUi('bad');
    expect(getScmUiSnapshot().selectedRepoId).toBeNull();
  });

  it('persists and restores collapse state per section id', () => {
    openScmUi('p1');
    setSectionCollapsed('repositories', true);
    expect(readRaw('p1').collapsed).toEqual({ repositories: true });

    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().collapsed).toEqual({ repositories: true });
  });

  it('persists and restores a dragged section height, and clears it back to natural', () => {
    openScmUi('p1');
    setSectionHeight('repositories', 180);
    expect(getScmUiSnapshot().heights).toEqual({ repositories: 180 });

    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().heights).toEqual({ repositories: 180 });

    clearSectionHeight('repositories');
    expect(getScmUiSnapshot().heights).toEqual({});
    expect(readRaw('p1').heights).toEqual({});
  });

  it('persists and restores view mode', () => {
    openScmUi('p1');
    setScmViewMode('tree');
    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().viewMode).toBe('tree');
  });

  it('migrates legacy preferences into a versioned record without deleting the legacy key', () => {
    const legacy = {
      collapsed: { repositories: true },
      treeExpanded: ['src'],
      viewMode: 'tree',
      monitorScope: 'software',
      selectedRepoId: 'legacy-repo',
    };
    localStorage.setItem('scm-ui:p1', JSON.stringify(legacy));

    openScmUi('p1');
    expect(JSON.parse(localStorage.getItem(lsKey('p1'))!)).toMatchObject({
      version: 2,
      preferences: legacy,
    });
    expect(JSON.parse(localStorage.getItem('scm-ui:p1')!)).toEqual(legacy);
    migrateLegacyScmRepository('p1', ['legacy-repo', 'new-repo']);
    expect(getScmUiSnapshot().selectedRepoId).toBe('legacy-repo');
  });

  it('drops a migrated repository selection that no longer exists in this project', () => {
    localStorage.setItem('scm-ui:p1', JSON.stringify({ selectedRepoId: 'gone' }));
    openScmUi('p1');
    migrateLegacyScmRepository('p1', ['repo-a']);
    expect(getScmUiSnapshot().selectedRepoId).toBeNull();
    expect(readRaw('p1').selectedRepoId).toBeNull();
    expect(localStorage.getItem('scm-ui:p1')).not.toBeNull();
  });

  it('does not resurrect legacy preferences after the versioned record is corrupt', () => {
    localStorage.setItem('scm-ui:p1', JSON.stringify({ viewMode: 'tree' }));
    localStorage.setItem(lsKey('p1'), '{broken');
    openScmUi('p1');
    expect(getScmUiSnapshot().viewMode).toBe('list');
  });

  it('persists and restores the monitor scope per project', () => {
    openScmUi('p1');
    setScmMonitorScope('software');
    expect(getScmUiSnapshot().monitorScope).toBe('software');
    expect(readRaw('p1').monitorScope).toBe('software');

    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().monitorScope).toBe('software');
  });

  it('persists tree expansion only once the user overrides the expand-all default', () => {
    openScmUi('p1');
    // Untouched: no stored override (null default), snapshot is empty = "expand all".
    expect(readRaw('p1').treeExpanded).toBeUndefined();
    setScmTreeExpanded(['src', 'src/nested']);
    expect(readRaw('p1').treeExpanded).toEqual(['src', 'src/nested']);

    resetScmUiStoreForTest();
    openScmUi('p1');
    expect(getScmUiSnapshot().treeExpanded).toEqual(['src', 'src/nested']);
  });

  it('keeps two projects isolated', () => {
    openScmUi('p1');
    setScmViewMode('tree');
    setSectionCollapsed('changes', true);

    openScmUi('p2'); // different id → fresh
    expect(getScmUiSnapshot().viewMode).toBe('list');
    expect(getScmUiSnapshot().collapsed).toEqual({});

    // p1's record is untouched.
    expect(readRaw('p1').viewMode).toBe('tree');
  });
});

describe('scmUiStore corrupt-record degradation', () => {
  it('falls back to defaults on unparseable JSON', () => {
    localStorage.setItem(lsKey('p1'), '{not json');
    openScmUi('p1');
    expect(getScmUiSnapshot().viewMode).toBe('list');
    expect(getScmUiSnapshot().collapsed).toEqual({});
  });

  it('drops malformed fields (bad height, unknown view mode) without throwing', () => {
    localStorage.setItem(
      lsKey('p1'),
      JSON.stringify({
        heights: { repositories: -5, changes: 'tall' },
        viewMode: 'mosaic',
        monitorScope: 'outside',
        collapsed: { repositories: 'yes' },
      })
    );
    openScmUi('p1');
    const s = getScmUiSnapshot();
    expect(s.heights).toEqual({}); // -5 and 'tall' both rejected
    expect(s.viewMode).toBe('list'); // 'mosaic' rejected
    expect(s.monitorScope).toBe('project'); // 'outside' rejected
    expect(s.collapsed).toEqual({}); // 'yes' (non-boolean) rejected
  });

  it('rejects a non-positive height at the setter too', () => {
    openScmUi('p1');
    setSectionHeight('repositories', 0);
    setSectionHeight('repositories', Number.NaN);
    expect(getScmUiSnapshot().heights).toEqual({});
  });
});

describe('scmUiStore generalization (id-keyed, not fixed to two sections)', () => {
  it('stores collapse/height for an arbitrary future section id (e.g. graph)', () => {
    openScmUi('p1');
    setSectionCollapsed('graph', true);
    setSectionHeight('graph', 120);
    expect(getScmUiSnapshot().collapsed.graph).toBe(true);
    expect(getScmUiSnapshot().heights.graph).toBe(120);
  });
});
