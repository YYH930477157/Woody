import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GdbService } from '@/process/services/cmake/gdb/gdbService';

describe.skipIf(!process.env.WOODY_TEST_GDB || !process.env.WOODY_TEST_GCC)('real GDB launch smoke', () => {
  it('stops at main, reads registers, breaks, steps, and releases the process', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'woody-gdb-real-')));
    const executable = path.join(root, 'meter.exe');
    const gdbPath = process.env.WOODY_TEST_GDB!;
    const gcc = process.env.WOODY_TEST_GCC!;
    const env = { ...process.env, PATH: `${path.dirname(gcc)}${path.delimiter}${process.env.PATH}` };
    const release = vi.fn();
    const service = new GdbService(async () => ({
      projectPath: root,
      buildDirectory: root,
      executable,
      args: ['two words', 'semi;literal'],
      gdbPath,
      env,
      release,
    }));
    try {
      await promisify(execFile)(gcc, ['-g', '-O0', path.resolve('tests/unit/gdb/meter.c'), '-o', executable], {
        env,
        windowsHide: true,
        timeout: 30000,
      });
      expect((await stat(executable)).size).toBeGreaterThan(1024);
      const start = await service.request({ projectPath: root, operation: 'start' });
      const input = { projectPath: root, sessionId: start.session!.id };
      const stopped = async () => {
        await vi.waitFor(
          async () => {
            const result = await service.request({ projectPath: root, operation: 'status' });
            if (result.session?.state === 'failed')
              throw new Error(`${result.session.error}\n${result.session.output}`);
            expect(result.session?.state).toBe('stopped');
          },
          { timeout: 15000, interval: 100 }
        );
      };
      await stopped();
      expect((await service.request({ ...input, operation: 'evaluate', expression: 'meter.status' })).value).toBe('7');
      const pointer = (await service.request({ ...input, operation: 'evaluate', expression: 'meterAddress' })).value!;
      const memory = await service.request({
        ...input,
        operation: 'memory',
        address: /^0x[\da-f]+/i.exec(pointer)![0],
        count: 8,
      });
      expect(memory.memory?.[0].contents).toBe('0700000000000000');
      await service.request({ ...input, operation: 'breakpointAdd', location: 'sample' });
      await service.request({ ...input, operation: 'continue' });
      await stopped();
      expect((await service.request({ ...input, operation: 'stack' })).stack?.[0].func).toBe('sample');
      expect(
        (await service.request({ projectPath: root, operation: 'status' })).session?.output.replace(/\r/g, '')
      ).toContain('*[hello\npartial');
      await service.request({ ...input, operation: 'finish' });
      await stopped();
      expect((await service.request({ ...input, operation: 'evaluate', expression: 'meter.status' })).value).toBe('9');
      expect((await service.request({ ...input, operation: 'evaluate', expression: 'argumentCount' })).value).toBe('3');
      expect((await service.request({ ...input, operation: 'evaluate', expression: 'firstArgument' })).value).toContain(
        'two words'
      );
      await service.request({ ...input, operation: 'continue' });
      await service.request({ ...input, operation: 'pause' });
      await stopped();
      expect((await service.request({ ...input, operation: 'evaluate', expression: 'meter.status' })).value).toBe('9');
      await service.request({ ...input, operation: 'stop' });
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
});
