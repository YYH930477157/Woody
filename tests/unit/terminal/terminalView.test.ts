import { describe, expect, it } from 'vitest';
import { applyNewlineMode } from '../../../packages/desktop/src/common/terminal/stream';
import { renderTerminalEvents } from '../../../packages/desktop/src/renderer/pages/terminal/terminalView';

describe('terminal byte display', () => {
  it('decodes UTF-8 split across serial receive chunks', () => {
    const make = (data: number[], cursor: number) => ({
      cursor,
      timestamp: 1,
      direction: 'incoming' as const,
      source: 'transport' as const,
      data: Buffer.from(data).toString('base64'),
      byteLength: data.length,
    });
    expect(
      renderTerminalEvents([make([0xe4, 0xb8], 2), make([0xad], 3)], false)
        .map((event) => event.text)
        .join('')
    ).toBe('中');
  });
  it('preserves binary data in HEX display', () => {
    expect(
      renderTerminalEvents(
        [{ cursor: 3, timestamp: 1, direction: 'incoming', source: 'transport', data: 'AP9+', byteLength: 3 }],
        true
      )[0].text
    ).toBe('00 FF 7E');
  });
  it('does not let terminal escape codes become rendered instructions', () => {
    expect(
      renderTerminalEvents(
        [
          {
            cursor: 8,
            timestamp: 1,
            direction: 'incoming',
            source: 'transport',
            data: Buffer.from('\x1b[31mabc').toString('base64'),
            byteLength: 8,
          },
        ],
        false
      )[0].text
    ).toBe('abc');
  });
  it('formats a real hexdump and rewrites received newlines across chunks', () => {
    const event = {
      cursor: 4,
      timestamp: 1,
      direction: 'incoming' as const,
      source: 'transport' as const,
      data: Buffer.from([0x41, 0x00, 0x7e, 0x0a]).toString('base64'),
      byteLength: 4,
    };
    expect(renderTerminalEvents([event], 'hexdump')[0].text).toMatch(/^00000000 {2}41 00 7E 0A {39}\|A\.~\.\|$/);
    const chunk = (data: string, cursor: number) => ({
      cursor,
      timestamp: 1,
      direction: 'incoming' as const,
      source: 'transport' as const,
      data: Buffer.from(data).toString('base64'),
      byteLength: data.length,
    });
    expect(
      renderTerminalEvents([chunk('\r', 1), chunk('A\n', 3)], 'text', 'implicitLf')
        .map((item) => item.text)
        .join('')
    ).toBe('\r\nA\n');
    expect(applyNewlineMode('line\n', 'cr')).toBe('line\r');
    expect(applyNewlineMode('keep\r\n', 'strip')).toBe('keep');
    expect(applyNewlineMode('a\n', 'implicitCr')).toBe('a\r\n');
  });
});
