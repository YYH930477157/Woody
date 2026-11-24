import React, { useEffect, useRef } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalEvent } from '@/common/types/terminal';
import { rawBytes } from '../terminalView';

const RESIZE_DELAY_MS = 120;

/** The console palette from the theme variables, so the shell matches the other consoles. */
function consoleTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim() || undefined;
  return {
    background: color('--console-bg'),
    foreground: color('--console-fg'),
    cursor: color('--console-fg'),
    cursorAccent: color('--console-bg'),
    selectionBackground: color('--console-selection'),
    red: color('--console-error'),
    brightRed: color('--console-error'),
    yellow: color('--console-warning'),
    brightYellow: color('--console-warning'),
    green: color('--console-success'),
    brightGreen: color('--console-success'),
    blue: color('--console-info'),
    brightBlue: color('--console-info'),
    brightBlack: color('--console-muted'),
  };
}

/**
 * An interactive shell: received bytes go straight into a terminal emulator, and keystrokes go straight to the
 * shell. The shell echoes what it receives, so outgoing history is never drawn here.
 */
export default function ShellTerminal({
  events,
  enabled,
  clearKey,
  ariaLabel,
  disconnectedText,
  onInput,
  onResize,
}: {
  events: TerminalEvent[];
  /** Manual input is allowed: the session is open and not held by AI. */
  enabled: boolean;
  /** Changes when the user clears the view. */
  clearKey: number;
  ariaLabel: string;
  /** Written as a dimmed divider where the connection dropped. */
  disconnectedText: string;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  // A zero-byte event (a disconnect) shares its cursor with the event before it, so count events per cursor.
  const written = useRef({ cursor: -1, count: 0 });
  const callbacks = useRef({ onInput, onResize, enabled });
  useEffect(() => {
    callbacks.current = { onInput, onResize, enabled };
  }, [onInput, onResize, enabled]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Cascadia Mono, Consolas, "SFMono-Regular", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: consoleTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      // Ctrl+C copies a selection and interrupts otherwise; Ctrl+V is left to the browser's paste event.
      if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch((): void => undefined);
        term.clearSelection();
        return false;
      }
      return key !== 'v';
    });
    const input = term.onData((data) => {
      if (callbacks.current.enabled) callbacks.current.onInput(data);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let size = '';
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = `${term.cols}x${term.rows}`;
        if (next === size) return;
        size = next;
        callbacks.current.onResize(term.cols, term.rows);
      }, RESIZE_DELAY_MS);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    // Follow light/dark switches: the console palette differs slightly between them.
    const themeObserver = new MutationObserver(() => {
      term.options.theme = consoleTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
      written.current = { cursor: -1, count: 0 };
    };
  }, []);

  useEffect(() => {
    terminal.current?.clear();
  }, [clearKey]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = !enabled;
    term.options.cursorBlink = enabled;
  }, [enabled]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const mark = written.current;
    let runCursor = -1;
    let run = 0;
    for (const event of events) {
      if (event.cursor !== runCursor) {
        runCursor = event.cursor;
        run = 0;
      }
      run++;
      if (event.cursor < mark.cursor || (event.cursor === mark.cursor && run <= mark.count)) continue;
      mark.cursor = event.cursor;
      mark.count = run;
      if (event.direction === 'incoming') term.write(rawBytes(event.data));
      else if (event.direction === 'system')
        term.write(`\r\n\x1b[90m── ${[disconnectedText, event.error].filter(Boolean).join(' · ')} ──\x1b[0m\r\n`);
    }
  }, [events, disconnectedText]);

  return (
    <div
      className='flex-1 min-h-0 overflow-hidden rd-8px border border-[var(--console-border)] bg-[var(--console-bg)] px-10px py-8px'
      aria-label={ariaLabel}
      role='group'
    >
      <div ref={host} className='h-full w-full' />
    </div>
  );
}
