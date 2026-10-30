import { useEffect, useState } from 'react';
import type { GitWorkbenchScope } from '@/common/types/sourceControl/workbenchTypes';

type HistoryFilters = { text: string; ref: string; author: string; path: string; since: string; until: string };
const emptyFilters = (): HistoryFilters => ({ text: '', ref: '', author: '', path: '', since: '', until: '' });

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const loadFilters = (key: string): HistoryFilters => {
  const defaults = emptyFilters();
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 16384) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.filters || typeof record.filters !== 'object' || Array.isArray(record.filters))
      return defaults;
    const filters = record.filters as Record<string, unknown>;
    for (const name of Object.keys(defaults) as (keyof HistoryFilters)[]) {
      const value = filters[name];
      if (typeof value === 'string' && value.length <= 2048 && !value.includes('\0') && !/[\r\n]/.test(value)) {
        if ((name === 'since' || name === 'until') && value && !validDate(value)) continue;
        defaults[name] = value;
      }
    }
  } catch {
    // Match the SCM UI store: corrupt or inaccessible preferences degrade to defaults.
  }
  return defaults;
};

/** Per-project/repository localStorage preferences, using the existing SCM UI persistence model. */
export function useHistoryFilters(scope: GitWorkbenchScope) {
  const storageKey = `scm-history-filters:${JSON.stringify([scope.projectId, scope.peId, scope.relativePath])}`;
  const [filters, setFilters] = useState(() => loadFilters(storageKey));
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, filters }));
    } catch {
      // Preferences are optional when storage is unavailable or full.
    }
  }, [storageKey, filters]);
  const setFilter = (name: keyof HistoryFilters, value: string) =>
    setFilters((current) => ({ ...current, [name]: value }));
  return { filters, setFilter, reset: () => setFilters(emptyFilters()) };
}
