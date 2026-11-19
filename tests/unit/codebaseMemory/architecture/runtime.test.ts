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
 * Stands in for the indexer: index_repository succeeds, query_graph answers from graph.json
 * in the project (call edges with lines, callers by name, variables, files or functions),
 * and check_index_coverage from coverage.json when the project has one.
 */
const FIXTURE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const tool = args[args.indexOf('--json') + 1];
let result = { nodes: 1 };
if (tool === 'query_graph') {
  const graph = JSON.parse(fs.readFileSync('graph.json', 'utf8'));
  const query = JSON.parse(args[args.length - 1]).query;
  const rows = query.includes('a.start_line')
    ? graph.edges || []
    : query.includes('CALLS')
      ? graph.callers
      : query.includes('Variable')
        ? graph.variables || []
        : query.includes('(f:File)')
          ? (graph.files || []).map((file) => [file])
          : graph.functions;
  result = { rows, has_more: false };
}
if (tool === 'check_index_coverage' && fs.existsSync('coverage.json'))
  result = JSON.parse(fs.readFileSync('coverage.json', 'utf8'));
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
        Buffer.from('    TASK(SENSOR_Second), // '),
        Buffer.from([0xb1, 0xd8, 0xd0, 0xeb, 0xd7, 0xee, 0xcf, 0xc8]),
      ]).toString('latin1'),
      '    TASK(TICK_Second),',
      '};',
      'void vMainTask(void *p)',
      '{',
      '    for (;;) { for (int i = 0; i < 2; i++) secondList[i].func(); vTaskDelay(25); }',
      '}',
      'void appInit(void)',
      '{',
      '    xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);',
      '}',
      '',
    ].join('\n')
  );
  // Rewrite as raw bytes so the GBK comment is not re-encoded as UTF-8.
  fs.writeFileSync(
    path.join(repo, 'app/task.c'),
    Buffer.from(fs.readFileSync(path.join(repo, 'app/task.c'), 'utf8'), 'latin1')
  );
  write('app/sensor.c', 'void SENSOR_Second(void)\n{\n}\n');
  write('app/tick.c', 'void TICK_Second(void)\n{\n}\n');
  write(
    'graph.json',
    JSON.stringify({
      functions: [
        ['vMainTask', 'app/task.c', '6', '9'],
        ['appInit', 'app/task.c', '10', '13'],
        ['SENSOR_Second', 'app/sensor.c', '1', '3'],
        ['TICK_Second', 'app/tick.c', '1', '3'],
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
async function indexed(service: ReturnType<typeof runtime>, language?: string) {
  await service.start(repo, language ? { language } : {});
  let result = await service.get(repo);
  for (let i = 0; i < 150 && result.phase === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = await service.get(repo);
  }
  return result;
}

describe('architecture file in the project runtime', () => {
  it('is written by the first index, then kept up to date by every index without touching the team rules', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await expect(service.architecture(repo, { language: 'zh-CN' })).rejects.toThrow(/Index the project/);
    // The first index creates the file in the language of the panel that started it.
    const first = await indexed(service, 'zh-CN');
    expect(first.architecture).toMatchObject({ tasks: 1, tables: 1, language: 'zh-CN' });
    expect(fs.readFileSync(architectureFile(), 'utf8')).toContain('language=zh-CN');

    const status = await service.architecture(repo, { language: 'zh-CN' });
    expect(status.architecture).toMatchObject({ tasks: 1, tables: 1, language: 'zh-CN' });
    const created = fs.readFileSync(architectureFile(), 'utf8');
    expect(created).toContain('## 任务');
    expect(created).toContain('| 1 | `SENSOR_Second` | app/sensor.c:1 | — | 必须最先 |');
    expect(created).toContain('- `secondList` #1 `SENSOR_Second`: 必须最先');

    const rule = '- 新的秒任务加在 TICK_Second 之后。\n';
    fs.writeFileSync(architectureFile(), created + rule);
    const after = await indexed(service);
    expect(after.architecture?.generatedAt).toBeGreaterThanOrEqual(status.architecture!.generatedAt!);
    const updated = fs.readFileSync(architectureFile(), 'utf8');
    expect(updated.endsWith(rule)).toBe(true);
    // An update keeps the file's language whatever the caller passes.
    expect(updated).toContain('language=zh-CN');
  });

  it('leaves a project that is not C or C++ alone until the panel asks for the file', async () => {
    fs.rmSync(path.join(repo, 'app'), { recursive: true });
    for (const name of ['a', 'b', 'c']) write(`web/${name}.ts`, 'export const value = 1;\n');
    write('graph.json', JSON.stringify({ functions: [], callers: [] }));
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'fast' });
    expect((await indexed(service, 'en-US')).architecture).toBeUndefined();
    expect(fs.existsSync(architectureFile())).toBe(false);
    expect((await service.architecture(repo, { language: 'en-US' })).architecture?.language).toBe('en-US');
  });

  it('keeps a good file when this process reads the source as ciphertext', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await indexed(service);
    await service.architecture(repo, { language: 'en-US' });
    const good = fs.readFileSync(architectureFile(), 'utf8');
    // A chat's index runs in a node.exe the encryption client may not list.
    const ciphertext = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    for (const file of ['app/task.c', 'app/sensor.c', 'app/tick.c']) write(file, ciphertext);
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

describe('module expert cards in the project runtime', () => {
  const card = () => fs.readFileSync(path.join(repo, '.woody', 'features', 'sensor.md'), 'utf8');
  const experts = (paths = ['app/sensor.c']) =>
    write(
      '.woody/experts.json',
      JSON.stringify({
        version: 1,
        experts: [{ id: 'sensor', name: 'Sensor expert', summary: 'Reads the sensor.', paths }],
        shared: ['app/task.c'],
      })
    );
  beforeEach(() => {
    write('app/sensor.c', 'int sensorLevel;\nvoid SENSOR_Second(void)\n{\n}\n');
    write('app/tick.c', 'void TICK_Second(void)\n{\n    sensorLevel = 1;\n    SENSOR_Second();\n}\n');
    write(
      'graph.json',
      JSON.stringify({
        functions: [
          ['vMainTask', 'app/task.c', '6', '9'],
          ['appInit', 'app/task.c', '10', '13'],
          ['SENSOR_Second', 'app/sensor.c', '2', '4'],
          ['TICK_Second', 'app/tick.c', '1', '5'],
        ],
        callers: [['appInit', 'app/task.c', 'main']],
        files: ['app/task.c', 'app/sensor.c', 'app/tick.c'],
        edges: [['TICK_Second', 'app/tick.c', '1', 'SENSOR_Second', 'app/sensor.c']],
        variables: [],
      })
    );
    write(
      'coverage.json',
      JSON.stringify({
        paths: [
          {
            path: 'app/sensor.c',
            status: 'partial',
            freshness: 'metadata_match',
            coverage: [{ kind: 'parse_partial', ranges: [{ start: 1, end: 1 }] }],
          },
        ],
      })
    );
    experts();
  });

  it('writes a brief per expert after every index and follows what the expert writes', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    const status = await indexed(service, 'en-US');
    expect(status.architecture?.modules).toEqual([
      expect.objectContaining({ id: 'sensor', files: ['app/sensor.c'], tables: ['secondList'], experts: ['sensor'] }),
      expect.objectContaining({ id: 'tick', files: ['app/tick.c'], tables: ['secondList'], experts: [] }),
    ]);
    expect(fs.readFileSync(architectureFile(), 'utf8')).toContain(
      '| `sensor` | app/sensor.c | `secondList`: `SENSOR_Second` | `sensor` |'
    );

    const brief = card();
    expect(brief.startsWith('# Sensor expert\n\n<!-- woody:generated:start -->')).toBe(true);
    expect(brief).toContain('`secondList` #1: `SENSOR_Second`; run by `vMainTask`');
    expect(brief).toContain('`SENSOR_Second` (app/sensor.c:2) ← `TICK_Second` (app/tick.c:4, tick (unowned))');
    expect(brief).toContain(
      '`sensorLevel` (app/sensor.c:1) [not in the index graph]: written in `TICK_Second` (app/tick.c:3)'
    );
    expect(brief).toContain('app/sensor.c: lines 1 were only partly parsed');

    let cards = await service.moduleCards(repo, {});
    expect(cards.experts).toEqual([
      expect.objectContaining({ id: 'sensor', state: 'missing', card: '.woody/features/sensor.md' }),
    ]);
    expect(cards.experts[0].digest).toMatchObject({
      entries: ['secondList #1 SENSOR_Second'],
      provides: [{ name: 'SENSOR_Second', callers: ['tick (unowned)'] }],
      writtenOutside: ['sensorLevel'],
      issues: { partial: 1, missingGlobals: 1 },
    });

    // The expert writes its part of the card.
    fs.appendFileSync(
      path.join(repo, '.woody', 'features', 'sensor.md'),
      '\n## Flow\n\nReads the level every second.\n'
    );
    cards = await service.moduleCards(repo, {});
    expect(cards.experts[0].state).toBe('ready');

    // The module's code changes after that: the card needs checking again, also after an index.
    write('app/sensor.c', 'int sensorLevel;\nvoid SENSOR_Second(void)\n{\n    sensorLevel++;\n}\n');
    expect((await service.moduleCards(repo, {})).experts[0].state).toBe('stale');
    await indexed(service);
    expect((await service.moduleCards(repo, {})).experts[0].state).toBe('stale');
    expect(card()).toContain('## Flow\n\nReads the level every second.\n');
    expect(card().match(/woody:generated:start/g)).toHaveLength(1);

    fs.appendFileSync(path.join(repo, '.woody', 'features', 'sensor.md'), 'Checked again.\n');
    expect((await service.moduleCards(repo, {})).experts[0].state).toBe('ready');
  });

  it('writes a missing brief on request and keeps going when one card or the experts file is unusable', async () => {
    const service = runtime();
    await service.save(repo, { version: 1, enabled: true, mode: 'full' });
    await indexed(service, 'en-US');

    // New paths: the old brief no longer describes the expert until it is written again.
    experts(['app/sensor.c', 'app/tick.c']);
    expect((await service.moduleCards(repo, {})).experts[0].state).toBe('nobrief');
    const refreshed = await service.moduleCards(repo, { refresh: true, ids: [] });
    expect(refreshed.experts[0].state).toBe('missing');
    expect(card()).toContain('app/tick.c: 1 functions in the index (`TICK_Second`)');

    // A card Woody cannot read is never replaced.
    const ciphertext = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    write('.woody/features/sensor.md', ciphertext);
    const status = await indexed(service);
    expect(status.phase).toBe('succeeded');
    expect(status.moduleCards?.experts.sensor).toMatchObject({ state: 'error', error: expect.stringMatching(/UTF-8/) });
    expect(fs.readFileSync(path.join(repo, '.woody', 'features', 'sensor.md'))).toEqual(ciphertext);

    write('.woody/experts.json', '{ not json');
    const broken = await indexed(service);
    expect(broken.phase).toBe('succeeded');
    expect(broken.moduleCards?.error).toMatch(/not valid JSON/);
    await expect(service.moduleCards(repo, {})).rejects.toThrow(/not valid JSON/);
  });
});
