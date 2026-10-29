import type { ProjectDetailDto } from '@/common/types/project';

/** Bind a new chat to an independent workspace without inventing an execution directory. */
export const workspaceConversationExtra = (
  detail: ProjectDetailDto
): {
  workspace_project_id: string;
  workspace: string;
  custom_workspace: boolean;
} => {
  const root = detail.explorer.entries.find((entry) => entry.pe_id === detail.workspace?.default_pe_id);
  const workspace = root?.runtime_status === 'available' ? root.display_path : '';
  return { workspace_project_id: detail.project_id, workspace, custom_workspace: Boolean(workspace) };
};
