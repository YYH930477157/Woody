import { describe, expect, it } from 'vitest';
import { applyNewlineMode } from '../../../packages/desktop/src/common/terminal/stream';
import type { TerminalEvent } from '../../../packages/desktop/src/common/types/terminal';
import {
  buildTextLines,
  describeProfile,
  displayedTerminalEvents,
  formatByteSize,
  groupTerminalFrames,
  parseHexInput,
  renderTerminalEvents,
  terminalKeyInput,
  toHex,
} from '../../../packages/desktop/src/renderer/pages/terminal/terminalView';

const timed = (
  data: string | number[],
  cursor: number,
  timestamp: number,
  direction: TerminalEvent['direction'] = 'incoming',
  source: TerminalEvent['source'] = 'transport'
): TerminalEvent => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  return { cursor, timestamp, direction, source, data: bytes.toString('base64'), byteLength: bytes.length };
};

const historyEvent = (
  data: string,
  cursor: number,
  direction: 'incoming' | 'outgoing',
  source: 'manual' | 'ai' | 'transport'
) => ({
  cursor,
  timestamp: 1,
  direction,
  source,
  data: Buffer.from(data).toString('base64'),
  byteLength: data.length,
});

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
  it('draws typed bytes once, in history order, and leaves normal-mode echo to the device', () => {
    const history = [
      historyEvent('A', 1, 'outgoing', 'manual'),
      historyEvent('OK', 3, 'incoming', 'transport'),
      historyEvent('B', 4, 'outgoing', 'manual'),
      historyEvent('AT', 6, 'outgoing', 'ai'),
    ];
    const text = (hideManualOutgoing: boolean) =>
      renderTerminalEvents(displayedTerminalEvents(history, hideManualOutgoing), false)
        .map((item) => item.text)
        .join('');

    expect(text(false)).toBe('AOKBAT');
    expect(text(true)).toBe('OKAT');
  });
});

describe('terminal frames', () => {
  it('joins received chunks that arrive within the frame gap and keeps each write separate', () => {
    const frames = groupTerminalFrames(
      [
        timed([0x68, 0xaa], 2, 1000, 'outgoing', 'manual'),
        timed([0x68, 0x12], 4, 1100),
        timed([0x34, 0x16], 6, 1120),
        timed([0x68], 7, 1200),
        timed([0x68, 0xaa], 9, 1300, 'outgoing', 'manual'),
        timed([0x01], 10, 1300, 'outgoing', 'ai'),
      ],
      30
    );

    expect(frames.map((frame) => [frame.direction, frame.source, toHex(frame.bytes)])).toEqual([
      ['outgoing', 'manual', '68 AA'],
      ['incoming', 'transport', '68 12 34 16'],
      ['incoming', 'transport', '68'],
      ['outgoing', 'manual', '68 AA'],
      ['outgoing', 'ai', '01'],
    ]);
  });

  it('shows every raw chunk with a zero gap but rejoins slices of one event', () => {
    const frames = groupTerminalFrames([timed('AB', 2, 5), timed('CD', 4, 5), timed('EF', 6, 6)], 0);

    expect(frames.map((frame) => Buffer.from(frame.bytes).toString())).toEqual(['ABCD', 'EF']);
  });

  it('keeps a disconnect as its own frame with the transport error', () => {
    const frames = groupTerminalFrames(
      [timed('A', 1, 1), { ...timed('', 2, 2, 'system'), error: 'unplugged' }, timed('B', 3, 3)],
      1000
    );

    expect(frames.map((frame) => [frame.direction, frame.error])).toEqual([
      ['incoming', undefined],
      ['system', 'unplugged'],
      ['incoming', undefined],
    ]);
  });
});

