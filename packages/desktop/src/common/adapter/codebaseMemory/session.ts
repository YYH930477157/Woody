import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { CODEBASE_MEMORY_MCP_NAME, CODEBASE_MEMORY_SKILL_NAME } from '@/common/types/codebaseMemory/constants';
import type { CodebaseMemorySession } from '@/common/types/codebaseMemory/types';

type Selection = {
  repoPath: string;
  catalog: IMcpServer[];
  servers: ISessionMcpServer[];
  selectedIds?: string[];
  skillSelection?: string[];
  excludedSkills?: string[];
};
type Dependencies = {
  resolve: (repoPath: string) => Promise<CodebaseMemorySession>;
  ensureSkill: (skillPath: string) => Promise<string>;
};
type SkillLibrary = {
  list: () => Promise<Array<{ name: string }>>;
  importSkill: (skillPath: string) => Promise<string>;
};

/**
 * Importing copies the skill into the user's library, so a library that already
 * holds it would keep the text of whichever Woody first imported it. The returned
 * function re-imports once per app run, then trusts the library's copy.
 */
export function createCodebaseMemorySkillEnsurer(library: SkillLibrary): (skillPath: string) => Promise<string> {
  let refreshed = false;
  const installed = async () =>
    (await library.list()).some((skill) => skill.name === CODEBASE_MEMORY_SKILL_NAME)
      ? CODEBASE_MEMORY_SKILL_NAME
      : undefined;
  return async (skillPath) => {
    if (refreshed) {
      const name = await installed();
      if (name) return name;
    }
    try {
      const name = await library.importSkill(skillPath);
      refreshed = true;
      return name;
    } catch (error) {
      // A failed refresh must not cost the conversation a skill it already has.
      const name = await installed();
      if (name) return name;
      throw error;
    }
  };
}

/** Replace the generic catalog entry with a project-bound snapshot, respecting explicit opt-outs. */
export async function prepareCodebaseMemorySession(selection: Selection, deps: Dependencies) {
  const servers = selection.servers.filter((server) => server.name !== CODEBASE_MEMORY_MCP_NAME);
  const result = { servers, skills: [] as string[] };
  const registered = selection.catalog.find((server) => server.name === CODEBASE_MEMORY_MCP_NAME);
  if (!selection.repoPath || !registered?.enabled) return result;
  if (selection.selectedIds !== undefined && !selection.selectedIds.includes(registered.id)) return result;
  const session = await deps.resolve(selection.repoPath);
  if (!session.enabled) return result;
  if (!session.transport) throw new Error('Codebase memory project transport is unavailable');
  servers.push({ id: registered.id, name: registered.name, transport: session.transport });
  if (selection.excludedSkills?.includes(CODEBASE_MEMORY_SKILL_NAME)) return result;
  if (selection.skillSelection !== undefined && !selection.skillSelection.includes(CODEBASE_MEMORY_SKILL_NAME)) {
    return result;
  }
  if (!session.skillPath) throw new Error('Bundled codebase memory skill is unavailable');
  const skillName = await deps.ensureSkill(session.skillPath);
  if (skillName !== CODEBASE_MEMORY_SKILL_NAME) throw new Error('Bundled codebase memory skill import failed');
  result.skills.push(skillName);
  return result;
}
