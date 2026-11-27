import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modulePaths } from '@/common/types/team/moduleExperts';

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
        split: { dir: 'app', base: 'sensor' },
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

  it('groups split display_*.c files and headers into one display module without merging unrelated layer prefixes', async () => {
    const files: Record<string, string> = {
      'app/task.c': [
        'static const tTask initList[] = { TASK(DISP_Init), TASK(SU_Init) };',
        'static const tTask pdList[] = { TASK(DISP_PwrDwnSave) };',
        'static const tTask phyList[] = { TASK(hdlc_process), TASK(wrapper_process) };',
        'void vMainTask(void *p)',
        '{',
        '    for (int i = 0; i < 2; i++) initList[i].func();',
        '    for (int i = 0; i < 1; i++) pdList[i].func();',
        '    for (int i = 0; i < 2; i++) phyList[i].func();',
        '    vTaskDelay(25);',
        '}',
        'void appInit(void) { xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL); }',
        '',
      ].join('\n'),
      'app/routine/display_task.c': 'void DISP_Init(void)\n{\n}\nstatic void dispSecondTask(void)\n{\n}\n',
      'app/routine/display_pwdn.c': 'void DISP_PwrDwnSave(void)\n{\n}\n',
      'app/routine/display_icon.c': 'void dispIcon(void)\n{\n}\n',
      'app/routine/display_digit.c': 'void dispDigit(void)\n{\n}\n',
      'app/routine/display_key.c': 'void keyCodeProcess(void)\n{\n}\n',
      'app/routine/display_table.c': 'const int dispTable[] = { 1, 2 };\n',
      'app/routine/display.h': 'void DISP_Init(void);\n',
      'app/routine/display_priv.h': 'void dispIcon(void);\n',
      'app/routine/su_14522.c': 'void SU_Init(void)\n{\n}\n',
      'app/dlms/phy/dlms_hdlc.c': 'void hdlc_process(void)\n{\n}\n',
      'app/dlms/phy/dlms_wrapper.c': 'void wrapper_process(void)\n{\n}\n',
    };
    const functions: Row[] = [
      ['vMainTask', 'app/task.c', '4', '10'],
      ['appInit', 'app/task.c', '11', '11'],
      ['DISP_Init', 'app/routine/display_task.c', '1', '3'],
      ['dispSecondTask', 'app/routine/display_task.c', '4', '6'],
      ['DISP_PwrDwnSave', 'app/routine/display_pwdn.c', '1', '3'],
      ['dispIcon', 'app/routine/display_icon.c', '1', '3'],
      ['dispDigit', 'app/routine/display_digit.c', '1', '3'],
      ['keyCodeProcess', 'app/routine/display_key.c', '1', '3'],
      ['SU_Init', 'app/routine/su_14522.c', '1', '3'],
      ['hdlc_process', 'app/dlms/phy/dlms_hdlc.c', '1', '3'],
      ['wrapper_process', 'app/dlms/phy/dlms_wrapper.c', '1', '3'],
    ];
    const model = await analysis(files, functions);
    const found = modules.classify({
      model,
      functions,
      files: Object.keys(files),
      experts: [{ id: 'display', name: '显示专家', paths: ['app/routine/display_*.c', 'app/routine/display*.h'] }],
      shared: [],
    });
    expect(found).toEqual([
      expect.objectContaining({ id: 'dlms-hdlc', files: ['app/dlms/phy/dlms_hdlc.c'] }),
      expect.objectContaining({ id: 'dlms-wrapper', files: ['app/dlms/phy/dlms_wrapper.c'] }),
      {
        id: 'display',
        files: [
          'app/routine/display_digit.c',
          'app/routine/display_icon.c',
          'app/routine/display_key.c',
          'app/routine/display_pwdn.c',
          'app/routine/display_table.c',
          'app/routine/display_task.c',
          'app/routine/display.h',
          'app/routine/display_priv.h',
        ],
        split: { dir: 'app/routine', base: 'display' },
        prefix: 'DISP',
        tables: [
          { table: 'initList', functions: ['DISP_Init'] },
          { table: 'pdList', functions: ['DISP_PwrDwnSave'] },
        ],
        experts: ['display'],
      },
      expect.objectContaining({ id: 'su-14522', files: ['app/routine/su_14522.c'] }),
    ]);
  });

  it('discovers standalone RTOS tasks, secondary tables and struct vtable modules while suggesting shared files', async () => {
    const files: Record<string, string> = {
      'app/mtask.c': TASK,
      'app/sensor.c': 'void SENSOR_Second(void)\n{\n}\n',
      'app/ui.c': 'void UI_Second(void)\n{\n}\n',
      'app/tick.c': 'void TICK_Second(void)\n{\n}\n',
      'app/lvgl_task.c': 'void lvgl_task(void *p)\n{\n    vTaskDelay(10);\n}\n',
      'app/factory.c':
        'static const tTask cmdList[] = { TASK(FACT_Read), TASK(FACT_Write) };\nvoid FACT_Run(void)\n{\n    for (int i = 0; i < 2; i++) cmdList[i].func();\n}\nvoid FACT_Read(void)\n{\n}\nvoid FACT_Write(void)\n{\n}\n',
      'app/eeprom_addr_table.h': 'ENTRY(A, 1)\nENTRY(B, 2)\n',
      'app/datastore.h': 'enum {\n#define ENTRY(a, b) a,\n#include "eeprom_addr_table.h"\n};\n',
    };
    const functions: Row[] = [
      ['vMainTask', 'app/mtask.c', '7', '10'],
      ['appInit', 'app/mtask.c', '11', '14'],
      ['SENSOR_Second', 'app/sensor.c', '1', '3'],
      ['UI_Second', 'app/ui.c', '1', '3'],
      ['TICK_Second', 'app/tick.c', '1', '3'],
      ['lvgl_task', 'app/lvgl_task.c', '1', '4'],
      ['FACT_Run', 'app/factory.c', '2', '5'],
      ['FACT_Read', 'app/factory.c', '6', '8'],
      ['FACT_Write', 'app/factory.c', '9', '11'],
    ];
    files['app/mtask.c'] = files['app/mtask.c'].replace(
      'xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);',
      'xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);\n    xTaskCreate(lvgl_task, "lvgl", 512, NULL, 2, NULL);'
    );
    functions[1] = ['appInit', 'app/mtask.c', '11', '15'];
    const model = await architecture.analyze({
      functions,
      sourceFiles: Object.keys(files),
      readSource: (file: string) => files[file] ?? null,
      callersOf: async () => new Map([['appInit|app/mtask.c', ['main']]]),
    });
    const found = modules.classify({ model, functions, files: Object.keys(files) });
    expect(found.map((item: { id: string }) => item.id)).toEqual(['factory', 'lvgl-task', 'sensor', 'tick', 'ui']);
    expect(modules.suggestShared({ model })).toEqual(['app/datastore.h', 'app/eeprom_addr_table.h', 'app/mtask.c']);
  });
});

