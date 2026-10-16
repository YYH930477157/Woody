import { describe, expect, it } from 'vitest';

import {
  clearUnavailableSelections,
  getSelectedResources,
  toggleResourceSelection,
  type ScmSelection,
} from '@/renderer/pages/conversation/SourceControl/scmSelectionStore';
import { resourceKey, type ScmResource } from '@/renderer/pages/conversation/SourceControl/scmModel';

const resource = (path: string, state: ScmResource['state'] = 'modified'): ScmResource => ({
  file: { pe_id: 'pe-1', relative_path: path },
  repo_relative_path: path,
  state,
  staged: false,
});

describe('scmSelectionStore helpers', () => {
  it('toggles selectable resources without mutating the previous set', () => {
    const first: ScmSelection = new Set();
    const second = toggleResourceSelection(first, resource('src/a.c'));
    expect(first.size).toBe(0);
    expect(second.size).toBe(1);

    const third = toggleResourceSelection(second, resource('src/a.c'));
    expect(third.size).toBe(0);
  });

  it('does not select conflicted or unknown resources', () => {
    const selection = toggleResourceSelection(new Set(), resource('src/a.c', 'conflicted'));
    expect(selection.size).toBe(0);
    expect(toggleResourceSelection(selection, resource('src/b.c', 'future-state')).size).toBe(0);
  });

  it('returns selected resources in the current status order', () => {
    const a = resource('src/a.c');
    const b = resource('src/b.c');
    const selected = new Set([resourceKey(b), resourceKey(a)]);
    expect(getSelectedResources([a, b], selected)).toEqual([a, b]);
  });

  it('drops selections for resources that disappeared or became blocked', () => {
    const selected = new Set([resourceKey(resource('src/a.c')), resourceKey(resource('src/b.c'))]);
    expect(clearUnavailableSelections([resource('src/a.c', 'modified')], selected)).toEqual(
      new Set([resourceKey(resource('src/a.c'))])
    );
    expect(clearUnavailableSelections([resource('src/a.c', 'conflicted')], selected)).toEqual(new Set());
  });
});
