import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitExecutor } from '@process/services/sourceControl/workbench/executor';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(process.platform !== 'win32')('owned Windows Git process trees', () => {
  it.each(['abort', 'timeout', 'stdout', 'stderr'] as const)(
    'terminates owned alias children after %s',
    async (mode) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'woody-process-tree-'));
      const pidFile = path.join(root, 'pids.json');
      const fixture = path.join(root, 'tree.cjs');
      const signal = new AbortController();
      let pids: number[] = [];
      let pending: Promise<unknown> | undefined;
      try {
        execFileSync('git', ['init', '-q', root], { windowsHide: true });
        await writeFile(
          fixture,
          `const fs = require('node:fs');
const {spawn} = require('node:child_process');
if (process.argv[2] === 'leaf') { setInterval(() => {}, 1000); }
else {
  const child = spawn(process.execPath, [__filename, 'leaf'], {windowsHide:true, stdio:'inherit'});
  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));
  ${mode === 'stdout' || mode === 'stderr' ? `setTimeout(() => setInterval(() => process.${mode}.write('x'.repeat(16384)), 10), 300);` : ''}
  setInterval(() => {}, 1000);
}
`
        );
        // Only this test-owned alias is a shell command; production invokes a fixed executable with argv.
        const quote = (value: string) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
        execFileSync(
          'git',
          ['-C', root, 'config', 'alias.owned-tree', `!${quote(process.execPath)} ${quote(fixture)}`],
          { windowsHide: true }
        );
        pending = createGitExecutor()(root, ['owned-tree'], false, {
          signal: signal.signal,
          timeoutMs: mode === 'timeout' ? 2000 : 10000,
          maxBuffer: 1024,
          truncate: mode === 'stdout',
        });
        const settled = pending.then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
        const deadline = Date.now() + 5000;
        while (!pids.length && Date.now() < deadline) {
          try {
            pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[];
          } catch {
            await sleep(25);
          }
        }
        expect(pids).toHaveLength(2);
        expect(pids.every(alive)).toBe(true);
        if (mode === 'abort') signal.abort();
        const outcome = await settled;
        if (mode === 'stdout') expect(outcome).toMatchObject({ result: { truncated: true, code: 0 } });
        else expect(outcome).toHaveProperty('error');
        expect(pids.filter(alive), 'owned descendants must exit before the executor releases the operation').toEqual(
          []
        );
      } finally {
        signal.abort();
        // Cleanup only the exact PIDs recorded by this fixture, never name-based process matching.
        for (const pid of pids.reverse()) {
          if (!alive(pid)) continue;
          try {
            if (process.platform === 'win32')
              execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
                timeout: 5000,
              });
            else process.kill(pid, 'SIGKILL');
          } catch {
            /* It may have exited between the probe and cleanup. */
          }
        }
        await pending?.catch(() => undefined);
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    20000
  );
});
