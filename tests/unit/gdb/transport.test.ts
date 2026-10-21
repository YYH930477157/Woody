import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GdbTransport } from '@/process/services/cmake/gdb/transport';

describe('GDB MI transport', () => {
  let transport: GdbTransport;
  afterEach(async () => {
    await transport?.close();
  });
  function start(timeoutMs = 1500) {
    const onRecord = vi.fn();
    const onExit = vi.fn();
    transport = new GdbTransport(
      {
        executable: process.execPath,
        args: [path.resolve('tests/unit/gdb/fake-gdb.cjs')],
        cwd: process.cwd(),
        env: process.env,
      },
      { onRecord, onExit },
      timeoutMs
    );
    return { onRecord, onExit };
  }
  it('correlates token replies even when they arrive out of order', async () => {
    start();
    const slow = transport.command('-slow');
    expect(await transport.command('-fast')).toEqual({ value: '42' });
    expect(await slow).toEqual({ value: 'slow' });
  });
  it('delivers stop events independently of command results', async () => {
    const { onRecord } = start();
    await transport.command('-exec-run');
    await vi.waitFor(() => expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ class: 'stopped' })));
  });
  it('reports GDB errors and keeps the session available', async () => {
    start();
    await expect(transport.command('-bad')).rejects.toThrow('No symbol found');
    expect(await transport.command('-fast')).toEqual({ value: '42' });
  });
  it('terminates a stalled debugger and rejects all pending requests', async () => {
    const { onExit } = start(200);
    await expect(transport.command('-hang')).rejects.toThrow('gdb.timeout');
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled());
  });
  it('bounds an unterminated output line', async () => {
    start();
    await expect(transport.command('-overflow')).rejects.toThrow('gdb.outputLimit');
  });
  it('rejects newline command injection before writing', async () => {
    start();
    await expect(transport.command('-exec-run\n-shell cmd')).rejects.toThrow('gdb.invalidInput');
  });
});
