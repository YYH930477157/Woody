import type { TerminalEvent } from '@/common/types/terminal';

// ANSI terminal escape sequences intentionally contain control characters.
/* eslint-disable no-control-regex */
export function rawBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

/** Keep separate streaming decoders so TX bytes cannot corrupt a split RX character. */
export function renderTerminalEvents(events: TerminalEvent[], hex: boolean): Array<TerminalEvent & { text: string }> {
  const decoders = { incoming: new TextDecoder(), outgoing: new TextDecoder(), system: new TextDecoder() };
  return events.map((event) => {
    const bytes = rawBytes(event.data);
    const text = hex
      ? Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')
      : decoders[event.direction]
          .decode(bytes, { stream: true })
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
    return { ...event, text };
  });
}
