export const TERMINAL_NEWLINE_MODES = ['keep', 'strip', 'cr', 'lf', 'crlf', 'implicitCr', 'implicitLf'] as const;
export type TerminalNewlineMode = (typeof TERMINAL_NEWLINE_MODES)[number];
export const TERMINAL_INPUT_MODES = ['normal', 'localEcho', 'readline', 'readlineHex'] as const;
export type TerminalInputMode = (typeof TERMINAL_INPUT_MODES)[number];
export const TERMINAL_OUTPUT_MODES = ['text', 'hex', 'hexdump'] as const;
export type TerminalOutputMode = (typeof TERMINAL_OUTPUT_MODES)[number];
export const TERMINAL_BAUD_RATES = [
  110, 300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

/** Rewrite newline sequences. A trailing CR can stay buffered until the next chunk. */
export function applyNewlineMode(text: string, mode: TerminalNewlineMode): string {
  if (mode === 'keep' || !text) return text;
  if (mode === 'strip') return text.replace(/\r\n|[\r\n]/g, '');
  if (mode === 'implicitCr') return text.replace(/(^|[^\r])\n/g, '$1\r\n');
  if (mode === 'implicitLf') return text.replace(/\r(?!\n)/g, '\r\n');
  const replacement = mode === 'cr' ? '\r' : mode === 'lf' ? '\n' : '\r\n';
  return text.replace(/\r\n|[\r\n]/g, replacement);
}

export function createNewlineTransformer(mode: TerminalNewlineMode): (chunk: string) => string {
  let held = '';
  return (chunk: string) => {
    if (mode === 'keep') return chunk;
    const input = held + chunk;
    held = '';
    if (input.endsWith('\r')) {
      held = '\r';
      return applyNewlineMode(input.slice(0, -1), mode);
    }
    return applyNewlineMode(input, mode);
  };
}

/** Classic 16-byte rows: offset, hex groups, and printable ASCII. */
export function formatHexdump(bytes: Uint8Array, startOffset = 0): string {
  if (!bytes.length) return '';
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, Math.min(offset + 16, bytes.length));
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, '0').toUpperCase());
    const grouped = `${hex.slice(0, 8).join(' ')}${hex.length > 8 ? `  ${hex.slice(8).join(' ')}` : ''}`.padEnd(
      48,
      ' '
    );
    const ascii = Array.from(slice, (byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join(
      ''
    );
    lines.push(`${(startOffset + offset).toString(16).padStart(8, '0').toUpperCase()}  ${grouped}  |${ascii}|`);
  }
  return lines.join('\n');
}
