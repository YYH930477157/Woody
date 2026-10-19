import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TerminalProfile, TerminalTransport } from '@/common/types/terminal';

type ShellEnvironment = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
};

/** Resolve an installed shell without persisting this computer's paths as defaults. */
export function resolveShell(
  configured?: string,
  options: ShellEnvironment = { platform: process.platform, env: process.env, exists: existsSync }
): string {
  const { platform, env, exists } = options;
  const paths = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const find = (name: string) => [name, ...paths.map((dir) => join(dir, name))].find(exists);
  if (configured) {
    const resolved = find(configured);
    if (!resolved) throw new Error('terminal.shellMissing');
    return resolved;
  }
  const candidates =
    platform === 'win32'
      ? [
          find('pwsh.exe'),
          env.ProgramFiles && join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
          env.SystemRoot && join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ]
      : [find('pwsh'), env.SHELL, '/bin/bash', '/bin/sh'];
  const executable = candidates.find((candidate): candidate is string => !!candidate && exists(candidate));
  if (!executable) throw new Error('terminal.shellMissing');
  return executable;
}

/** Buffer early output until the connection service has installed its listener. */
function outputRelay() {
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let listener: ((data: Buffer) => void) | undefined;
  let closeListener: ((error?: string) => void) | undefined;
  let ended: { error?: string } | undefined;
  return {
    data(data: Buffer) {
      if (listener) listener(data);
      else if (pendingBytes + data.length <= 4 * 1024 * 1024) {
        pending.push(data);
        pendingBytes += data.length;
      }
    },
    end(error?: string) {
      ended = { error };
      closeListener?.(error);
    },
    onData(callback: (data: Buffer) => void) {
      listener = callback;
      for (const data of pending.splice(0)) callback(data);
      pendingBytes = 0;
      return () => {
        listener = undefined;
      };
    },
    onClose(callback: (error?: string) => void) {
      closeListener = callback;
      if (ended) callback(ended.error);
      return () => {
        closeListener = undefined;
      };
    },
  };
}

export async function listSerialPorts(): Promise<
  Array<{ path: string; manufacturer?: string; serialNumber?: string }>
> {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
}

/** Native handles stay in Electron; renderer and MCP only use connection IDs. */
export async function createNativeTransport(profile: TerminalProfile): Promise<TerminalTransport> {
  const relay = outputRelay();
  if (profile.kind === 'shell') {
    const { spawn } = await import('node-pty');
    const executable = resolveShell(profile.executable);
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    // Runtime bridge credentials must never appear in a user's interactive environment.
    delete env.AIONUI_TERMINAL_TOKEN;
    delete env.AIONUI_TERMINAL_PORT;
    const terminal = spawn(
      executable,
      profile.args ??
        (/(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(executable)) ? ['-NoLogo', '-NoProfile'] : []),
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: profile.cwd || process.cwd(),
        env,
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
      }
    );
    let closed = false;
    terminal.onData((text) => relay.data(Buffer.from(text, 'utf8')));
    terminal.onExit(({ exitCode }) => {
      closed = true;
      relay.end(exitCode === 0 ? undefined : `Shell exited (${exitCode})`);
    });
    return {
      onData: relay.onData,
      onClose: relay.onClose,
      write: async (data) => {
        if (closed) throw new Error('terminal.disconnected');
        terminal.write(data.toString('utf8'));
        return data.length;
      },
      interrupt: async () => {
        if (closed) throw new Error('terminal.disconnected');
        terminal.write('\x03');
      },
      close: async () => {
        if (!closed) terminal.kill();
      },
    };
  }
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({
    path: profile.path,
    baudRate: profile.baudRate,
    dataBits: profile.dataBits,
    parity: profile.parity,
    stopBits: profile.stopBits,
    rtscts: profile.rtscts,
    xon: profile.xon,
    xoff: profile.xoff,
    autoOpen: false,
  });
  port.on('data', (data: Buffer) => relay.data(Buffer.from(data)));
  port.on('error', (error: Error) => relay.end(error.message));
  port.on('close', () => relay.end());
  try {
    await new Promise<void>((resolve, reject) => port.open((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    if (port.isOpen) port.close();
    throw error;
  }
  return {
    onData: relay.onData,
    onClose: relay.onClose,
    write: (data) =>
      new Promise<number>((resolve, reject) => {
        port.write(data, (error) => {
          if (error) return reject(error);
          port.drain((drainError) =>
            drainError ? reject(Object.assign(drainError, { bytesWritten: data.length })) : resolve(data.length)
          );
        });
      }),
    close: async () => {
      if (port.isOpen) {
        await new Promise<void>((resolve, reject) => port.close((error) => (error ? reject(error) : resolve())));
      }
    },
  };
}