describe('a module split into a qos_*.c family', () => {
  // The QoS statistics move out of a shared quality.c into qos_calc.c and other qos_*.c files.
  const files: Record<string, string> = {
    'app/task.c': [
      'static const tTask appList[] = { TASK(QOS_SecondProc), TASK(QTY_SecondProc) };',
      'static const tTask pdList[] = { TASK(QOS_PwrDwnSave) };',
      'void vMainTask(void *p)',
      '{',
      '    for (int i = 0; i < 2; i++) appList[i].func();',
      '    for (int i = 0; i < 1; i++) pdList[i].func();',
      '    vTaskDelay(25);',
      '}',
      'void appInit(void) { xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL); }',
      '',
    ].join('\n'),
    'app/routine/qos_calc.c': 'void QOS_SecondProc(void)\n{\n}\n',
    'app/routine/qos_store.c': 'void QOS_PwrDwnSave(void)\n{\n}\n',
    'app/routine/qos_para.c': 'int QOS_ParaGet(void)\n{\n    return 0;\n}\n',
    'app/routine/qos.h': 'void QOS_SecondProc(void);\n',
    'app/routine/quality.c': 'void QTY_SecondProc(void)\n{\n}\n',
    'app/routine/quality.h': 'void QTY_SecondProc(void);\n',
  };
  const functions: Row[] = [
    ['vMainTask', 'app/task.c', '3', '8'],
    ['appInit', 'app/task.c', '9', '9'],
    ['QOS_SecondProc', 'app/routine/qos_calc.c', '1', '3'],
    ['QOS_PwrDwnSave', 'app/routine/qos_store.c', '1', '3'],
    ['QOS_ParaGet', 'app/routine/qos_para.c', '1', '4'],
    ['QTY_SecondProc', 'app/routine/quality.c', '1', '3'],
  ];

  it('becomes one qos module, apart from what is left of quality.c, owned by qos_*.c patterns', async () => {
    const model = await analysis(files, functions);
    const found = modules.classify({ model, functions, files: Object.keys(files), experts: [], shared: [] });
    const qos = found.find((item: { id: string }) => item.id === 'qos');
    expect(qos).toMatchObject({
      split: { dir: 'app/routine', base: 'qos' },
      files: ['app/routine/qos_calc.c', 'app/routine/qos_para.c', 'app/routine/qos_store.c', 'app/routine/qos.h'],
    });
    expect(found.find((item: { id: string }) => item.id === 'quality')?.files).toEqual([
      'app/routine/quality.c',
      'app/routine/quality.h',
    ]);
    expect(modulePaths(found, ['qos'])).toEqual(['app/routine/qos_*.c', 'app/routine/qos.h']);
  });

  it('reports a new qos_*.c file as unowned in the qos module until the expert owns the family', async () => {
    const model = await analysis(files, functions);
    // An expert saved before the split owns only the first new file.
    const experts = [{ id: 'qos', name: 'QoS 专家', paths: ['app/routine/qos_calc.c', 'app/routine/qos.h'] }];
    const found = modules.classify({ model, functions, files: Object.keys(files), experts, shared: [] });
    const data = modules.collect({
      expert: experts[0],
      experts,
      shared: [],
      model,
      functions,
      files: Object.keys(files),
      calls: [],
      variables: [],
      coverage: new Map(),
      source: source(files),
      modules: found,
    });
    expect(data.driftFiles).toEqual(['app/routine/qos_para.c', 'app/routine/qos_store.c']);

    const patterns = [{ id: 'qos', name: 'QoS 专家', paths: ['app/routine/qos_*.c', 'app/routine/qos.h'] }];
    const owned = modules.collect({
      expert: patterns[0],
      experts: patterns,
      shared: [],
      model,
      functions,
      files: Object.keys(files),
      calls: [],
      variables: [],
      coverage: new Map(),
      source: source(files),
      modules: modules.classify({ model, functions, files: Object.keys(files), experts: patterns, shared: [] }),
    });
    expect(owned.driftFiles).toEqual([]);
    expect(owned.owned).toEqual([
      'app/routine/qos.h',
      'app/routine/qos_calc.c',
      'app/routine/qos_para.c',
      'app/routine/qos_store.c',
    ]);
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

  it('detects bare array pointer writes and address passing without misclassifying sizeof or read-only args', () => {
    const kind = (text: string, isConst = false) =>
      modules.accessKind(text, text.indexOf('alarmBuf'), 'alarmBuf', true, isConst);
    expect(kind('memset(alarmBuf, 0, sizeof(alarmBuf));')).toBe('write');
    expect(kind('memcpy(alarmBuf, src, 8);')).toBe('write');
    expect(kind('memcpy(dst, alarmBuf, 8);')).toBe('read');
    expect(kind('size_t n = sizeof(alarmBuf);')).toBe('read');
    expect(kind('eepromRead(ADDR, alarmBuf, 16);')).toBe('address');
    expect(kind('eepromRead(ADDR, alarmBuf, 16);', true)).toBe('read');
  });

  it('recovers globals, functions and tables after unbalanced #if braces and unwraps extern "C" / namespace blocks', () => {
    const prepared = source({
      'a.cpp': [
        '#if MODEL_A',
        'void initModel(int a)',
        '{',
        '#else',
        'void initModel(void)',
        '{',
        '#endif',
        '    int localOnly = 1;',
        '}',
        'extern "C" {',
        'ALIGN(4) uint8_t alignedBuf[16];',
        'void (* const handlers[])(void) = {',
        '    NULL,',
        '    NULL,',
        '};',
        'void afterUnbalanced(void)',
        '{',
        '}',
        '}',
        'namespace meter {',
        'int nsGlobal;',
        'void nsFn(void) {}',
        '}',
        '',
      ].join('\n'),
    })('a.cpp');
    const globals = modules.globalsOf(prepared).map((item: { name: string }) => item.name);
    expect(globals).toEqual(['alignedBuf', 'handlers', 'nsGlobal']);
    expect(modules.definitionsOf(prepared).map((item: { name: string }) => item.name)).toEqual([
      'initModel',
      'afterUnbalanced',
      'nsFn',
    ]);
    expect(modules.fileTablesOf(prepared).map((item: { name: string }) => item.name)).toEqual(['handlers']);
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

  it('lists functions other experts call first and names the ones past the limit', () => {
    // 22 functions called often from unowned code, and one the sensor expert calls once.
    const names = Array.from({ length: 22 }, (_, i) => `LOGGER_Get${String(i).padStart(2, '0')}`);
    const loggerSource = [...names, 'LOGGER_Resync'].map((name) => `void ${name}(void)\n{\n}\n`).join('');
    const ownFiles: Record<string, string> = {
      'app/logger.c': loggerSource,
      'app/proto.c': 'void proto_get(void)\n{\n}\nvoid proto_set(void)\n{\n}\n',
      'app/sensor.c': 'void SENSOR_Adjust(void)\n{\n    LOGGER_Resync();\n}\n',
    };
    const rows: Row[] = [
      ...[...names, 'LOGGER_Resync'].map(
        (name, i): Row => [name, 'app/logger.c', String(i * 3 + 1), String(i * 3 + 3)]
      ),
      ['proto_get', 'app/proto.c', '1', '3'],
      ['proto_set', 'app/proto.c', '4', '6'],
      ['SENSOR_Adjust', 'app/sensor.c', '1', '4'],
    ];
    const ownExperts = [
      { id: 'logger', name: 'Logger', paths: ['app/logger.c'] },
      { id: 'sensor', name: 'Sensor', paths: ['app/sensor.c'] },
    ];
    const data = modules.collect({
      expert: ownExperts[0],
      experts: ownExperts,
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: rows,
      files: Object.keys(ownFiles),
      calls: [
        ...names.flatMap((name) => [
          ['proto_get', 'app/proto.c', '1', name, 'app/logger.c'],
          ['proto_set', 'app/proto.c', '4', name, 'app/logger.c'],
        ]),
        ['SENSOR_Adjust', 'app/sensor.c', '1', 'LOGGER_Resync', 'app/logger.c'],
      ],
      variables: [],
      coverage: new Map(),
      source: source(ownFiles),
    });
    expect(data.provides[0].name).toBe('LOGGER_Resync');
    const text = modules.renderBrief(data, labels['en-US'], { date: 'd', mode: 'full' });
    expect(text).toContain('- `LOGGER_Resync` (app/logger.c:67) ← `SENSOR_Adjust` (app/sensor.c:3, Sensor)');
    // 23 functions, 20 shown: the last three by name are only named.
    expect(text).toContain(
      '- … 3 more functions called from outside, callers not shown: `LOGGER_Get19`, `LOGGER_Get20`, `LOGGER_Get21`.'
    );
  });

  it('extracts CRLF and multiline address macros, skips #if 0 macros, and ignores indexed *ADDR* functions', () => {
    const crlfFiles: Record<string, string> = {
      'app/alarm.c': [
        '#if 0',
        '#define ALARM_PARA_ADDR 0x00',
        '#endif',
        '#define ALARM_PARA_ADDR (NVM_ADDR(1) + 0x10)',
        '#define ALARM_BAK_ADDR(slot) \\',
        '    (ALARM_PARA_ADDR + ((slot) * 0x40))',
        'void ALARM_Init(void)',
        '{',
        '#if 0',
        '    nvmRead(DEAD_ADDR);',
        '#endif',
        '    nvmRead(ALARM_PARA_ADDR);',
        '    nvmRead(ALARM_BAK_ADDR(1));',
        '    nvmRead(LOG_ADDR(2));',
        '    nvmRead(UNKNOWN_EXT_ADDR);',
        '}',
        '',
      ].join('\r\n'),
      'app/datastore.c':
        'int LOG_ADDR(int id)\r\n{\r\n    return id;\r\n}\r\nint NVM_ADDR(int id)\r\n{\r\n    return id;\r\n}\r\n',
    };
    const rows: Row[] = [
      ['ALARM_Init', 'app/alarm.c', '7', '16'],
      ['LOG_ADDR', 'app/datastore.c', '1', '4'],
      ['NVM_ADDR', 'app/datastore.c', '5', '8'],
    ];
    const data = modules.collect({
      expert: { id: 'alarm', name: 'Alarm', paths: ['app/alarm.c'] },
      experts: [{ id: 'alarm', name: 'Alarm', paths: ['app/alarm.c'] }],
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: rows,
      files: Object.keys(crlfFiles),
      calls: [],
      variables: [],
      coverage: new Map(),
      source: source(crlfFiles),
    });
    const text = modules.renderBrief(data, labels['en-US'], { date: 'd', mode: 'full' });
    expect(text).toContain('- `ALARM_PARA_ADDR`: defined as `(NVM_ADDR(1) + 0x10)` at app/alarm.c:4');
    expect(text).toContain(
      '- `ALARM_BAK_ADDR(slot)`: defined as `(ALARM_PARA_ADDR + ((slot) * 0x40))` at app/alarm.c:5'
    );
    expect(text).toContain('- `UNKNOWN_EXT_ADDR`: definition not found; used at app/alarm.c:15');
    expect(text).not.toContain('LOG_ADDR');
    expect(text).not.toContain('DEAD_ADDR');
  });

  it('flags unowned split files and unparsed table outlines without flagging unrelated shared-prefix folders', () => {
    const splitFiles: Record<string, string> = {
      'app/routine/display_task.c': 'void DISP_Init(void)\n{\n}\n',
      'app/routine/display_icon.c': 'void dispIcon(void)\n{\n}\n',
      'app/routine/display_table.c': 'const int DispItems[] = {\n    1,\n    2,\n};\n',
      'app/routine/display.h': 'void DISP_Init(void);\n',
      'app/ic/ic_01.c': 'void IC_DataGet(void)\n{\n}\n',
      'app/ic/ic_03.c': 'void IC_RegGet(void)\n{\n}\n',
      'app/ic/ic_07.c': 'void IC_ProfileGet(void)\n{\n}\n',
    };
    const detectedModules = [
      {
        id: 'display',
        files: [
          'app/routine/display_icon.c',
          'app/routine/display_table.c',
          'app/routine/display_task.c',
          'app/routine/display.h',
        ],
        experts: ['display'],
      },
      {
        id: 'ic',
        files: ['app/ic/ic_01.c', 'app/ic/ic_03.c', 'app/ic/ic_07.c'],
        experts: ['profile'],
      },
    ];
    const currentExperts: Expert[] = [
      // Legacy single-file path before display.c was split into display_*.c.
      {
        id: 'display',
        name: 'Display',
        paths: ['app/routine/display.c', 'app/routine/display.h', 'app/routine/display_table.c'],
      },
      { id: 'profile', name: 'Profile', paths: ['app/ic/ic_07.c'] },
    ];
    const dispData = modules.collect({
      expert: currentExperts[0],
      experts: currentExperts,
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: [],
      files: Object.keys(splitFiles),
      calls: [],
      variables: [],
      coverage: new Map([['app/routine/display_table.c', { status: 'unusable', freshness: 'clean', ranges: [] }]]),
      source: source(splitFiles),
      modules: detectedModules,
    });
    const dispBrief = modules.renderBrief(dispData, labels['en-US'], { date: 'd', mode: 'full' });
    expect(dispData.driftFiles).toEqual(['app/routine/display_icon.c', 'app/routine/display_task.c']);
    expect(dispBrief).toContain('tables: `DispItems` (1-4)');
    expect(modules.digest(dispData).issues.drift).toBe(2);

    const profData = modules.collect({
      expert: currentExperts[1],
      experts: currentExperts,
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: [['IC_ProfileGet', 'app/ic/ic_07.c', '1', '3']],
      files: Object.keys(splitFiles),
      calls: [],
      variables: [],
      coverage: new Map(),
      source: source(splitFiles),
      modules: detectedModules,
    });
    expect(profData.driftFiles).toEqual([]);
  });

  it('reports external globals, header types, vector APIs, timers, ISRs, internal calls, multi-variant storage IDs and active switch values', async () => {
    const richFiles: Record<string, string> = {
      'app/config.h': '#define ENABLE 1\n#define ALARM_V2 ENABLE\n#define ALARM_BACKUP 0\n',
      'app/nvm_ids.h': 'typedef enum {\n    NVM_ALARM_CFG = 10,\n} tNvmId;\n',
      'app/measure.c': 'int g_MeasureVolt;\nint g_StatusWord;\n',
      'app/alarm.h': [
        'typedef struct { int thd; int delay; } tAlarmPara;',
        'typedef enum { ALM_NONE = 0, ALM_OVERVOLT = 1 } tAlarmCode;',
        'static inline int alarmIsHigh(int v) { return v > 250; }',
        '#if ALARM_V2',
        '#define ALARM_CFG_ADDR 0x2000',
        '#else',
        '#define ALARM_CFG_ADDR 0x1000',
        '#endif',
        '',
      ].join('\n'),
      'app/alarm.c': [
        '#include "alarm.h"',
        'static const tAlarmPara defaultAlarm = {',
        '    250,',
        '    10,',
        '};',
        'static void alarmHelper(void) {}',
        'void ALARM_Second(int g_MeasureVolt)',
        '{',
        '    (void)g_MeasureVolt;',
        '}',
        'void ALARM_Check(void)',
        '{',
        '#if ALARM_V2 == ENABLE',
        '    if (g_MeasureVolt > 250) g_StatusWord |= 1;',
        '    nvmRead(ALARM_CFG_ADDR, NVM_ALARM_CFG);',
        '    alarmHelper();',
        '#endif',
        '}',
        'void ALARM_TimerCb(void *t) {}',
        'void EXTI0_IRQHandler(void) {}',
        'void ALARM_Start(void) { xTimerCreate("alm", 100, 1, 0, ALARM_TimerCb); }',
        '',
      ].join('\n'),
    };
    const richRows: Row[] = [
      ['alarmHelper', 'app/alarm.c', '6', '6'],
      ['ALARM_Second', 'app/alarm.c', '7', '10'],
      ['ALARM_Check', 'app/alarm.c', '11', '18'],
      ['ALARM_TimerCb', 'app/alarm.c', '19', '19'],
      ['EXTI0_IRQHandler', 'app/alarm.c', '20', '20'],
      ['ALARM_Start', 'app/alarm.c', '21', '21'],
    ];
    const richExperts: Expert[] = [
      { id: 'alarm', name: 'Alarm expert', paths: ['app/alarm*.c', 'app/alarm.h'] },
      { id: 'measure', name: 'Measure expert', paths: ['app/measure.c'] },
    ];
    const data = modules.collect({
      expert: richExperts[0],
      experts: richExperts,
      shared: [],
      model: {
        tasks: [],
        tables: [
          {
            name: 'secondList',
            dispatchers: [{ def: { name: 'vMainTask', file: 'app/task.c' }, paths: [] }],
            variants: [
              {
                file: 'app/task.c',
                line: 1,
                conditions: [],
                entries: [
                  {
                    position: 1,
                    defs: [{ name: 'ALARM_Check', file: 'app/alarm.c' }],
                    conditions: [],
                    comment: 'must run after measure',
                  },
                ],
              },
            ],
          },
        ],
        otherTables: [],
        smallTables: [],
        structTables: [],
        vectorApis: [
          {
            base: 'app1_api',
            header: 'app/app1_api.h',
            entries: [
              { macro: 'API_AlarmCheck', field: 'alarm_check', def: { name: 'ALARM_Check', file: 'app/alarm.c' } },
            ],
          },
        ],
        xmacroTables: [
          { file: 'app/alarm_items.h', macro: 'ALM_ITEM', count: 4, sites: [{ file: 'app/alarm.c', line: 1 }] },
        ],
      },
      functions: richRows,
      files: Object.keys(richFiles),
      calls: [['ALARM_Check', 'app/alarm.c', '11', 'alarmHelper', 'app/alarm.c']],
      variables: [],
      coverage: new Map(),
      source: source(richFiles),
      diskFiles: ['app/alarm.c', 'app/alarm.h', 'app/alarm_extra.c'],
    });
    const text = modules.renderBrief(data, labels['en-US'], { date: 'd', mode: 'full' });
    // Multi-line table inside a C file with functions, plus unindexed disk file check.
    expect(text).toContain('tables: `defaultAlarm` (2-5)');
    expect(text).toContain('app/alarm_extra.c');
    // Dispatch comment, internal call skeleton, vector API, RTOS timer, and ISR.
    expect(text).toContain('must run after measure; calls internally: `alarmHelper`');
    expect(text).toContain('Inter-image API `app1_api` (app/app1_api.h): `API_AlarmCheck` → `ALARM_Check`');
    expect(text).toContain('RTOS timer callback `ALARM_TimerCb`, created at app/alarm.c:21');
    expect(text).toContain('Interrupt / callback handler `EXTI0_IRQHandler` (app/alarm.c:20)');
    // External globals read/written (shadowed param in ALARM_Second skipped) and digest.writesExternal.
    expect(text).toContain(
      '`g_StatusWord` (app/measure.c:2, Measure expert): written in `ALARM_Check` (app/alarm.c:14)'
    );
    expect(text).toContain('`g_MeasureVolt` (app/measure.c:1, Measure expert): read in `ALARM_Check` (app/alarm.c:14)');
    expect(text).not.toContain('ALARM_Second` (app/alarm.c:9)');
    expect(modules.digest(data).writesExternal).toEqual(['g_StatusWord']);
    // Header types, enums, inline helpers, and X-Macro tables.
    expect(text).toContain('Structs / unions: `tAlarmPara` (app/alarm.h:1)');
    expect(text).toContain('Enums: `tAlarmCode` (app/alarm.h:2)');
    expect(text).toContain('Header inline / helper functions: `alarmIsHigh` (app/alarm.h:3)');
    expect(text).toContain('app/alarm_items.h: X-Macro `ALM_ITEM` (4 entries)');
    // Multi-variant #if address macro and enum storage ID.
    expect(text).toContain(
      '`ALARM_CFG_ADDR`: defined as `0x2000` at app/alarm.h:5 [only when `ALARM_V2`] / defined as `0x1000` at app/alarm.h:7 [only when `!(ALARM_V2)`]'
    );
    expect(text).toContain('`NVM_ALARM_CFG`: enum / X-Macro entry at app/nvm_ids.h:2');
    // Active build switch definition while filtering ENABLE.
    expect(text).toContain('`ALARM_V2` ×2 (defined as `ENABLE` at app/config.h:2)');
    expect(text).not.toContain('`ENABLE` ×');
  });

  it('balances callers across experts and summarizes overflowed target groups in uses instead of dropping them silently', () => {
    // Expert A calls coreFn from 9 functions; Expert B calls coreFn once and must not be hidden.
    const aFns = Array.from({ length: 9 }, (_, i) => `aCall${i}`);
    const manyFiles: Record<string, string> = {
      'app/core.c': 'void coreFn(void)\n{\n}\n',
      'app/a.c': aFns.map((name) => `void ${name}(void)\n{\n    coreFn();\n}\n`).join(''),
      'app/b.c': 'void bCall(void)\n{\n    coreFn();\n}\n',
      'app/ext1.c': Array.from({ length: 61 }, (_, i) => `void ext1_${i}(void) {}\n`).join(''),
      'app/ext2.c': 'void ext2_0(void) {}\nvoid ext2_1(void) {}\n',
    };
    const rows: Row[] = [
      ['coreFn', 'app/core.c', '1', '3'],
      ...aFns.map((name, i): Row => [name, 'app/a.c', String(i * 4 + 1), String(i * 4 + 4)]),
      ['bCall', 'app/b.c', '1', '4'],
      ...Array.from({ length: 61 }, (_, i): Row => [`ext1_${i}`, 'app/ext1.c', String(i + 1), String(i + 1)]),
      ['ext2_0', 'app/ext2.c', '1', '1'],
      ['ext2_1', 'app/ext2.c', '2', '2'],
    ];
    const exps: Expert[] = [
      { id: 'core', name: 'Core', paths: ['app/core.c'] },
      { id: 'alpha', name: 'Alpha', paths: ['app/a.c'] },
      { id: 'beta', name: 'Beta', paths: ['app/b.c'] },
      { id: 'ext1', name: 'Ext1', paths: ['app/ext1.c'] },
      { id: 'ext2', name: 'Ext2', paths: ['app/ext2.c'] },
    ];
    const data = modules.collect({
      expert: exps[0],
      experts: exps,
      shared: [],
      model: { tasks: [], tables: [], otherTables: [], smallTables: [], structTables: [] },
      functions: rows,
      files: Object.keys(manyFiles),
      calls: [
        ...aFns.map((name, i) => [name, 'app/a.c', String(i * 4 + 1), 'coreFn', 'app/core.c']),
        ['bCall', 'app/b.c', '1', 'coreFn', 'app/core.c'],
        ...Array.from({ length: 61 }, (_, i) => ['coreFn', 'app/core.c', '1', `ext1_${i}`, 'app/ext1.c']),
        ['coreFn', 'app/core.c', '1', 'ext2_0', 'app/ext2.c'],
        ['coreFn', 'app/core.c', '1', 'ext2_1', 'app/ext2.c'],
      ],
      variables: [],
      coverage: new Map(),
      source: source(manyFiles),
    });
    const text = modules.renderBrief(data, labels['en-US'], { date: 'd', mode: 'full' });
    expect(text).toContain('`bCall` (app/b.c:3, Beta)');
    expect(text).toContain('1 more target modules/groups called (not expanded): Ext2 (2).');
  });

  it('ignores user corrections when computing ownPart and detects missing module-card sections', () => {
    const expert = experts[0];
    const base = modules.mergeCard(undefined, 'Facts v1', expert, labels['en-US'], 'en-US');
    const userOnly = `${base}\n## 用户更正\n- 阈值单位是 0.1V。\n`;
    expect(modules.ownPart(userOnly, expert)).toBe('');

    const partial = `${base}\n## 流程\n读取传感器。\n\n## 用户更正\n- 旧备注\n`;
    const partialEditedUser = `${base}\n## 流程\n读取传感器。\n\n## 用户更正\n- 新备注\n`;
    expect(modules.ownPart(partial, expert)).toBe(modules.ownPart(partialEditedUser, expert));
    expect(modules.missingCardSections(partial, expert)).toEqual([
      'files',
      'entry',
      'parameters',
      'dataSources',
      'outputs',
      'switches',
      'gaps',
    ]);

    const complete = [
      base,
      '## 概述与文件清单',
      '## 入口、调度与生命周期',
      '## 核心流程',
      '## 参数、默认值与存储',
      '## 数据来源与外部依赖',
      '## 输出与对外接口',
      '## 编译开关',
      '## 索引核对与盲区',
      '## 用户更正',
    ].join('\n');
    expect(modules.missingCardSections(complete, expert)).toEqual([]);
  });
});

const signatureData = (overrides: Record<string, unknown> = {}) => ({
  unmatched: [],
  driftFiles: [],
  unindexedFiles: [],
  tasks: [{ name: 'vSensorTask', site: 'app/main.c:40' }],
  entries: [{ table: 'secondList', position: 2, names: ['SENSOR_Second'], conditions: [] }],
  structs: [{ type: 'tOps', field: 'read', functions: ['SENSOR_Read'] }],
  vectorEntries: [{ base: 'app1_api', items: [{ macro: 'API_Read', target: 'SENSOR_Read' }] }],
  ...overrides,
});

describe('drift signature of a card', () => {
  it('ignores line numbers and table positions, which move when other files or modules change', () => {
    const before = modules.driftSignature(signatureData());
    const shifted = modules.driftSignature(
      signatureData({
        tasks: [{ name: 'vSensorTask', site: 'app/main.c:41' }],
        entries: [{ table: 'secondList', position: 3, names: ['SENSOR_Second'], conditions: [] }],
      })
    );
    expect(shifted).toBe(before);
    expect(modules.isCurrentDriftSignature(before)).toBe(true);
  });

  it('changes when the module is scheduled differently or gains unowned, unindexed, struct or vector entries', () => {
    const before = modules.driftSignature(signatureData());
    expect(modules.driftSignature(signatureData({ tasks: [] }))).not.toBe(before);
    expect(
      modules.driftSignature(
        signatureData({
          entries: [{ table: 'secondList', position: 2, names: ['SENSOR_Second'], conditions: ['METER_3P'] }],
        })
      )
    ).not.toBe(before);
    expect(modules.driftSignature(signatureData({ driftFiles: ['app/sensor_cal.c'] }))).not.toBe(before);
    expect(modules.driftSignature(signatureData({ unindexedFiles: ['app/sensor_extra.c'] }))).not.toBe(before);
    expect(
      modules.driftSignature(
        signatureData({ structs: [{ type: 'tOps', field: 'read', functions: ['SENSOR_Read', 'SENSOR_New'] }] })
      )
    ).not.toBe(before);
    expect(modules.driftSignature(signatureData({ vectorEntries: [] }))).not.toBe(before);
  });

  it('tells signatures of an older format apart', () => {
    expect(modules.isCurrentDriftSignature('v2\nu:\nd:\nt:vSensorTask\ne:')).toBe(false);
    expect(modules.isCurrentDriftSignature('u:\nd:\nt:vSensorTask@app/main.c:40\ne:')).toBe(false);
    expect(modules.isCurrentDriftSignature(undefined)).toBe(false);
  });
});
