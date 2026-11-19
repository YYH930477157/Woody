import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const architecture = require(path.resolve('resources/bundled-mcp/codebase-memory/lib/architecture.cjs'));
const modules = require(path.resolve('resources/bundled-mcp/codebase-memory/lib/modules.cjs'));
const labels = require(path.resolve('resources/bundled-mcp/codebase-memory/lib/architecture-labels.json')) as Record<
  string,
  Record<string, string>
>;

type Expert = { id: string; name: string; paths: string[] };
type Row = [string, string, string, string];

const source = (files: Record<string, string>) => modules.sourceCache((file: string) => files[file] ?? null);

/** An analysis of a project whose main task runs `secondList`, with the given entries. */
async function analysis(files: Record<string, string>, functions: Row[]) {
  return architecture.analyze({
    functions,
    sourceFiles: Object.keys(files),
    readSource: (file: string) => files[file] ?? null,
    callersOf: async () => new Map([['appInit|app/task.c', ['main']]]),
  });
}

const TASK = [
  'static const tTask secondList[] =',
  '{',
  '    TASK(SENSOR_Second),',
  '    TASK(UI_Second),',
  '    TASK(TICK_Second),',
  '};',
  'void vMainTask(void *p)',
  '{',
  '    for (;;) { for (int i = 0; i < 3; i++) secondList[i].func(); vTaskDelay(25); }',
  '}',
  'void appInit(void)',
  '{',
  '    xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);',
  '}',
  '',
].join('\n');

const TASK_FUNCTIONS: Row[] = [
  ['vMainTask', 'app/task.c', '7', '10'],
  ['appInit', 'app/task.c', '11', '14'],
];

describe('module ownership', () => {
  const experts: Expert[] = [
    { id: 'sensor', name: 'Sensor', paths: ['src/sensor/', 'src/sensor/ui_*.c'] },
    { id: 'ui', name: 'UI', paths: ['src/ui.c', 'src/sensor/ui_*'] },
  ];

  it('gives a file to the longest matching entry, the expert listed first on a tie, and shared files last', () => {
    expect(modules.ownerOf('src/sensor/read.c', experts, [])).toBe('sensor');
    expect(modules.ownerOf('src/ui.c', experts, [])).toBe('ui');
    // `src/sensor/ui_*.c` and `src/sensor/ui_*` both match; the longer entry wins.
    expect(modules.ownerOf('src/sensor/ui_draw.c', experts, [])).toBe('sensor');
    expect(modules.ownerOf('src/sensor/ui_draw.h', experts, [])).toBe('ui');
    // `*` stays inside one path segment.
    expect(modules.ownerOf('src/sensor/ui_x/deep.c', experts, [])).toBe('sensor');
    expect(modules.ownerOf('src/task.c', experts, ['src/task.c'])).toBe('shared');
    expect(modules.ownerOf('src/other.c', experts, ['src/task.c'])).toBeUndefined();
  });
});

