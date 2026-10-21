import { useCallback, useState } from 'react';
import type { TerminalNewlineMode, TerminalOutputMode } from '@/common/terminal/stream';
import type { TerminalSendRequest } from '@/common/types/terminal';
import type { TerminalBackspace } from './terminalView';

export type TerminalKind = 'serial' | 'shell';
export type TerminalEncoding = TerminalSendRequest['encoding'];
export type TerminalEnding = TerminalSendRequest['ending'];

export type TerminalViewPreferences = {
  display: TerminalOutputMode;
  timestamps: boolean;
  /** Received chunks closer than this join one frame in HEX views. */
  frameGapMs: number;
  receiveNewlines: TerminalNewlineMode;
  encoding: TerminalEncoding;
  ending: TerminalEnding;
  /** Byte Backspace sends when typing straight to the device. */
  backspace: TerminalBackspace;
};

export type QuickCommand = {
  id: string;
  kind: TerminalKind;
  name: string;
  data: string;
  encoding: TerminalEncoding;
  ending: TerminalEnding;
};

export type HistoryEntry = { data: string; encoding: TerminalEncoding };

const DEFAULTS: Record<TerminalKind, TerminalViewPreferences> = {
  serial: {
    display: 'hex',
    timestamps: true,
    frameGapMs: 30,
    receiveNewlines: 'keep',
    encoding: 'hex',
    ending: 'none',
    backspace: 'ctrlH',
  },
  shell: {
    display: 'text',
    timestamps: false,
    frameGapMs: 30,
    receiveNewlines: 'keep',
    encoding: 'utf8',
    ending: 'cr',
    backspace: 'del',
  },
};
const HISTORY_LIMIT = 50;
const KEYS = {
  view: (kind: TerminalKind) => `woody.terminal.view.${kind}`,
  history: (kind: TerminalKind) => `woody.terminal.history.${kind}`,
  quick: 'woody.terminal.quickCommands',
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are a convenience; the terminal keeps working without storage.
  }
}

/** Per-kind view settings, send history and quick commands, remembered on this device. */
export function useTerminalPreferences() {
  const [view, setView] = useState<Record<TerminalKind, TerminalViewPreferences>>(() => ({
    serial: { ...DEFAULTS.serial, ...load<Partial<TerminalViewPreferences>>(KEYS.view('serial'), {}) },
    shell: { ...DEFAULTS.shell, ...load<Partial<TerminalViewPreferences>>(KEYS.view('shell'), {}) },
  }));
  const [history, setHistory] = useState<Record<TerminalKind, HistoryEntry[]>>(() => ({
    serial: load<HistoryEntry[]>(KEYS.history('serial'), []),
    shell: load<HistoryEntry[]>(KEYS.history('shell'), []),
  }));
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>(() => load<QuickCommand[]>(KEYS.quick, []));

  const updateView = useCallback((kind: TerminalKind, patch: Partial<TerminalViewPreferences>) => {
    setView((previous) => {
      const next = { ...previous, [kind]: { ...previous[kind], ...patch } };
      store(KEYS.view(kind), next[kind]);
      return next;
    });
  }, []);

  const remember = useCallback((kind: TerminalKind, entry: HistoryEntry) => {
    if (!entry.data.trim()) return;
    setHistory((previous) => {
      const entries = [
        entry,
        ...previous[kind].filter((item) => item.data !== entry.data || item.encoding !== entry.encoding),
      ].slice(0, HISTORY_LIMIT);
      store(KEYS.history(kind), entries);
      return { ...previous, [kind]: entries };
    });
  }, []);

  const saveQuickCommand = useCallback((command: Omit<QuickCommand, 'id'>) => {
    setQuickCommands((previous) => {
      const next = [...previous, { ...command, id: crypto.randomUUID() }];
      store(KEYS.quick, next);
      return next;
    });
  }, []);

  const removeQuickCommand = useCallback((id: string) => {
    setQuickCommands((previous) => {
      const next = previous.filter((command) => command.id !== id);
      store(KEYS.quick, next);
      return next;
    });
  }, []);

  return { view, updateView, history, remember, quickCommands, saveQuickCommand, removeQuickCommand };
}
