import { describe, expect, it } from 'vitest';
import type { ProjectDetailDto } from '@/common/types/project';
import {
  buildWorkspaceUpdate,
  moveWorkspaceRoot,
  removeWorkspaceRoot,
  searchableWorkspaceRoots,
  dirtyRootTabs,
  pathToFileUri,
} from '@/renderer/components/workspace/WorkspaceManager/model';

const detail: ProjectDetailDto = {
  project_id: 'p',
  name: 'Workspace',
  workspace: { managed: true, dirty: true, config_path: null, default_pe_id: 'b' },
  explorer: {
    workspace_pe_id: 'a',
    entries: [
      {
        pe_id: 'a',
        role: 'workspace',
        display_name: 'App',
        display_path: 'C:\\one#test',
        order_index: 0,
        runtime_status: 'available',
      },
      {
        pe_id: 'b',
        role: 'attached',
        display_name: 'App',
        display_path: 'D:\\two',
        order_index: 1,
        runtime_status: 'missing',
      },
    ],
  },
};
describe('workspace editing', () => {
  it('reorders roots without changing default or identity', () => {
    const update = moveWorkspaceRoot(buildWorkspaceUpdate(detail), 'b', -1);
    expect(update.roots.map((r) => r.pe_id)).toEqual(['b', 'a']);
    expect(update.default_pe_id).toBe('b');
  });
  it('removing the default clears it instead of silently choosing another root', () => {
    expect(removeWorkspaceRoot(buildWorkspaceUpdate(detail), 'b').default_pe_id).toBeNull();
  });
  it('permits an empty managed workspace', () => {
    const update = removeWorkspaceRoot(removeWorkspaceRoot(buildWorkspaceUpdate(detail), 'a'), 'b');
    expect(update.roots).toEqual([]);
  });
  it('does not change order for an out of range move', () => {
    expect(moveWorkspaceRoot(buildWorkspaceUpdate(detail), 'a', -1).roots.map((r) => r.pe_id)).toEqual(['a', 'b']);
  });
  it('excludes unavailable roots from filename search', () => {
    expect(searchableWorkspaceRoots(detail).map((r) => r.pe_id)).toEqual(['a']);
  });
  it('preserves reserved path characters when forming URIs', () => {
    expect(pathToFileUri('C:\\one#test\\a%b?c')).toBe('file:///C:/one%23test/a%25b%3Fc');
  });
  it('finds unsaved previews by stable root identity only', () => {
    expect(
      dirtyRootTabs(
        [
          {
            id: 'dirty',
            isDirty: true,
            metadata: { fileRef: { kind: 'project', pe_id: 'a', relative_path: 'a.txt' } },
          },
          {
            id: 'clean',
            isDirty: false,
            metadata: { fileRef: { kind: 'project', pe_id: 'a', relative_path: 'b.txt' } },
          },
          {
            id: 'other',
            isDirty: true,
            metadata: { fileRef: { kind: 'project', pe_id: 'b', relative_path: 'a.txt' } },
          },
        ],
        ['a']
      ).map((t) => t.id)
    ).toEqual(['dirty']);
  });
});
