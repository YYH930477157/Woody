import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { TerminalEvent } from '../../../packages/desktop/src/common/types/terminal';

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    writes: Array<string | Uint8Array>;
    options: Record<string, unknown>;
    data?: (text: string) => void;
    cleared: number;
    disposed: boolean;
    cols: number;
    rows: number;
  }>,
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    writes: Array<string | Uint8Array> = [];
    options: Record<string, unknown>;
    data?: (text: string) => void;
    cleared = 0;
    disposed = false;
    cols = 100;
    rows = 30;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData(listener: (text: string) => void) {
      this.data = listener;
      return { dispose: () => undefined };
    }
    write(data: string | Uint8Array) {
      this.writes.push(data);
    }
    clear() {
      this.cleared++;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import ShellTerminal from '../../../packages/desktop/src/renderer/pages/terminal/components/ShellTerminal';

const event = (
  cursor: number,
  data: string,
  direction: TerminalEvent['direction'] = 'incoming',
  error?: string
): TerminalEvent => ({
  cursor,
  timestamp: cursor,
  direction,
  source: direction === 'outgoing' ? 'manual' : 'transport',
  data: Buffer.from(data).toString('base64'),
  byteLength: data.length,
  ...(error ? { error } : {}),
});
const text = (value: string | Uint8Array) => (typeof value === 'string' ? value : Buffer.from(value).toString());

beforeEach(() => {
  xterm.instances.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const props = {
  enabled: true,
  clearKey: 0,
  ariaLabel: 'output',
  disconnectedText: 'Disconnected',
  onInput: vi.fn(),
  onResize: vi.fn(),
};

describe('shell terminal', () => {
  it('writes received bytes once, skips what was sent, and marks a disconnect', () => {
    const first = [event(5, 'PS> '), event(6, 'd', 'outgoing')];
    const { rerender } = render(<ShellTerminal {...props} events={first} />);
    rerender(<ShellTerminal {...props} events={[...first, event(9, 'dir'), event(9, '', 'system', 'exit 1')]} />);
    const [term] = xterm.instances;
    expect(term.writes.map(text)).toEqual(['PS> ', 'dir', expect.stringContaining('Disconnected · exit 1')]);
  });

  it('forwards keystrokes only while manual input is allowed', () => {
    const onInput = vi.fn();
    const { rerender } = render(<ShellTerminal {...props} onInput={onInput} events={[]} />);
    const [term] = xterm.instances;
    term.data?.('l');
    rerender(<ShellTerminal {...props} onInput={onInput} enabled={false} events={[]} />);
    term.data?.('s');
    expect(onInput.mock.calls).toEqual([['l']]);
    expect(term.options.disableStdin).toBe(true);
  });

  it('reports its size once it settles and clears on request', () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const { rerender } = render(<ShellTerminal {...props} onResize={onResize} events={[]} />);
    vi.advanceTimersByTime(200);
    expect(onResize).toHaveBeenCalledWith(100, 30);
    rerender(<ShellTerminal {...props} onResize={onResize} clearKey={1} events={[]} />);
    expect(xterm.instances[0].cleared).toBeGreaterThan(0);
  });
});
