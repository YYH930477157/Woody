import { describe, expect, it } from 'vitest';
import { workspaceConversationExtra } from '@/renderer/utils/workspace/managedWorkspace';
import type { ProjectDetailDto } from '@/common/types/project';

const detail: ProjectDetailDto = {
  project_id: 'workspace-A',
  name: 'Code and requirements',
  explorer: {
    workspace_pe_id: '',
    entries: [
      { pe_id: 'code', role: 'attached', display_path: 'D:\\Code', order_index: 0, runtime_status: 'available' },
      { pe_id: 'docs', role: 'attached', display_path: 'D:\\Docs', order_index: 1, runtime_status: 'available' },
    ],
  },
  workspace: { managed: true, config_path: null, dirty: true, default_pe_id: 'docs' },
};
describe('managed workspace conversation binding', () => {
  it('binds by workspace identity and uses the selected default rather than first root', () => {
    expect(workspaceConversationExtra(detail)).toEqual({
      workspace_project_id: 'workspace-A',
      workspace: 'D:\\Docs',
      custom_workspace: true,
    });
  });
  it('does not invent a default for an empty or default-less workspace', () => {
    expect(
      workspaceConversationExtra({ ...detail, workspace: { ...detail.workspace!, default_pe_id: null } }).workspace
    ).toBe('');
  });
  it('keeps workspace identity when its default directory is missing', () => {
    const missing = {
      ...detail,
      explorer: {
        ...detail.explorer,
        entries: detail.explorer.entries.map((e) => ({ ...e, runtime_status: 'missing' as const })),
      },
    };
    expect(workspaceConversationExtra(missing)).toMatchObject({ workspace_project_id: 'workspace-A', workspace: '' });
  });
});