describe('terminal text lines', () => {
  const lineText = (events: TerminalEvent[]) =>
    buildTextLines(events).map((line) => line.segments.map((segment) => segment.text).join(''));

  it('flows chunks inline so only real line breaks start a new line', () => {
    expect(
      lineText([timed('PS C:\\> ', 1, 1), timed('dir', 4, 2), timed('\r\nok\r', 9, 3), timed('\nnext', 14, 4)])
    ).toEqual(['PS C:\\> dir', 'ok', 'next']);
  });

  it('treats a lone CR as a line break and keeps empty lines', () => {
    expect(lineText([timed('a\rb\n\nc', 6, 1)])).toEqual(['a', 'b', '', 'c']);
  });

  it('applies a shell backspace echo instead of keeping the deleted character', () => {
    expect(lineText([timed('admin:/$ helpx', 14, 1), timed('\b \b', 17, 2)])).toEqual(['admin:/$ help ']);
  });

  it('shows a tab completion redraw as the completed command', () => {
    expect(lineText([timed('admin:/$ he', 11, 1), timed('\b \b\b \bhelp', 23, 2)])).toEqual(['admin:/$ help']);
  });

  it('does not let backspace reach into the previous line', () => {
    expect(lineText([timed('ok\r\n\b\bx', 7, 1)])).toEqual(['ok', 'x']);
  });

  it('backspaces over a whole character outside the basic plane', () => {
    expect(lineText([timed('a😀', 5, 1), timed('\bb', 7, 2)])).toEqual(['ab']);
  });

  it('marks echoed input and stamps each line with the time it started', () => {
    const lines = buildTextLines([timed('AT', 2, 10, 'outgoing', 'manual'), timed('\r\nOK\r\n', 8, 20)]);

    expect(lines.map((line) => [line.timestamp, line.segments.map((segment) => segment.direction)])).toEqual([
      [10, ['outgoing']],
      [20, ['incoming']],
    ]);
  });

  it('renders a disconnect as a separate system line', () => {
    const lines = buildTextLines([timed('x', 1, 1), { ...timed('', 2, 2, 'system'), error: 'gone' }, timed('y', 3, 3)]);

    expect(lines.map((line) => (line.system ? `system:${line.error}` : line.segments[0].text))).toEqual([
      'x',
      'system:gone',
      'y',
    ]);
  });
});

describe('terminal keystroke input', () => {
  it('sends the configured Backspace byte', () => {
    expect([terminalKeyInput('Backspace', 'ctrlH'), terminalKeyInput('Backspace', 'del')]).toEqual(['\b', '\x7f']);
  });

  it('sends editing keys as VT sequences', () => {
    expect(['ArrowUp', 'ArrowLeft', 'Delete'].map((key) => terminalKeyInput(key, 'ctrlH'))).toEqual([
      '\x1b[A',
      '\x1b[D',
      '\x1b[3~',
    ]);
  });

  it('leaves modifier and function keys to the browser', () => {
    expect(['Shift', 'F5'].map((key) => terminalKeyInput(key, 'ctrlH'))).toEqual([undefined, undefined]);
  });
});

describe('terminal input and labels', () => {
  it('accepts common HEX notations and reports what is wrong otherwise', () => {
    expect(parseHexInput('0x68, 0xaa;7e-16')).toEqual({ ok: true, hex: '68 AA 7E 16', bytes: 4 });
    expect(parseHexInput('68 A')).toEqual({ ok: false, reason: 'hexOdd' });
    expect(parseHexInput('68 GG')).toEqual({ ok: false, reason: 'hexInvalid' });
    expect(parseHexInput('  ')).toEqual({ ok: true, hex: '', bytes: 0 });
  });

  it('summarizes connection parameters compactly', () => {
    expect(
      describeProfile(
        {
          id: 'p',
          name: 'Meter',
          kind: 'serial',
          path: 'COM3',
          baudRate: 2400,
          dataBits: 8,
          parity: 'even',
          stopBits: 1,
          rtscts: true,
          xon: false,
          xoff: false,
        },
        'Shell'
      )
    ).toBe('COM3 · 2400 · 8E1 · RTS/CTS');
    expect(describeProfile({ id: 's', name: 'pwsh', kind: 'shell', executable: 'C:\\pwsh\\pwsh.exe' }, 'Shell')).toBe(
      'pwsh.exe'
    );
    expect(describeProfile({ id: 's', name: 'shell', kind: 'shell' }, 'Default shell')).toBe('Default shell');
  });

  it('formats byte counters', () => {
    expect([formatByteSize(512), formatByteSize(2048), formatByteSize(3 * 1024 * 1024)]).toEqual([
      '512 B',
      '2.0 KB',
      '3.0 MB',
    ]);
  });
});