describe('module classification', () => {
  it('starts a module from each file in a dispatch table and adds its header and same-prefix files', async () => {
    const files = {
      'app/task.c': TASK,
      'app/sensor.c': 'void SENSOR_Second(void)\n{\n}\nvoid SENSOR_Read(void)\n{\n}\n',
      'app/sensor_cal.c': 'void SENSOR_Cal(void)\n{\n}\n',
      'app/sensor.h': 'void SENSOR_Second(void);\n',
      'proto/ui.c': 'void UI_Second(void)\n{\n}\n',
      'drv/ui.c': 'void UI_Draw(void)\n{\n}\n',
      'app/tick.c': 'void TICK_Second(void)\n{\n}\n',
      'thirdparty/lib/sensor_port.c': 'void SENSOR_Port(void)\n{\n}\n',
      'proto/cmd_a.c': 'void CMD_A(void)\n{\n}\n',
    };
    const functions: Row[] = [
      ...TASK_FUNCTIONS,
      ['SENSOR_Second', 'app/sensor.c', '1', '3'],
      ['SENSOR_Read', 'app/sensor.c', '4', '6'],
      ['SENSOR_Cal', 'app/sensor_cal.c', '1', '3'],
      ['UI_Second', 'proto/ui.c', '1', '3'],
      ['UI_Draw', 'drv/ui.c', '1', '3'],
      ['TICK_Second', 'app/tick.c', '1', '3'],
      ['SENSOR_Port', 'thirdparty/lib/sensor_port.c', '1', '3'],
      ['CMD_A', 'proto/cmd_a.c', '1', '3'],
    ];
    const model = await analysis(files, functions);
    const found = modules.classify({
      model,
      functions,
      files: Object.keys(files),
      experts: [{ id: 'sensor-expert', name: 'Sensor', paths: ['app/sensor.c'] }],
      shared: [],
    });
    expect(found).toEqual([
      {
        id: 'sensor',
        files: ['app/sensor.c', 'app/sensor.h', 'app/sensor_cal.c'],
        prefix: 'SENSOR',
        tables: [{ table: 'secondList', functions: ['SENSOR_Second'] }],
        experts: ['sensor-expert'],
      },
      expect.objectContaining({ id: 'tick', files: ['app/tick.c'] }),
      // A file in another folder joins by prefix; files in library folders never join.
      expect.objectContaining({ id: 'ui', files: ['proto/ui.c', 'drv/ui.c'], experts: [] }),
    ]);
    const text = modules.renderModules(found, labels['en-US']);
    expect(text).toContain('## Modules');
    expect(text).toContain(
      '| `sensor` | app/sensor.c, app/sensor.h, app/sensor_cal.c | `secondList`: `SENSOR_Second` | `sensor-expert` |'
    );
  });

  it('does not attach files whose prefix names a whole layer', async () => {
    const files: Record<string, string> = {
      'app/task.c': TASK.replace('TASK(UI_Second),', '').replace('TASK(TICK_Second),', ''),
      'app/sensor.c': 'void SENSOR_Second(void)\n{\n}\n',
    };
    const functions: Row[] = [...TASK_FUNCTIONS, ['SENSOR_Second', 'app/sensor.c', '1', '3']];
    for (const name of ['a', 'b', 'c', 'd']) {
      files[`app/ic/${name}.c`] = `void SENSOR_${name}(void)\n{\n}\n`;
      functions.push([`SENSOR_${name}`, `app/ic/${name}.c`, '1', '3']);
    }
    const model = await analysis(files, functions);
    const [found] = modules.classify({ model, functions, files: Object.keys(files) });
    expect(found.files).toEqual(['app/sensor.c']);
  });
});

describe('source scanning', () => {
  it('finds globals the index misses, and skips prototypes, types and externs', () => {
    const prepared = source({
      'a.c': [
        'extern int other;',
        'typedef struct { int a; } tPara;',
        'struct tag { int b; };',
        'static tPara SensorPara = { 1 };',
        'int levels[SIZE(4)], *cursor;',
        '__no_init uint8_t buffer[16];',
        '#if FEATURE_X',
        'uint16_t onlyWithX;',
        '#endif',
        '#if 0',
        'int dead;',
        '#endif',
        'struct { int c; } anonymous;',
        'void (*handler)(void) = NULL;',
        'int sum(int a, int b);',
        'int value __attribute__((section(".noinit")));',
        'void run(void)',
        '{',
        '    int local = 0;',
        '}',
        '',
      ].join('\n'),
    })('a.c');
    const found = modules.globalsOf(prepared);
    expect(found.map((item: { name: string }) => item.name)).toEqual([
      'SensorPara',
      'levels',
      'cursor',
      'buffer',
      'onlyWithX',
      'anonymous',
      'handler',
      'value',
    ]);
    expect(found[0]).toMatchObject({ isStatic: true, line: 4 });
    expect(found.find((item: { name: string }) => item.name === 'levels')).toMatchObject({ array: true });
    expect(found.find((item: { name: string }) => item.name === 'onlyWithX')).toMatchObject({
      conditions: ['FEATURE_X'],
    });
  });

  it('finds function definitions, also through a macro, outside #if 0', () => {
    const prepared = source({
      'a.c': 'static void a(void)\n{\n}\nHANDLER(b)\n{\n}\n#if 0\nvoid c(void)\n{\n}\n#endif\n',
    })('a.c');
    expect(modules.definitionsOf(prepared)).toEqual([
      { name: 'a', line: 1, conditions: [] },
      { name: 'HANDLER', line: 4, conditions: [] },
    ]);
  });

  it('tells writes, taken addresses and reads apart', () => {
    const kind = (text: string) => modules.accessKind(text, text.indexOf('level'), 'level');
    expect(kind('level = 1;')).toBe('write');
    expect(kind('level[2].x += 1;')).toBe('write');
    expect(kind('++level;')).toBe('write');
    expect(kind('level->count--;')).toBe('write');
    expect(kind('save(&level);')).toBe('address');
    expect(kind('if (a && level == 2)')).toBe('read');
    expect(kind('x = level.max;')).toBe('read');
  });
});

