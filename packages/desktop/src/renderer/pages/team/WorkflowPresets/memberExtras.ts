import { ipcBridge } from '@/common';
import type { SessionFilesRef, SessionFolderNames } from '@/common/adapter/ipcBridge';
import type { TeamMemberExtras } from '@/common/adapter/teamMapper';
import { isElectronDesktop } from '@renderer/utils/platform';
import { resolveCodebaseMemoryAccess } from './codebaseMemoryAccess';

/** The same wait as a new chat: the folder is a convenience, never a reason to block creation. */
const TEAM_FOLDER_TIMEOUT_MS = 3000;

/** The one folder a team's members keep the files they create in, named after the team. */
async function prepareTeamFolder(
  workspace: string,
  teamName: string,
  names: SessionFolderNames
): Promise<SessionFilesRef | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prepared = ipcBridge.sessionFiles.prepare.invoke({ workspace, title: teamName, names });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TEAM_FOLDER_TIMEOUT_MS);
    });
    return (await Promise.race([prepared, timeout])) ?? undefined;
  } catch (error) {
    console.warn('[Team] The team files folder is unavailable:', error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What every member of a new team gets on top of its own assistant: the codebase memory skill
 * and server when the workspace has codebase memory switched on, since members picked by hand
 * would otherwise work without them, and one folder for the files the whole team creates.
 * Each part is optional; a part that fails is left out and the team is still created.
 */
export async function prepareTeamMemberExtras(params: {
  workspace: string;
  teamName: string;
  names: SessionFolderNames;
  /** Template roles are copies that already carry the codebase memory tools. */
  withCodebaseMemory: boolean;
}): Promise<TeamMemberExtras | undefined> {
  const { workspace, teamName, names, withCodebaseMemory } = params;
  if (!workspace || !isElectronDesktop()) return undefined;
  const [codebase, folder] = await Promise.all([
    withCodebaseMemory ? resolveCodebaseMemoryAccess(workspace) : Promise.resolve(undefined),
    prepareTeamFolder(workspace, teamName, names),
  ]);
  const extras: TeamMemberExtras = {
    ...(codebase ? { skills: [codebase.skill], mcp_server_ids: [codebase.mcpId] } : {}),
    ...(folder ? { session_files: folder } : {}),
  };
  return Object.keys(extras).length > 0 ? extras : undefined;
}
