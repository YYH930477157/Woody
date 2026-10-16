import { isActionable, resourceKey, type ScmResource } from './scmModel';

export type ScmSelection = ReadonlySet<string>;

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