describe('expert brief', () => {
  const files: Record<string, string> = {
    'app/task.c': TASK,
    'app/sensor.c': [
      'int sensorLevel;',
      'static int sensorCount;',
      '#define SENSOR_PARA_ADDR (NVM_BASE + 0x10)',
      'void SENSOR_Second(void)',
      '{',
      '#if SENSOR_FAST',
      '    nvmWrite(SENSOR_PARA_ADDR, &sensorCount);',
      '#endif',
      '}',
      'TICK_HOOK(sensorTick)',
      '{',
      '}',
      '',
    ].join('\n'),
    'app/sensor.h': '#ifndef __SENSOR_H__\n#define __SENSOR_H__\nvoid SENSOR_Second(void);\n#endif\n',
    'app/ui.c': 'void UI_Second(void)\n{\n    show(sensorLevel);\n    SENSOR_Second();\n}\n',
    'app/tick.c': 'void TICK_Second(void)\n{\n    sensorLevel = 0;\n}\n',
    'drv/nvm.c': 'void nvmWrite(int a, void *p)\n{\n}\n',
  };
  const functions: Row[] = [
    ...TASK_FUNCTIONS,
    ['SENSOR_Second', 'app/sensor.c', '4', '9'],
    ['sensorTick', 'app/sensor.c', '10', '12'],
    ['UI_Second', 'app/ui.c', '1', '5'],
    ['TICK_Second', 'app/tick.c', '1', '4'],
    ['nvmWrite', 'drv/nvm.c', '1', '3'],
  ];
  const experts: Expert[] = [
    { id: 'sensor', name: 'Sensor expert', paths: ['app/sensor.*', 'app/missing/'] },
    { id: 'ui', name: 'UI expert', paths: ['app/ui.c'] },
  ];

  async function brief(language = 'en-US') {
    const model = await analysis(files, functions);
    const found = modules.classify({ model, functions, files: Object.keys(files), experts, shared: ['app/task.c'] });
    const data = modules.collect({
      expert: experts[0],
      experts,
      shared: ['app/task.c'],
      model,
      functions,
      files: Object.keys(files),
      calls: [
        ['UI_Second', 'app/ui.c', '1', 'SENSOR_Second', 'app/sensor.c'],
        ['SENSOR_Second', 'app/sensor.c', '4', 'nvmWrite', 'drv/nvm.c'],
      ],
      variables: [['sensorCount', 'app/sensor.c']],
      coverage: new Map([
        ['app/sensor.c', { status: 'partial', freshness: 'metadata_changed', ranges: [{ start: 6, end: 8 }] }],
      ]),
      source: source(files),
      modules: found,
    });
    return { data, text: modules.renderBrief(data, labels[language], { date: '2026-01-01 10:00', mode: 'full' }) };
  }

  it('lists scheduling, interfaces, globals, addresses, switches and what the index missed', async () => {
    const { data, text } = await brief();
    expect(data.owned).toEqual(['app/sensor.c', 'app/sensor.h']);
    expect(text).toContain(
      '- app/sensor.c: 2 functions in the index (`SENSOR_Second`, `sensorTick`); lines 6-8 only partly parsed; changed after the last index'
    );
    expect(text).toContain('The path `app/missing/` matches no indexed file.');
    expect(text).toContain('- `secondList` #1: `SENSOR_Second`; run by `vMainTask` (app/task.c:1)');
    expect(text).toContain('- `SENSOR_Second` (app/sensor.c:4) ← `UI_Second` (app/ui.c:4, UI expert)');
    expect(text).toContain('- unowned: `nvmWrite` (drv/nvm.c)');
    expect(text).toContain(
      '- `sensorLevel` (app/sensor.c:1) [not in the index graph]: written in `TICK_Second` (app/tick.c:3); read in `UI_Second` (app/ui.c:3)'
    );
    expect(text).toContain('File-local (static): `sensorCount`.');
    expect(text).toContain(
      '- `SENSOR_PARA_ADDR`: defined as `(NVM_BASE + 0x10)` at app/sensor.c:3; used at app/sensor.c:7'
    );
    // Include guards are not switches.
    expect(text).toContain('`SENSOR_FAST` ×1');
    expect(text).not.toContain('__SENSOR_H__');
    // TICK_HOOK(sensorTick) is indexed as sensorTick on the same line: not missing.
    expect(text).not.toContain('missing from the index: `TICK_HOOK`');
    expect(text).toContain(
      '- app/sensor.c: changed after the last index; line numbers and calls in the index may be off.'
    );
    expect(modules.digest(data)).toEqual({
      files: 2,
      entries: ['secondList #1 SENSOR_Second'],
      provides: [{ name: 'SENSOR_Second', callers: ['UI expert'] }],
      writtenOutside: ['sensorLevel'],
      issues: { partial: 1, unusable: 0, changed: 1, missingFunctions: 0, missingGlobals: 1, unmatched: 1 },
    });
  });

  it('lists a one-entry table run outside the tasks, and a macro with its parameters', async () => {
    const extra: Record<string, string> = {
      ...files,
      'app/power.c': [
        'static const tTask pdList[] =',
        '{',
        '    TASK(SENSOR_Save),',
        '};',
        'void appPowerDown(void)',
        '{',
        '    for (int i = 0; i < 1; i++) pdList[i].func();',
        '}',
        '',
      ].join('\n'),
      'app/sensor.c': `${files['app/sensor.c']}#define BLOCK_ADDR(n) (0x100 * (n))\nvoid SENSOR_Save(void)\n{\n    nvmWrite(BLOCK_ADDR(2), 0);\n}\n`,
    };
    const rows: Row[] = [
      ...functions,
      ['appPowerDown', 'app/power.c', '5', '8'],
      ['SENSOR_Save', 'app/sensor.c', '15', '18'],
    ];
    const model = await analysis(extra, rows);
    expect(model.smallTables.map((table: { name: string }) => table.name)).toEqual(['pdList']);
    // Too small for the architecture file's list of other tables.
    expect(model.otherTables).toEqual([]);
    const data = modules.collect({
      expert: experts[0],
      experts,
      shared: [],
      model,
      functions: rows,
      files: Object.keys(extra),
      calls: [],
      variables: [],
      coverage: new Map(),
      source: source(extra),
    });
    const text = modules.renderBrief(data, labels['en-US'], { date: 'd', mode: 'full' });
    expect(text).toContain('- `pdList` #1: `SENSOR_Save`; run by `appPowerDown` (app/power.c:1)');
    expect(text).toContain('- `BLOCK_ADDR(n)`: defined as `(0x100 * (n))` at app/sensor.c:13; used at app/sensor.c:16');
  });

  it('renders every heading in every language', async () => {
    const languages = Object.keys(labels);
    const briefs = await Promise.all(languages.map((language) => brief(language)));
    briefs.forEach(({ text }, index) => {
      expect(text, languages[index]).not.toMatch(/\{\w+\}/);
      expect(text, languages[index]).toContain(`## ${labels[languages[index]].briefCheck}`);
    });
  });

  it('keeps the expert part of a card and tracks whether it reflects the current files', () => {
    const expert = experts[0];
    const created = modules.mergeCard(undefined, 'Facts v1', expert, labels['en-US'], 'en-US');
    expect(modules.ownPart(created, expert)).toBe('');
    expect(modules.cardLanguage(created)).toBe('en-US');
    const written = `${created}\n## Flow\n\nReads the sensor.\n`;
    const updated = modules.mergeCard(written, 'Facts v2', expert, labels['en-US'], 'en-US');
    expect(updated).toContain('Facts v2');
    expect(updated).not.toContain('Facts v1');
    expect(modules.ownPart(updated, expert)).toBe('## Flow Reads the sensor.');
    // A card without markers gets the block at its end.
    expect(modules.mergeCard('# Notes\n', 'Facts', expert, labels['en-US'], 'en-US')).toMatch(
      /^# Notes\n\n<!-- woody:generated:start -->[\s\S]*Facts\n<!-- woody:generated:end -->\n$/
    );

    let step = modules.cardState(undefined, { filesHash: 'f1', ownHash: 'empty', hasOwn: false });
    expect(step.state).toBe('missing');
    step = modules.cardState(step.record, { filesHash: 'f1', ownHash: 'o1', hasOwn: true });
    expect(step.state).toBe('ready');
    step = modules.cardState(step.record, { filesHash: 'f2', ownHash: 'o1', hasOwn: true });
    expect(step.state).toBe('stale');
    step = modules.cardState(step.record, { filesHash: 'f2', ownHash: 'o2', hasOwn: true });
    expect(step.state).toBe('ready');
  });

  it('ignores the leading card title after an expert is renamed', () => {
    const expert = experts[0];
    const renamed = { ...expert, name: 'Sensor owner' };
    const created = modules.mergeCard(undefined, 'Facts v1', expert, labels['en-US'], 'en-US');
    expect(modules.ownPart(created, renamed)).toBe('');
    const written = `${created}\n## Flow\n\nReads the sensor.\n`;
    expect(modules.ownPart(written, renamed)).toBe(modules.ownPart(written, expert));
  });

  it('handles C++ callee names containing regex metacharacters without throwing', async () => {
    const cppFiles: Record<string, string> = {
      'app/sensor.cpp':
        'struct S { S operator+(int v); ~S(); };\nS S::operator+(int v) { return *this; }\nS::~S() {}\n',
      'app/ui.cpp': 'void render(S s) {\n  auto next = s.operator+(1);\n  s.~S();\n}\n',
    };
    const cppRows: Row[] = [
      ['operator+', 'app/sensor.cpp', '2', '2'],
      ['~S', 'app/sensor.cpp', '3', '3'],
      ['render', 'app/ui.cpp', '1', '4'],
    ];
    const cppExperts = [
      { id: 'sensor', name: 'Sensor', paths: ['app/sensor.cpp'] },
      { id: 'ui', name: 'UI', paths: ['app/ui.cpp'] },
    ];
    const data = modules.collect({
      expert: cppExperts[0],
      experts: cppExperts,
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: cppRows,
      files: Object.keys(cppFiles),
      calls: [
        ['render', 'app/ui.cpp', '1', 'operator+', 'app/sensor.cpp'],
        ['render', 'app/ui.cpp', '1', '~S', 'app/sensor.cpp'],
      ],
      variables: [],
      coverage: new Map(),
      source: source(cppFiles),
    });
    expect(
      data.provides.map((item: { name: string; callers: Array<{ site: string }> }) => [item.name, item.callers[0].site])
    ).toEqual([
      ['~S', 'app/ui.cpp:3'],
      ['operator+', 'app/ui.cpp:2'],
    ]);
  });
});
