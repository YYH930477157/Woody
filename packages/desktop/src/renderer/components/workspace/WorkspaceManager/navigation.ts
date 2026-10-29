/** Compare authoritative project identities before asking to leave a workspace. */
export const canLeaveWorkspaceForRoute = async (
  currentProjectId: string | null,
  pathname: string,
  selectedProjectId: string | null,
  loadConversationProject: (id: string) => Promise<string | null>,
  confirmLeave: (id: string) => Promise<boolean>
): Promise<boolean> => {
  if (!currentProjectId) return true;
  const match = /^\/conversation\/([^/]+)\/?$/.exec(pathname);
  const next = match
    ? await loadConversationProject(decodeURIComponent(match[1]))
    : pathname === '/guid'
      ? selectedProjectId
      : null;
  return next === currentProjectId || (await confirmLeave(currentProjectId));
};
