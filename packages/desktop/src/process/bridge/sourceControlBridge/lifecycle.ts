import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';

/** Keep each canonical project root alive while any renderer owns it. */
export function createRecorderLifecycle(ports: {
  resolveRoot: (scope: GitWorkbenchScope) => Promise<string>;
  start: (scope: GitWorkbenchScope) => Promise<void>;
  stop: (scope: GitWorkbenchScope) => Promise<void>;
}) {
  const owners = new Map<number, Map<string, GitWorkbenchScope>>();
  const active = new Map<string, { scope: GitWorkbenchScope; owners: Set<number> }>();
  let queue = Promise.resolve();
  return {
    set(owner: number, scopes: GitWorkbenchScope[]): Promise<void> {
      const update = queue.then(async () => {
        const next = new Map<string, GitWorkbenchScope>();
        for (const scope of scopes) {
          const root = await ports.resolveRoot(scope);
          next.set(process.platform === 'win32' ? root.toLowerCase() : root, scope);
        }
        const previous = owners.get(owner) ?? new Map<string, GitWorkbenchScope>();
        owners.set(owner, previous);
        for (const [root] of previous) {
          if (next.has(root)) continue;
          const entry = active.get(root);
          if (entry?.owners.size === 1) {
            await ports.stop(entry.scope);
            active.delete(root);
          } else entry?.owners.delete(owner);
          previous.delete(root);
        }
        for (const [root, scope] of next) {
          if (previous.has(root)) continue;
          let entry = active.get(root);
          if (!entry) {
            await ports.start(scope);
            entry = { scope, owners: new Set() };
            active.set(root, entry);
          }
          entry.owners.add(owner);
          previous.set(root, scope);
        }
        if (!previous.size) owners.delete(owner);
      });
      queue = update.catch(() => {});
      return update;
    },
  };
}
