import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationReader, discoverProjects, loadVariantConfiguration } from '@/process/services/cmake/workspace';
import { readPowerShell, resolvePowerShell } from '@/process/services/cmake/workspace/powershell';

let root: string;
let file: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-reader-'));
  file = path.join(root, 'cmake-variants.yaml');
  await fs.writeFile(file, 'mode: {choices: {sim: {short: Simulator}}}');
});

describe('PowerShell byte transport', () => {
  async function transport(output: Buffer | string, code = 0) {
    const executable = path.join(root, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
    await fs.writeFile(executable, 'placeholder');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      }),
    });
    const launch = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(output));
        child.emit('close', code);
      });
      return child as unknown as ChildProcess;
    });
    return { executable, launch: launch as unknown as typeof spawn, child };
  }
  it('rejects non-ASCII protocol bytes rather than stripping their high bits', async () => {
    const fake = await transport(Buffer.from([0xc2, 0xba, 0xe1, 0xd1, 0xbd, 0xbd]));
    await expect(
      readPowerShell(
        file,
        { path: fake.executable, limit: 10, env: {}, spawn: fake.launch },
        new AbortController().signal
      )
    ).rejects.toThrow('cmake.readTransport');
  });
  it('omits application tokens from the reader environment', async () => {
    const fake = await transport('B:');
    await readPowerShell(
      file,
      {
        path: fake.executable,
        limit: 10,
        env: { AIONUI_TOKEN: 'private', AIONUI_BACKEND_PORT: '123', PATH: 'retained' },
        spawn: fake.launch,
      },
      new AbortController().signal
    );
    const options = vi.mocked(fake.launch).mock.calls[0][2];
    expect(options?.env).not.toHaveProperty('AIONUI_TOKEN');
    expect(options?.env).not.toHaveProperty('AIONUI_BACKEND_PORT');
    expect(options?.env?.PATH).toBe('retained');
  });
  it('waits for the killed child to close before resolving cancellation', async () => {
    const fake = await transport('');
    fake.child.kill.mockImplementation(() => true);
    const controller = new AbortController();
    const launch = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return fake.child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    let settled = false;
    const pending = readPowerShell(
      file,
      { path: fake.executable, limit: 10, env: {}, spawn: launch },
      controller.signal
    ).catch(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(fake.child.kill).toHaveBeenCalled());
    expect(settled).toBe(false);
    fake.child.emit('close', null);
    await pending;
    expect(settled).toBe(true);
  });
  it('passes punctuation only as path data and suppresses profiles and visible windows', async () => {
    const fake = await transport('B:aGk=');
    const literal = path.join(root, "quoted ' name [1] $value.yaml");
    const result = await readPowerShell(
      literal,
      { path: fake.executable, limit: 10, env: {}, spawn: fake.launch },
      new AbortController().signal
    );
    expect(result.bytes.toString()).toBe('hi');
    expect(fake.launch).toHaveBeenCalledWith(
      fake.executable,
      expect.arrayContaining(['-NoProfile', '-NonInteractive']),
      expect.objectContaining({
        windowsHide: true,
        shell: false,
        env: expect.objectContaining({ WOODY_READER_FILE: literal }),
      })
    );
    const args = vi.mocked(fake.launch).mock.calls[0][1] as string[];
    expect(Buffer.from(args.at(-1)!, 'base64').toString('utf16le')).not.toContain(literal);
  });
  it.each(['B:not base64', 'B:a===', 'B:aGk=\nnoise'])('rejects malformed transport %s', async (output) => {
    const fake = await transport(output);
    await expect(
      readPowerShell(
        file,
        { path: fake.executable, limit: 10, env: {}, spawn: fake.launch },
        new AbortController().signal
      )
    ).rejects.toThrow('cmake.readTransport');
  });
  it('bounds output and kills an overflowing child', async () => {
    const fake = await transport('B:' + 'a'.repeat(200));
    await expect(
      readPowerShell(
        file,
        { path: fake.executable, limit: 10, env: {}, spawn: fake.launch },
        new AbortController().signal
      )
    ).rejects.toThrow('cmake.readTransport');
    expect(fake.child.kill).toHaveBeenCalledOnce();
  });
  it('kills a child that exceeds the read deadline', async () => {
    const fake = await transport('');
    const launch = vi.fn(() => fake.child as unknown as ChildProcess) as unknown as typeof spawn;
    await expect(
      readPowerShell(
        file,
        { path: fake.executable, limit: 10, env: {}, spawn: launch, timeoutMs: 10 },
        new AbortController().signal
      )
    ).rejects.toThrow('cmake.readTimeout');
    expect(fake.child.kill).toHaveBeenCalledOnce();
  });
  it('cancels an active child', async () => {
    const fake = await transport('');
    const controller = new AbortController();
    const launch = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return fake.child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    await expect(
      readPowerShell(file, { path: fake.executable, limit: 10, env: {}, spawn: launch }, controller.signal)
    ).rejects.toThrow('cmake.readCancelled');
    expect(fake.child.kill).toHaveBeenCalledOnce();
  });
  it.each([
    ['E:denied', 'cmake.readDenied'],
    ['E:version', 'cmake.readPowerShellVersion'],
    ['E:missing', 'cmake.readMissing'],
  ])('reports safe failure %s', async (output, error) => {
    const fake = await transport(output, 1);
    await expect(
      readPowerShell(
        file,
        { path: fake.executable, limit: 10, env: {}, spawn: fake.launch },
        new AbortController().signal
      )
    ).rejects.toThrow(error);
  });
  it('rejects an explicit missing executable instead of silently using PATH', async () => {
    await expect(resolvePowerShell(path.join(root, 'missing', 'pwsh.exe'), process.env)).rejects.toThrow(
      'cmake.readPowerShellMissing'
    );
    await expect(resolvePowerShell(path.join(root, 'reader.cmd'), process.env)).rejects.toThrow(
      'cmake.readPowerShellMissing'
    );
  });
  it('reads a real local fixture using installed PowerShell 7', async (context) => {
    let executable: string;
    try {
      executable = await resolvePowerShell('', process.env);
    } catch {
      context.skip();
      return;
    }
    const literal = path.join(root, "literal ' [1] $value.yaml");
    await fs.writeFile(literal, Buffer.from('\ufeffhello', 'utf16le'));
    expect(
      await new ConfigurationReader().read(literal, { ...direct, mode: 'powershell', powershellPath: executable })
    ).toMatchObject({ text: 'hello', info: { reader: 'powershell', encoding: 'utf-16le', executable } });
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const direct = { mode: 'direct', encoding: 'auto', powershellPath: '' } as const;

describe('configuration reading', () => {
  it('passes a canonical file path to the child reader for an allowed junction', async () => {
    const target = path.join(root, 'target');
    const link = path.join(root, 'linked');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'config.yaml'), 'readable');
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const fallback = vi.fn(async (_file: string) => ({ bytes: Buffer.from('readable'), executable: 'pwsh.exe' }));
      await new ConfigurationReader({ powershellRead: fallback }).read(path.join(link, 'config.yaml'), {
        ...direct,
        mode: 'powershell',
      });
      expect(fallback.mock.calls[0]?.[0]).toBe(await fs.realpath(path.join(target, 'config.yaml')));
    } finally {
      await fs.unlink(link);
    }
  });
  it('blocks configuration junctions that escape the allowed workspace', async () => {
    await fs.unlink(file);
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-reader-external-'));
    const link = path.join(root, '.vscode');
    await fs.writeFile(path.join(external, 'cmake-variants.yaml'), 'mode: {choices: {sim: {short: Simulator}}}');
    await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(await loadVariantConfiguration(root)).toMatchObject({
        dimensions: [],
        diagnostic: { kind: 'read', message: 'cmake.readPath' },
      });
    } finally {
      await fs.unlink(link);
      await fs.rm(external, { recursive: true, force: true });
    }
  });
  it('treats NUL decoded text as a read failure eligible for fallback', async () => {
    const reader = new ConfigurationReader({
      directRead: async () => Buffer.from('encrypted\0bytes'),
      powershellRead: async () => ({ bytes: Buffer.from('plain'), executable: 'pwsh.exe' }),
    });
    expect(await reader.read(file)).toMatchObject({ text: 'plain', info: { reader: 'powershell' } });
  });
  it('retains the attempted executable on PowerShell errors', async () => {
    const executable = path.join(root, 'pwsh.exe');
    const reader = new ConfigurationReader({
      powershellRead: async () => {
        throw Object.assign(new Error('cmake.readDenied'), { executable });
      },
    });
    await expect(reader.read(file, { ...direct, mode: 'powershell' })).rejects.toMatchObject({
      diagnostic: { attempts: [{ reader: 'powershell', code: 'cmake.readDenied', executable }] },
    });
  });
  it('recovers direct access failure with PowerShell and records provenance', async () => {
    const reader = new ConfigurationReader({
      directRead: async () => {
        throw Object.assign(new Error('secret contents'), { code: 'EACCES' });
      },
      powershellRead: async () => ({ bytes: Buffer.from('recovered'), executable: 'pwsh.exe' }),
    });
    expect(await reader.read(file)).toEqual({
      text: 'recovered',
      info: { reader: 'powershell', encoding: 'utf-8', executable: 'pwsh.exe' },
    });
  });
  it('strictly rejects invalid UTF-8 without guessing GB18030, then accepts an explicit encoding', async () => {
    await fs.writeFile(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    const reader = new ConfigurationReader();
    await expect(reader.read(file, direct)).rejects.toMatchObject({
      diagnostic: { kind: 'read', attempts: [{ reader: 'direct', code: 'cmake.readDecode' }] },
    });
    expect((await reader.read(file, { ...direct, encoding: 'gb18030' })).text).toBe('\u4e2d\u6587');
  });
  it('accepts any ASCII-compatible encoding when the caller only scans ASCII tokens', async () => {
    await fs.writeFile(
      file,
      Buffer.concat([Buffer.from([0x23, 0xd6, 0xd0, 0xce, 0xc4, 0x0a]), Buffer.from('project(m C)')])
    );
    expect(await new ConfigurationReader().read(file, direct, 1024, true)).toMatchObject({
      text: expect.stringContaining('project(m C)'),
      info: { reader: 'direct', encoding: 'ascii-compatible' },
    });
  });
  it('still treats binary bytes as unreadable for ASCII scans so PowerShell can recover them', async () => {
    const reader = new ConfigurationReader({
      directRead: async () => Buffer.from([0x8f, 0x02, 0xc1, 0x00, 0x17, 0xff]),
      powershellRead: async () => ({ bytes: Buffer.from('project(m C)'), executable: 'pwsh.exe' }),
    });
    expect(await reader.read(file, undefined, 1024, true)).toMatchObject({
      text: 'project(m C)',
      info: { reader: 'powershell' },
    });
  });
  it('honors UTF-16 BOMs without a fallback', async () => {
    await fs.writeFile(file, Buffer.from('\ufeffhello', 'utf16le'));
    expect(await new ConfigurationReader().read(file)).toMatchObject({ text: 'hello', info: { encoding: 'utf-16le' } });
  });
  it('deduplicates simultaneous fallback reads and invalidates after file changes or clear', async () => {
    const fallback = vi.fn(async () => ({ bytes: Buffer.from('valid'), executable: 'pwsh.exe' }));
    const reader = new ConfigurationReader({ directRead: async () => Buffer.from([0xff]), powershellRead: fallback });
    await Promise.all(Array.from({ length: 10 }, () => reader.read(file)));
    await reader.read(file);
    expect(fallback).toHaveBeenCalledTimes(1);
    await fs.writeFile(file, 'changed size');
    await reader.read(file);
    reader.clear();
    await reader.read(file);
    expect(fallback).toHaveBeenCalledTimes(3);
  });
  it('caches fallback failures and preserves safe summaries of both attempts', async () => {
    const fallback = vi.fn(async () => {
      throw new Error('cmake.readTimeout');
    });
    const reader = new ConfigurationReader({ directRead: async () => Buffer.from([0xff]), powershellRead: fallback });
    for (let count = 0; count < 3; count++) {
      await expect(reader.read(file)).rejects.toMatchObject({
        diagnostic: {
          attempts: [
            { reader: 'direct', code: 'cmake.readDecode' },
            { reader: 'powershell', code: 'cmake.readTimeout' },
          ],
        },
      });
    }
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it('keeps independent pending reads alive across cache invalidation', async () => {
    const signals: AbortSignal[] = [];
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fallback = vi.fn(async (_file, _options, signal: AbortSignal) => {
      signals.push(signal);
      await ready;
      return { bytes: Buffer.from('valid'), executable: 'pwsh.exe' };
    });
    const reader = new ConfigurationReader({ powershellRead: fallback });
    const other = path.join(root, 'other.yaml');
    await fs.writeFile(other, 'other');
    const first = reader.read(file, { ...direct, mode: 'powershell' });
    const second = reader.read(other, { ...direct, mode: 'powershell' });
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(2));
    reader.clear();
    const notAborted = signals.every((signal) => !signal.aborted);
    finish();
    const results = await Promise.allSettled([first, second]);
    expect(notAborted).toBe(true);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    await reader.read(file, { ...direct, mode: 'powershell' });
    expect(fallback).toHaveBeenCalledTimes(3);
  });
  it('aborts pending reads even after cache invalidation and rejects reads after disposal', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const reader = new ConfigurationReader({
      powershellRead: async (_file, _options, signal) => {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cmake.readCancelled')), { once: true })
        );
      },
    });
    const pending = reader.read(file, { ...direct, mode: 'powershell' });
    const rejection = expect(pending).rejects.toThrow('cmake.readCancelled');
    await ready;
    reader.clear();
    await reader.dispose();
    await rejection;
    await expect(reader.read(file)).rejects.toThrow('cmake.readCancelled');
  });
  it('counts pending reads removed from the cache toward the concurrency limit', async () => {
    const fallback = vi.fn(
      async (_file, _options, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cmake.readCancelled')), { once: true });
        })
    );
    const reader = new ConfigurationReader({ powershellRead: fallback });
    const pending: Promise<unknown>[] = [];
    try {
      for (let index = 0; index < 8; index++) {
        pending.push(reader.read(file, { ...direct, mode: 'powershell' }).catch((error: unknown) => error));
        await vi.waitFor(() => expect(fallback).toHaveBeenCalledTimes(index + 1));
        reader.clear();
      }
      await expect(reader.read(file, { ...direct, mode: 'powershell' })).rejects.toThrow('cmake.readBusy');
    } finally {
      await reader.dispose();
      await Promise.all(pending);
    }
  });
  it('rejects oversized data even when supplied by a fallback', async () => {
    const reader = new ConfigurationReader({
      powershellRead: async () => ({ bytes: Buffer.alloc(17), executable: 'pwsh.exe' }),
    });
    await expect(reader.read(file, { ...direct, mode: 'powershell' }, 16)).rejects.toThrow('cmake.fileTooLarge');
  });
  it('does not retry syntax failures and excludes source snippets from diagnostics', async () => {
    await fs.writeFile(file, 'mode:\n  choices: [secret-content');
    const fallback = vi.fn();
    const result = await loadVariantConfiguration(
      root,
      root,
      undefined,
      new ConfigurationReader({ powershellRead: fallback })
    );
    expect(result.diagnostic).toMatchObject({ kind: 'syntax', line: expect.any(Number), column: expect.any(Number) });
    expect(JSON.stringify(result)).not.toContain('secret-content');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('falls through missing preferred files and preserves unsupported field errors', async () => {
    await fs.rename(file, path.join(root, 'cmake-variants.yml'));
    await fs.writeFile(path.join(root, 'cmake-variants.yml'), 'mode: {choices: {sim: {unknown: value}}}');
    const result = await loadVariantConfiguration(root);
    expect(result.diagnostic).toMatchObject({
      kind: 'unsupported',
      message: 'cmake.unsupportedVariants: mode.choices.sim.unknown',
      fieldPath: 'mode.choices.sim.unknown',
      supportedFields: ['short', 'long', 'description', 'buildType', 'settings', 'env'],
    });
    expect(result.file).toBe(path.join(root, 'cmake-variants.yml'));
  });
  it('uses the reader for VS Code settings discovery', async () => {
    await fs.mkdir(path.join(root, '.vscode'));
    await fs.writeFile(path.join(root, '.vscode/settings.json'), Buffer.from([0xff]));
    await fs.mkdir(path.join(root, 'firmware'));
    await fs.writeFile(path.join(root, 'firmware/CMakeLists.txt'), 'project(test)');
    const reader = new ConfigurationReader({
      powershellRead: async () => ({
        bytes: Buffer.from('{"cmake.sourceDirectory":"firmware"}'),
        executable: 'pwsh.exe',
      }),
    });
    expect((await discoverProjects(root, reader)).projects[0].relativePath).toBe('firmware');
  });
});
