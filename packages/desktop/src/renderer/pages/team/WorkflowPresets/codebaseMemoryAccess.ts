import { ipcBridge } from '@/common';
import { createCodebaseMemorySkillEnsurer } from '@/common/adapter/codebaseMemory/session';
import { mcpService } from '@/common/adapter/ipcBridge';
import { CODEBASE_MEMORY_MCP_NAME, CODEBASE_MEMORY_SKILL_NAME } from '@/common/types/codebaseMemory/constants';
import { isElectronDesktop } from '@renderer/utils/platform';

export type CodebaseMemoryAccess = { mcpId: string; skill: string };

// Module scope: the skill is refreshed once per app run, not once per team.
const ensureSkill = createCodebaseMemorySkillEnsurer({
  list: () => ipcBridge.fs.listAvailableSkills.invoke(),
  importSkill: async (skillPath) => (await ipcBridge.fs.importSkill.invoke({ skill_path: skillPath })).skill_name,
});

/**
 * The codebase memory tools for team members working in `workspace`. Members get the
 * shared catalog entry, which names no project; it binds to the workspace AionCore
 * passes to it. Offered only when that workspace has codebase memory switched on, and
 * never blocks team creation: without it, members simply work without the tools.
 */
export async function resolveCodebaseMemoryAccess(workspace: string): Promise<CodebaseMemoryAccess | undefined> {
  if (!workspace || !isElectronDesktop()) return undefined;
  try {
    const session = await ipcBridge.codebaseMemory.session.invoke({ repoPath: workspace });
    if (!session.enabled || !session.skillPath) return undefined;
    const servers = await mcpService.listServers.invoke();
    const row = servers?.find((server) => server.name === CODEBASE_MEMORY_MCP_NAME && server.enabled);
    if (!row) return undefined;
    const skill = await ensureSkill(session.skillPath);
    return skill === CODEBASE_MEMORY_SKILL_NAME ? { mcpId: row.id, skill } : undefined;
  } catch (error) {
    console.warn('[Team] Codebase memory is unavailable for the team members', error);
    return undefined;
  }
}
