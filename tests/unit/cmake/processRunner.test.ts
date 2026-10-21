import { describe, expect, it } from 'vitest';
import { runProcess, createOutputDecoder } from '../../../packages/desktop/src/process/services/cmake/processRunner';

describe('CMake process runner', () => {
  it('reports missing executable as a rejected operation', async () => {
    await expect(
      runProcess({
        executable: 'woody-tool-does-not-exist',
        args: [],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 3000,
        signal: new AbortController().signal,
        onOutput: () => {},
      })
    ).rejects.toThrow();
  });
  it('preserves argument boundaries and captures nonzero exit', async () => {
    let output = '';
    const result = await runProcess({
      executable: process.execPath,
      args: ['-e', 'console.log(process.argv[1]);process.exit(7)', 'space & literal'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 3000,
      signal: new AbortController().signal,
      onOutput: (text) => {
        output += text;
      },
    });
    expect(output).toContain('space & literal');
    expect(result.code).toBe(7);
  });
  it('terminates a running child on cancellation before resolving', async () => {
    const controller = new AbortController();
    const running = runProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>console.log("alive"),20)'],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
      signal: controller.signal,
      onOutput: () => controller.abort(),
    });
    await expect(running).rejects.toThrow(/cancelled/);
  });
  it('terminates a stalled child on timeout', async () => {
    await expect(
      runProcess({
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 50,
        signal: new AbortController().signal,
        onOutput: () => {},
      })
    ).rejects.toThrow(/timeout/);
  });
  it('waits for descendant termination as well as the immediate process', async () => {
    const controller = new AbortController();
    let childPid = 0;
    await expect(
      runProcess({
        executable: process.execPath,
        args: [
          '-e',
          'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)',
        ],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5000,
        signal: controller.signal,
        onOutput: (text) => {
          if (text.trim()) {
            childPid = Number(text.trim());
            controller.abort();
          }
        },
      })
    ).rejects.toThrow(/cancelled/);
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).toThrow();
  });
  it('decodes split UTF-8 and Windows ANSI lines without corrupting characters', () => {
    let utf8 = '';
    const first = createOutputDecoder(936, (text) => {
      utf8 += text;
    });
    const bytes = Buffer.from('\u4e2d\u6587\n', 'utf8');
    first.write(bytes.subarray(0, 1));
    first.write(bytes.subarray(1, 4));
    first.write(bytes.subarray(4));
    first.end();
    expect(utf8).toBe('\u4e2d\u6587\n');
    let ansi = '';
    const second = createOutputDecoder(936, (text) => {
      ansi += text;
    });
    second.write(Buffer.from([0xd6]));
    second.write(Buffer.from([0xd0, 0xce, 0xc4, 10]));
    second.end();
    expect(ansi).toBe('\u4e2d\u6587\n');
  });
});
