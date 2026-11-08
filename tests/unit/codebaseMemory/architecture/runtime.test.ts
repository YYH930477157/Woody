import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = path.resolve('resources/bundled-mcp/codebase-memory/runtime.cjs');
let root: string;
let repo: string;
const disposables: Array<{ dispose(): void }> = [];

/**
 * Stands in for the indexer: index_repository succeeds, and query_graph answers from
 * graph.json in the project (functions, or callers when the query asks for CALLS).
 */
const FIXTURE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const tool = args[args.indexOf('--json') + 1];
let result = { nodes: 1 };
if (tool === 'query_graph') {
  const graph = JSON.parse(fs.readFileSync('graph.json', 'utf8'));
  const query = JSON.parse(args[args.length - 1]).query;
  result = { rows: query.includes('CALLS') ? graph.callers : graph.functions, has_more: false };
}
console.log(JSON.stringify({ isError: false, structuredContent: result }));
`;

function runtime() {
  const { createRuntime } = require(runtimePath);
  const value = createRuntime({
    binaryPath: process.execPath,
    binaryArgs: [path.join(root, 'fixture.cjs')],
    cacheRoot: path.join(root, 'cache'),
    adapterPath: path.resolve('resources/bundled-mcp/codebase-memory/index.cjs'),
    skillPath: '/skill',
    powerShell: null,
  });
  disposables.push(value);
  return value;
}
const write = (name: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), data);
};
const architectureFile = () => path.join(repo, '.woody', 'architecture.md');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-architecture-test-'));
  repo = path.join(root, 'firmware');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(root, 'fixture.cjs'), FIXTURE);
  write(
    'app/task.c',
    [
      'static const tTask secondList[] =',
      '{',
      // "// 必须最先" (must run first) in GBK, as an editor on a Chinese system saves it.
      Buffer.concat([
        Buffer.from('    TASK(ALARM_Second), // '),
        Buffer.from([0xb1, 0xd8, 0xd0, 0xeb, 0xd7, 0xee, 0xcf, 0xc8]),
      ]).toString('latin1'),
      '    TASK(CLOCK_Second),',
      '};',
      'void vMeterTask(void *p)',
      '{',
      '    for (;;) { for (int i = 0; i < 2; i++) secondList[i].func(); vTaskDelay(25); }',
      '}',
      'void appInit(void)',
      '{',
      '    xTaskCreate(vMeterTask, "meter", 512, NULL, 3, NULL);',
      '}',
      '',
    ].join('\n')
  );
  // Rewrite as raw bytes so the GBK comment is not re-encoded as UTF-8.
  fs.writeFileSync(
    path.join(repo, 'app/task.c'),
    Buffer.from(fs.readFileSync(path.join(repo, 'app/task.c'), 'utf8'), 'latin1')
  );
  write('app/alarm.c', 'void ALARM_Second(void)\n{\n}\n');
  write('app/clock.c', 'void CLOCK_Second(void)\n{\n}\n');
  write(
    'graph.json',
    JSON.stringify({
      functions: [
        ['vMeterTask', 'app/task.c', '6', '9'],
        ['appInit', 'app/task.c', '10', '13'],
        ['ALARM_Second', 'app/alarm.c', '1', '3'],
        ['CLOCK_Second', 'app/clock.c', '1', '3'],
      ],
      callers: [['appInit', 'app/task.c', 'main']],
    })
  );
});
afterEach(() => {
  for (const value of disposables.splice(0)) value.dispose();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
// Polling observes state transitions and must remain sequential.
/* eslint-disable no-await-in-loop */
async function indexed(service: ReturnType<typeof runtime>) {
  await service.start(repo);
  let result = await service.get(repo);
  for (let i = 0; i < 150 && result.phase === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await service.get(repo);
  }
  return result;
}

describe('architecture file in the project runtime', () => {
  it('is written on request, then kept up to date by every index without touching the team rules', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await expect(service.architecture(repo, { language: 'zh-CN' })).rejects.toThrow(/Index the project/);
    // Indexing alone never creates the file.
    expect((await indexed(service)).architecture).toBeUndefined();
    expect(fs.existsSync(architectureFile())).toBe(false);

    const status = await service.architecture(repo, { language: 'zh-CN' });
    expect(status.architecture).toMatchObject({ tasks: 1, tables: 1, language: 'zh-CN' });
    const created = fs.readFileSync(architectureFile(), 'utf8');
    expect(created).toContain('## 任务');
    expect(created).toContain('| 1 | `ALARM_Second` | app/alarm.c:1 | — | 必须最先 |');
    expect(created).toContain('- `secondList` #1 `ALARM_Second`: 必须最先');

    const rule = '- 新的秒任务加在 CLOCK_Second 之后。\n';
    fs.writeFileSync(architectureFile(), created + rule);
    const after = await indexed(service);
    expect(after.architecture?.generatedAt).toBeGreaterThanOrEqual(status.architecture!.generatedAt!);
    const updated = fs.readFileSync(architectureFile(), 'utf8');
    expect(updated.endsWith(rule)).toBe(true);
    // An update keeps the file's language whatever the caller passes.
    expect(updated).toContain('language=zh-CN');
  });

  it('keeps a good file when this process reads the source as ciphertext', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await indexed(service);
    await service.architecture(repo, { language: 'en-US' });
    const good = fs.readFileSync(architectureFile(), 'utf8');
    // A chat's index runs in a node.exe the encryption client may not list.
    const ciphertext = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    for (const file of ['app/task.c', 'app/alarm.c', 'app/clock.c']) write(file, ciphertext);
    await expect(service.architecture(repo, { language: 'en-US' })).rejects.toThrow(
      /reads 3 of 3 source files as ciphertext/
    );
    expect((await indexed(service)).architecture?.error).toMatch(/left unchanged/);
    expect(fs.readFileSync(architectureFile(), 'utf8')).toBe(good);
  });

  it('never overwrites a file it cannot use, and forgets a file the user deleted', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await indexed(service);
    write('.woody/architecture.md', '# Our own notes\n');
    await expect(service.architecture(repo, { language: 'en-US' })).rejects.toThrow(/no woody:generated markers/);
    // After an index the failure is reported in the status, and the file is unchanged.
    expect((await indexed(service)).architecture?.error).toMatch(/no woody:generated markers/);
    expect(fs.readFileSync(architectureFile(), 'utf8')).toBe('# Our own notes\n');

    const ciphertext = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    write('.woody/architecture.md', ciphertext);
    await expect(service.architecture(repo, { language: 'en-US' })).rejects.toThrow(/cannot read/);
    expect(fs.readFileSync(architectureFile())).toEqual(ciphertext);

    fs.rmSync(architectureFile());
    expect((await service.get(repo)).architecture).toBeUndefined();
    expect((await service.architecture(repo, { language: 'xx-XX' })).architecture?.language).toBe('en-US');
  });
});
