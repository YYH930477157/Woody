import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const source = readFileSync('scripts/build-with-builder.js', 'utf8');

describe('installer preparation failure', () => {
  it('stops even a cached packaging-only build before invoking compilation or packaging', () => {
    const launched: string[][] = [];
    let buildCommands = 0;
    const buildProcess = {
      argv: ['node', 'build-with-builder.js', 'auto', '--win', '--x64', '--skip-vite', '--pack-only'],
      env: {},
      platform: 'linux',
      arch: 'x64',
      execPath: process.execPath,
      exitCode: 0,
    };
    vm.runInNewContext(`(function () { ${source.replace(/^#!.*\n/, '')}\n})()`, {
      __dirname: path.resolve('scripts'),
      process: buildProcess,
      console: { log() {}, warn() {}, error() {} },
      require: (name: string) => {
        if (name === 'child_process') {
          return {
            spawnSync: (_executable: string, args: string[]) => {
              launched.push(args);
              return { status: 1 };
            },
            execSync: () => {
              buildCommands++;
              throw new Error('Build must stop on a missing required offline asset');
            },
          };
        }
        if (name.startsWith('./')) return require(path.resolve('scripts', name));
        return require(name);
      },
    });
    expect(launched).toEqual([[path.resolve('scripts/bundled-mcp/prepareCodebaseMemory.js'), 'win32', 'x64']]);
    expect(buildCommands).toBe(0);
    expect(buildProcess.exitCode).toBe(1);
  });
});
