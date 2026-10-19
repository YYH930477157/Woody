import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalProfile } from '../../../packages/desktop/src/common/types/terminal';
import {
  createNativeTransport,
  resolveShell,
} from '../../../packages/desktop/src/process/services/terminal/nativeTransport';

class MockSerialPort extends EventEmitter {
  static current: MockSerialPort;
  static deferOpen = false;
  isOpen = false;
  openCallback?: (error: Error | null) => void;

  constructor() {
    super();
    MockSerialPort.current = this;
  }

  open(callback: (error: Error | null) => void): void {
    this.openCallback = callback;
    if (!MockSerialPort.deferOpen) this.finishOpen();
  }

  finishOpen(): void {
    this.isOpen = true;
    this.openCallback?.(null);
  }

  close = vi.fn((callback: (error: Error | null) => void) => {
    this.isOpen = false;
    this.emit('close');
    callback(null);
  });
  write = vi.fn((_data: Buffer, callback: (error: Error | null) => void) => callback(null));
  drain = vi.fn((callback: (error: Error | null) => void) => callback(null));
}

vi.mock('serialport', () => ({ SerialPort: MockSerialPort }));

const serialProfile: TerminalProfile = {
  id: 'serial',
  name: 'Device',
  kind: 'serial',
  path: 'COM3',
  baudRate: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  rtscts: false,
  xon: false,
  xoff: false,
};

describe('serial transport cleanup', () => {
  beforeEach(() => {
    MockSerialPort.deferOpen = false;
  });

  it('releases the native handle after an error without a manual disconnect', async () => {
    await createNativeTransport(serialProfile);
    const port = MockSerialPort.current;
    port.emit('error', new Error('Device lost'));

    await vi.waitFor(() => expect(port.isOpen).toBe(false));
    expect(port.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the original failure for a listener attached after native close', async () => {
    const transport = await createNativeTransport(serialProfile);
    const port = MockSerialPort.current;
    port.emit('error', new Error('Device lost'));
    await transport.close();
    const listener = vi.fn();
    transport.onClose(listener);

    expect(listener).toHaveBeenCalledExactlyOnceWith('Device lost');
  });

  it('shares cleanup across repeated errors and explicit disconnects', async () => {
    const transport = await createNativeTransport(serialProfile);
    const port = MockSerialPort.current;
    let completeClose: (() => void) | undefined;
    port.close.mockImplementation((callback) => {
      completeClose = () => {
        port.isOpen = false;
        port.emit('close');
        callback(null);
      };
    });
    const listener = vi.fn();
    transport.onClose(listener);
    port.emit('error', new Error('Device lost'));
    port.emit('error', new Error('Secondary error'));
    const close = transport.close();
    await vi.waitFor(() => expect(completeClose).toBeDefined());
    completeClose?.();
    await close;

    expect(port.close).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledExactlyOnceWith('Device lost');
  });

  it('allows a failed background cleanup to be retried explicitly', async () => {
    const transport = await createNativeTransport(serialProfile);
    const port = MockSerialPort.current;
    port.close.mockImplementationOnce((callback) => callback(new Error('Close failed')));
    port.emit('error', new Error('Device lost'));
    await vi.waitFor(() => expect(port.close).toHaveBeenCalledTimes(1));
    await transport.close();

    expect(port.isOpen).toBe(false);
    expect(port.close).toHaveBeenCalledTimes(2);
  });

  it('cleans up a handle that finishes opening after an error', async () => {
    MockSerialPort.deferOpen = true;
    const previous = MockSerialPort.current;
    const opening = createNativeTransport(serialProfile);
    const rejected = expect(opening).rejects.toThrow('Open failed');
    await vi.waitFor(() => expect(MockSerialPort.current).not.toBe(previous));
    const port = MockSerialPort.current;
    port.emit('error', new Error('Open failed'));
    port.finishOpen();

    await rejected;
    expect(port.isOpen).toBe(false);
  });

  it('rejects writes and ignores incoming data after a terminal error', async () => {
    const transport = await createNativeTransport(serialProfile);
    const listener = vi.fn();
    transport.onData(listener);
    MockSerialPort.current.emit('error', new Error('Device lost'));
    MockSerialPort.current.emit('data', Buffer.from('late'));

    await expect(transport.write(Buffer.from('command'))).rejects.toThrow('terminal.disconnected');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('shell selection', () => {
  it('prefers a configured executable and never silently changes it', () => {
    expect(resolveShell('D:\\tools\\pwsh.exe', { platform: 'win32', env: {}, exists: () => true })).toBe(
      'D:\\tools\\pwsh.exe'
    );
    expect(() => resolveShell('missing.exe', { platform: 'win32', env: {}, exists: () => false })).toThrow();
  });
  it('detects PowerShell 7 before the legacy fallback', () => {
    const result = resolveShell(undefined, {
      platform: 'win32',
      env: { PATH: 'D:\\ps7', SystemRoot: 'C:\\Windows' },
      exists: (p) => p === 'D:\\ps7\\pwsh.exe' || p.includes('WindowsPowerShell'),
    });
    expect(result).toBe('D:\\ps7\\pwsh.exe');
  });
  it('fails clearly when no usable local shell exists', () => {
    expect(() => resolveShell(undefined, { platform: 'win32', env: {}, exists: () => false })).toThrow();
  });
});
