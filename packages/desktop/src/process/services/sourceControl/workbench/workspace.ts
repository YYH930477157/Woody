import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectDetailDto } from '@/common/types/project';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';
import { scopeSchema } from './validation';

/** Resolve canonical roots from the backend's registered project, never renderer-supplied absolute paths. */
export function createProjectRootResolver(loadProject: (id: string) => Promise<ProjectDetailDto>) {
  return async (scope: GitWorkbenchScope): Promise<string> => {
    scopeSchema.parse(scope);
    const project = await loadProject(scope.projectId);
    if (project.project_id !== scope.projectId) throw new Error('Git project identity does not match');
    const entry = project.explorer.entries.find((item) => item.pe_id === scope.peId);
    if (!entry || entry.runtime_status !== 'available')
      throw new Error('Repository root is unavailable in this project');
    const base = await realpath(entry.display_path);
    const root = await realpath(path.resolve(base, scope.relativePath));
    const relative = path.relative(base, root);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error('Repository path escapes its registered project root');
    }
    return root;
  };
}
