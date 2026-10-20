import type { TerminalNewlineMode, TerminalOutputMode } from '@/common/terminal/stream';
import { createNewlineTransformer, formatHexdump } from '@/common/terminal/stream';
import type { TerminalEvent, TerminalProfile } from '@/common/types/terminal';

// ANSI terminal escape sequences intentionally contain control characters.
/* eslint-disable no-control-regex */
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export function rawBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Normal serial typing leaves echo to the device; otherwise manual TX is drawn from the ordered history. */
export function displayedTerminalEvents(events: TerminalEvent[], hideManualOutgoing: boolean): TerminalEvent[] {
  return hideManualOutgoing
    ? events.filter((event) => event.direction !== 'outgoing' || event.source !== 'manual')
    : events;
}

const streamText = () => {
  const decoders = { incoming: new TextDecoder(), outgoing: new TextDecoder(), system: new TextDecoder() };
  return (event: TerminalEvent): string =>
    decoders[event.direction]
      .decode(rawBytes(event.data), { stream: true })
      .replace(ANSI_CSI, '')
      .replace(ANSI_OSC, '');
};

/** Keep separate streaming decoders so TX bytes cannot corrupt a split RX character. */
export function renderTerminalEvents(
  events: TerminalEvent[],
  presentation: boolean | TerminalOutputMode = false,
  outputNewlines: TerminalNewlineMode = 'keep'
): Array<TerminalEvent & { text: string }> {
  const mode: TerminalOutputMode = presentation === true ? 'hex' : presentation === false ? 'text' : presentation;
  const decode = streamText();
  const newlines = {
    incoming: createNewlineTransformer(outputNewlines),
    outgoing: createNewlineTransformer(outputNewlines),
    system: createNewlineTransformer(outputNewlines),
  };
  return events.map((event) => {
    const bytes = rawBytes(event.data);
    const text =
      mode === 'hex'
        ? toHex(bytes)
        : mode === 'hexdump'
          ? formatHexdump(bytes, Math.max(0, event.cursor - event.byteLength))
          : newlines[event.direction](decode(event));
    return { ...event, text };
  });
}

export type TerminalFrame = {
  key: string;
  direction: TerminalEvent['direction'];
  source: TerminalEvent['source'];
  timestamp: number;
  bytes: Uint8Array;
  status?: TerminalEvent['status'];
  error?: string;
};

/**
 * Group raw chunks into protocol frames: received chunks arriving within gapMs of each other join one
 * frame, while every write stays its own frame (slices of one event share a timestamp and are rejoined).
 */
export function groupTerminalFrames(events: TerminalEvent[], gapMs: number): TerminalFrame[] {
  const frames: Array<TerminalFrame & { parts: Uint8Array[]; last: number }> = [];
  for (const event of events) {
    const bytes = rawBytes(event.data);
    const previous = frames.at(-1);
    const joins =
      previous &&
      previous.direction === event.direction &&
      previous.source === event.source &&
      event.direction !== 'system' &&
      (event.direction === 'incoming'
        ? event.timestamp - previous.last <= gapMs
        : event.timestamp === previous.last && previous.status === event.status);
    if (previous && joins) {
      previous.parts.push(bytes);
      previous.last = event.timestamp;
      continue;
    }
    frames.push({
      key: String(event.cursor),
      direction: event.direction,
      source: event.source,
      timestamp: event.timestamp,
      bytes,
      ...(event.status ? { status: event.status } : {}),
      ...(event.error ? { error: event.error } : {}),
      parts: [bytes],
      last: event.timestamp,
    });
  }
  return frames.map(({ parts, last: _last, ...frame }) => {
    if (parts.length === 1) return frame;
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { ...frame, bytes };
  });
}

export type TerminalTextLine = {
  key: string;
  timestamp: number;
  segments: Array<{ direction: TerminalEvent['direction']; text: string }>;
  error?: string;
  system?: boolean;
};

/**
 * Lay a byte stream out as terminal lines: chunks flow inline and only CR, LF or CRLF break a line,
 * so a reply split across serial reads still reads as one line.
 */
export function buildTextLines(
  events: TerminalEvent[],
  newlines: TerminalNewlineMode = 'keep',
  maxLines = 5000
): TerminalTextLine[] {
  const decode = streamText();
  const transforms = {
    incoming: createNewlineTransformer(newlines),
    outgoing: createNewlineTransformer(newlines),
    system: createNewlineTransformer(newlines),
  };
  const lines: TerminalTextLine[] = [];
  let current: TerminalTextLine | undefined;
  let pendingCr = false;
  for (const event of events) {
    if (event.direction === 'system') {
      lines.push({
        key: `${event.cursor}:system`,
        timestamp: event.timestamp,
        segments: [],
        system: true,
        ...(event.error ? { error: event.error } : {}),
      });
      current = undefined;
      pendingCr = false;
      continue;
    }
    let piece = 0;
    const start = (): TerminalTextLine => {
      const line: TerminalTextLine = { key: `${event.cursor}:${piece++}`, timestamp: event.timestamp, segments: [] };
      lines.push(line);
      return line;
    };
    for (const token of transforms[event.direction](decode(event)).split(/(\r\n|\r|\n)/)) {
      if (!token) continue;
      if (token === '\n' && pendingCr) {
        pendingCr = false;
        continue;
      }
      pendingCr = token === '\r';
      if (token === '\r\n' || token === '\r' || token === '\n') {
        // A break with no open line is an empty line of its own.
        if (!current) start();
        current = undefined;
        continue;
      }
      current ??= start();
      const last = current.segments.at(-1);
      if (last?.direction === event.direction) last.text += token;
      else current.segments.push({ direction: event.direction, text: token });
    }
    if (event.status === 'failed' && event.error) {
      current ??= start();
      current.error = event.error;
    }
  }
  return lines.length > maxLines ? lines.slice(-maxLines) : lines;
}

export type HexInput = { ok: true; hex: string; bytes: number } | { ok: false; reason: 'hexInvalid' | 'hexOdd' };

/** Accept spaced, 0x-prefixed or comma/dash separated bytes and return canonical byte pairs. */
export function parseHexInput(text: string): HexInput {
  const compact = text.replace(/0x/gi, '').replace(/[\s,;:-]+/g, '');
  if (!/^[0-9a-f]*$/i.test(compact)) return { ok: false, reason: 'hexInvalid' };
  if (compact.length % 2) return { ok: false, reason: 'hexOdd' };
  return { ok: true, hex: (compact.match(/../g) ?? []).join(' ').toUpperCase(), bytes: compact.length / 2 };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const PARITY_LETTER = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' } as const;

/** Compact connection line such as "COM1 · 9600 · 8E1 · RTS/CTS". */
export function describeProfile(profile: TerminalProfile, shellFallback: string): string {
  if (profile.kind === 'shell') {
    const executable = profile.executable?.split(/[\\/]/).pop();
    return [executable || shellFallback, profile.cwd].filter(Boolean).join(' · ');
  }
  const flow = [profile.rtscts && 'RTS/CTS', profile.xon && profile.xoff && 'XON/XOFF'].filter(Boolean);
  return [
    profile.path,
    String(profile.baudRate),
    `${profile.dataBits}${PARITY_LETTER[profile.parity]}${profile.stopBits}`,
    ...flow,
  ].join(' · ');
}
