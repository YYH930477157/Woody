import { isActionable, resourceKey, type ScmRepository, type ScmResource } from './scmModel';

export type ScmSelection = ReadonlySet<string>;

/** Resolve nested repositories relative to their owning explorer entry. */
export const resolveRepositoryPath = (repo: ScmRepository, repoPaths: Record<string, string>): string | undefined => {
  const explicitPath = repoPaths[repo.repo_id];
  if (explicitPath) return explicitPath;
  const rootPath = repoPaths[repo.root.pe_id];
  if (!rootPath || !repo.root.relative_path) return rootPath;
  return `${rootPath.replace(/[\\/]+$/, '')}/${repo.root.relative_path}`;
};

export const toggleResourceSelection = (selection: ScmSelection, resource: ScmResource): Set<string> => {
  const next = new Set(selection);
  if (!isActionable(resource)) return next;
  const key = resourceKey(resource);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

export const getSelectedResources = (resources: ScmResource[], selection: ScmSelection): ScmResource[] =>
  resources.filter((resource) => selection.has(resourceKey(resource)) && isActionable(resource));

export const clearUnavailableSelections = (resources: ScmResource[], selection: ScmSelection): Set<string> => {
  const available = new Set(resources.filter(isActionable).map(resourceKey));
  return new Set([...selection].filter((key) => available.has(key)));
};
