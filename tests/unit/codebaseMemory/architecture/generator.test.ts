import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const architecture = require(path.resolve('resources/bundled-mcp/codebase-memory/lib/architecture.cjs'));
const labels = require(path.resolve('resources/bundled-mcp/codebase-memory/lib/architecture-labels.json'));

type Row = [string, string, number, number];

/** A small FreeRTOS project in the styles different people write. */
const sources: Record<string, string> = {
  'app/main.c': `
void appInit(void)
{
#if DEMO_TASK_ENABLE
    xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);   /* main loop */
#endif
    xTaskCreateStatic((TaskFunction_t)vCommTask, "comm", 256, NULL, 2, commStack, &commTcb);
    xTaskCreate(prvIdleTask, "IDLE", 64, NULL, 0, NULL);
}
int main(void)
{
    appInit();
    for (;;) {}
}
`,
  // CRLF line endings, as many Windows projects use.
  'app/sched.c': `
typedef struct { void (*func)(void); const char *name; } tTask;
#define TASK(f) {f, #f}
static const tTask secondList[] =
{
    TASK(SENSOR_Second),
    // Tick must run before history
    TASK(TICK_Second),
    #if BILL_ENABLE
    TASK(BILL_Second),   // must be after TICK_Second
    #endif
#if 0
    TASK(OLD_Second),
#endif
    TASK(HIST_Second),    /* history is placed last */
};
static void (* const idleList[])(void) = { VIEW_Idle, SENSOR_Idle };
static const struct { int id; void (*init)(void); } initList[] = {
    [0] = { 1, SENSOR_Init },
    { .id = 2, .init = TICK_Start },
    { 3, VIEW_Start },
    { 4, MISSING_Init },
};
#ifdef BIG
static const tTask pdList[] = { TASK(SENSOR_Save) };
#else
static const tTask pdList[] = { TASK(SENSOR_Save), TASK(TICK_Save), TASK(VIEW_Save) };
#endif
static void RunSecond(void)
{
    for (int i = 0; i < 4; i++) secondList[i].func();
}
static void RunIdle(void)
{
    for (int i = 0; i < 2; i++) idleList[i]();
}
static void RunInit(void)
{
    for (int i = 0; i < 4; i++) initList[i].init();
}
static void RunPowerDown(void)
{
    for (int i = 0; i < 3; i++) (*pdList[i].func)();
}
void vMainTask(void *p)
{
    RunInit();
    for (;;)
    {
        if (tick()) RunSecond();
        RunIdle();
        vTaskDelay(25);
    }
    RunPowerDown();
}
void vCommTask(void *p)
{
    for (;;) { xQueueReceive(commQueue, &msg, portMAX_DELAY); handle(&msg); }
}
static void handle(void *m)
{
}
`.replace(/\n/g, '\r\n'),
  'app/sensor.c':
    'void SENSOR_Second(void)\n{\n}\nvoid SENSOR_Idle(void)\n{\n}\nvoid SENSOR_Init(void)\n{\n}\nvoid SENSOR_Save(void)\n{\n}\n',
  'app/tick.c': 'void TICK_Second(void)\n{\n}\nvoid TICK_Start(void)\n{\n}\nvoid TICK_Save(void)\n{\n}\n',
  'app/view.c': 'void VIEW_Idle(void)\n{\n}\nvoid VIEW_Start(void)\n{\n}\nvoid VIEW_Save(void)\n{\n}\n',
  'app/bill.c': 'void BILL_Second(void)\n{\n}\n',
  // Handlers kept in struct fields and called through a pointer.
  'app/ops.c': `typedef struct SensorOps { int id; int (*read)(int ch); void (*reset)(void); } tSensorOps;
typedef struct { int (*read)(int ch); } tLogOps;
int tempRead(int ch)
{
    return ch;
}
void tempReset(void)
{
}
int humRead(int ch)
{
    return ch + 1;
}
int deadRead(int ch)
{
    return 0;
}
int logRead(int ch)
{
    return 0;
}
const tSensorOps sensorOps[] =
{
    { .id = 1, .read = tempRead, .reset = tempReset },
#if 0
    { .id = 9, .read = deadRead },
#endif
    { .id = 2, .read = &humRead, .reset = NULL },
};
static const tLogOps logOps = { .read = logRead };
int SENSOR_Value(const tSensorOps *ops, int ch)
{
    return ops->read(ch);
}
void SENSOR_ResetAll(struct SensorOps *s)
{
    (*s->reset)();
}
int LOG_Read(const tLogOps *log)
{
    return log->read(0);
}
void runReset(void)
{
    current->reset();
}
int anyRead(void)
{
    return other->read(1);
}
`,
  'app/history.c': 'void HIST_Second(void)\n{\n}\n',
  // Tables only, no functions: the index lists the file but no function in it.
  'app/boards.c': '#include "ops.h"\n\nconst tSensorOps boardOps = { .id = 7, .read = tempRead };\n',
  'app/dead.c':
    'void unusedStart(void)\n{\n    xTaskCreate(vDeadTask, "dead", 64, NULL, 1, NULL);\n}\nvoid vDeadTask(void *p)\n{\n}\n',
  'lib/wrapper.c': 'void osCreate(TaskFunction_t code)\n{\n    xTaskCreate(code, "x", 64, NULL, 1, NULL);\n}\n',
  'demo/demo.c':
    'void demoStart(void)\n{\n    xTaskCreate(demoTask, "demo", 64, NULL, 1, NULL);\n}\nvoid demoTask(void *p)\n{\n}\n',
};

/** Function rows as the index reports them: name, file, first and last line. */
function functionRows(): Row[] {
  const rows: Row[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const lines = text.replace(/\r/g, '').split('\n');
    lines.forEach((line, index) => {
      const match = /^(?:static\s+)?(?:void|int)\s+(\w+)\s*\([^;]*\)\s*$/.exec(line);
      if (!match) return;
      let depth = 0;
      for (let end = index + 1; end < lines.length; end++) {
        depth += (lines[end].match(/\{/g) || []).length - (lines[end].match(/\}/g) || []).length;
        if (depth === 0 && lines[end].includes('}')) {
          rows.push([match[1], file, index + 1, end + 1]);
          return;
        }
      }
    });
  }
  // The index also lists virtual files.
  rows.push(['len', '<python-builtins>', 1, 1]);
  return rows;
}

async function analyzed() {
  const asked: string[][] = [];
  const model = await architecture.analyze({
    functions: functionRows(),
    sourceFiles: [...Object.keys(sources), '<python-builtins>', 'docs/readme.md'],
    readSource: (file: string) => sources[file] ?? null,
    callersOf: async (names: string[]) => {
      asked.push(names);
      return new Map([['appInit|app/main.c', ['main']]]);
    },
  });
  return { model, asked };
}

describe('architecture map', () => {
  it('finds the tasks, what they wait on and call, and leaves out kernel, demo and dead tasks', async () => {
    const { model, asked } = await analyzed();
    expect(model.tasks.map((task: { entry: { name: string } }) => task.entry.name)).toEqual(['vMainTask', 'vCommTask']);
    const [meter, comm] = model.tasks;
    expect(meter).toMatchObject({
      creator: { name: 'appInit' },
      site: 'app/main.c:5',
      condition: ['DEMO_TASK_ENABLE'],
      args: ['"main"', '512', '3'],
      waits: ['vTaskDelay(25)'],
      calls: ['RunInit', 'RunSecond', 'RunIdle', 'RunPowerDown'],
    });
    expect(comm).toMatchObject({ waits: ['xQueueReceive(commQueue, &msg, portMAX_DELAY)'], calls: ['handle'] });
    // Creators are asked about once, in file order.
    expect(asked).toEqual([['unusedStart', 'appInit']]);
    expect(model.gaps).toMatchObject({
      unreadable: [],
      demo: 1,
      entryParameter: [{ site: 'lib/wrapper.c:3', expression: 'code', creator: 'osCreate' }],
      unreferenced: [{ site: 'app/dead.c:3', task: 'vDeadTask', creator: 'unusedStart' }],
      entryUnknown: [],
      entryNotIndexed: [],
    });
  });

  it('lists every table entry in order with its condition and comment, whatever the style', async () => {
    const { model } = await analyzed();
    const tables = Object.fromEntries(
      model.tables.map((table: { name: string; variants: unknown[] }) => [table.name, table.variants])
    );
    expect(Object.keys(tables)).toEqual(['initList', 'secondList', 'idleList', 'pdList']);
    const entries = (name: string, variant = 0) =>
      (tables[name][variant] as { entries: Array<Record<string, unknown>> }).entries.map(
        ({ position, names, conditions, comment, def }) => ({
          position,
          names,
          conditions,
          comment,
          file: (def as { file: string } | undefined)?.file,
        })
      );
    expect(entries('secondList')).toEqual([
      { position: 1, names: ['SENSOR_Second'], conditions: [], comment: '', file: 'app/sensor.c' },
      {
        position: 2,
        names: ['TICK_Second'],
        conditions: [],
        comment: 'Tick must run before history',
        file: 'app/tick.c',
      },
      {
        position: 3,
        names: ['BILL_Second'],
        conditions: ['BILL_ENABLE'],
        comment: 'must be after TICK_Second',
        file: 'app/bill.c',
      },
      // #if 0 drops OLD_Second.
      { position: 4, names: ['HIST_Second'], conditions: [], comment: 'history is placed last', file: 'app/history.c' },
    ]);
    expect(entries('idleList').map((entry) => entry.names)).toEqual([['VIEW_Idle'], ['SENSOR_Idle']]);
    // Designated initializers name the function, not the index; a function the index lacks keeps its place.
    expect(entries('initList').map((entry) => [entry.names, entry.file])).toEqual([
      [['SENSOR_Init'], 'app/sensor.c'],
      [['TICK_Start'], 'app/tick.c'],
      [['VIEW_Start'], 'app/view.c'],
      [['MISSING_Init'], undefined],
    ]);
    expect(model.gaps.entriesNotIndexed).toEqual(['MISSING_Init']);
    // Two definitions under #ifdef / #else, both reached through (*pdList[i].func)().
    expect(tables.pdList.map((variant) => (variant as { conditions: string[] }).conditions)).toEqual([
      ['defined(BIG)'],
      ['!defined(BIG)'],
    ]);
    expect(entries('pdList', 1).map((entry) => entry.names[0])).toEqual(['SENSOR_Save', 'TICK_Save', 'VIEW_Save']);
    const second = model.tables.find((table: { name: string }) => table.name === 'secondList');
    expect(second.dispatchers[0].paths.map((p: Array<{ name: string }>) => p.map((def) => def.name))).toEqual([
      ['vMainTask', 'RunSecond'],
    ]);
  });

  it('lists functions held in struct fields and where those fields are called through a pointer', async () => {
    const { model } = await analyzed();
    const lineOf = (text: string) => sources['app/ops.c'].split('\n').findIndex((line) => line.includes(text)) + 1;
    const summary = model.structTables.map(
      (table: {
        name: string;
        type: string;
        line: number;
        fields: Array<{
          field: string;
          defs: Array<{ name: string }>;
          calls: Array<{ def: { name: string }; line: number }>;
        }>;
      }) => ({
        name: table.name,
        type: table.type,
        line: table.line,
        fields: table.fields.map((item) => ({
          field: item.field,
          functions: item.defs.map((def) => def.name),
          calls: item.calls.map((call) => [call.def.name, call.line]),
        })),
      })
    );
    expect(summary).toEqual([
      // From a file with no functions, which the index lists among its files.
      {
        name: 'boardOps',
        type: 'tSensorOps',
        line: 3,
        fields: [{ field: 'read', functions: ['tempRead'], calls: [['SENSOR_Value', lineOf('ops->read(ch)')]] }],
      },
      {
        name: 'sensorOps',
        type: 'tSensorOps',
        line: lineOf('const tSensorOps sensorOps[]'),
        fields: [
          // The #if 0 entry is left out; `&humRead` counts. `other->read` has no known type and
          // two struct types have a `read` field, so it links to neither.
          { field: 'read', functions: ['tempRead', 'humRead'], calls: [['SENSOR_Value', lineOf('ops->read(ch)')]] },
          {
            field: 'reset',
            functions: ['tempReset'],
            // `struct SensorOps *s` is the same type; `current` has no known type, but only
            // one struct type has a `reset` field.
            calls: [
              ['SENSOR_ResetAll', lineOf('(*s->reset)()')],
              ['runReset', lineOf('current->reset()')],
            ],
          },
        ],
      },
      {
        name: 'logOps',
        type: 'tLogOps',
        line: lineOf('static const tLogOps logOps'),
        fields: [{ field: 'read', functions: ['logRead'], calls: [['LOG_Read', lineOf('log->read(0)')]] }],
      },
    ]);
    // initList is a dispatch table already, so it is not repeated here.
    expect(model.structTables.map((table: { name: string }) => table.name)).not.toContain('initList');

    const { language, text } = architecture.labelsFor(labels, 'en-US');
    const generated = architecture.render(model, text, { language, date: '2026-11-07 20:00', mode: 'full' });
    expect(generated).toContain('## Functions held in struct fields');
    // One heading per struct type, with the calls through its fields listed once.
    expect(generated).toContain(
      [
        '### `tLogOps`',
        '',
        `- \`.read\`: called in \`LOG_Read\` (app/ops.c:${lineOf('log->read(0)')})`,
        '',
        `- \`logOps\` (app/ops.c:${lineOf('static const tLogOps logOps')}): \`.read\` → \`logRead\``,
      ].join('\n')
    );
    expect(generated).toContain(
      `- \`.reset\`: called in \`SENSOR_ResetAll\` (app/ops.c:${lineOf('(*s->reset)()')}), \`runReset\` (app/ops.c:${lineOf('current->reset()')})`
    );
  });

  it('shows which tables most modules register in and which modules differ', async () => {
    const { model } = await analyzed();
    const { columns, rows, common, differs } = model.modules;
    // idleList holds functions from two files only, so it is not a module table.
    expect(columns.map((table: { name: string }) => table.name)).toEqual(['initList', 'secondList', 'pdList']);
    expect(common).toEqual([0, 1, 2]);
    expect(differs).toEqual([{ file: 'app/view.c', missing: [1] }]);
    expect(rows.get('app/sensor.c')).toEqual(
      new Map([
        [0, ['SENSOR_Init']],
        [1, ['SENSOR_Second']],
        [2, ['SENSOR_Save']],
      ])
    );
  });

  it('renders the map with the order constraints and the unresolved parts', async () => {
    const { model } = await analyzed();
    const { language, text } = architecture.labelsFor(labels, 'en-US');
    const generated = architecture.render(model, text, { language, date: '2026-11-07 20:00', mode: 'full' });
    expect(generated).toContain('<!-- woody:architecture version=1 language=en-US -->');
    expect(generated).toContain(
      '| `vMainTask` (app/sched.c:45) | `appInit` (app/main.c:5) | DEMO_TASK_ENABLE | "main", 512, 3 | `vTaskDelay(25)` |'
    );
    expect(generated).toContain('| 3 | `BILL_Second` | app/bill.c:1 | BILL_ENABLE | must be after TICK_Second |');
    expect(generated).toContain('| 4 | `MISSING_Init` | not in the index | — | — |');
    expect(generated).toContain('This definition applies only when `!defined(BIG)`.');
    expect(generated).toContain('- `secondList` #2 `TICK_Second`: Tick must run before history');
    expect(generated).toContain('- `secondList` #4 `HIST_Second`: history is placed last');
    expect(generated).toContain('Most modules register in: `initList`, `secondList`, `pdList`.');
    expect(generated).toContain('- app/view.c: not in `secondList`');
    expect(generated).toContain('`osCreate` creates a task from its parameter `code`');
    expect(generated).toContain('creates `vDeadTask` in `unusedStart`, which nothing calls.');
    expect(generated).not.toMatch(/\{[a-z]+\}/);
  });

  it('keeps everything outside the generated markers and refuses a file without them', () => {
    const { text } = architecture.labelsFor(labels, 'zh-CN');
    const created = architecture.merge(undefined, 'first', text);
    expect(created).toMatch(/^# 架构\n/);
    expect(created).toContain('<!-- woody:generated:start -->\nfirst\n<!-- woody:generated:end -->');
    expect(created).toContain('## 改动规范');
    const edited = created.replace('# 架构', '# 架构（团队版）') + '- 新的秒任务加在 KEY_Second 之前。\n';
    const updated = architecture.merge(edited, 'second', text);
    expect(updated).toBe(edited.replace('\nfirst\n', '\nsecond\n'));
    expect(() => architecture.merge('# hand written\n', 'second', text)).toThrow(/markers/);
    expect(architecture.languageOf('<!-- woody:architecture version=1 language=zh-TW -->')).toBe('zh-TW');
    expect(architecture.labelsFor(labels, 'xx-XX').language).toBe('en-US');
  });

  it('ignores arrays of struct variables in otherTables and does not let struct variables shadow missing functions', async () => {
    const tableSources: Record<string, string> = {
      'app/obis.c': [
        'const tObjTable ic_01_table = { 1, 0, NULL };',
        'const tObjTable ic_07_table = { 7, 0, NULL };',
        'const tObjTable* const ObjectTable[] = { &ic_01_table, &ic_07_table };',
        'const tCfg sensorCfg = { 10 };',
        'static const tEntry hookList[] = { { &sensorCfg, SENSOR_Init }, { &sensorCfg, MISSING_Hook } };',
        'int dispatchObj(int idx) { return ObjectTable[idx]->getFunc(); }',
        'void vMainTask(void *p) { for (int i = 0; i < 2; i++) hookList[i].fn(); }',
        'int main(void) { xTaskCreate(vMainTask, "main", 256, NULL, 2, NULL); return 0; }',
        '',
      ].join('\n'),
      'app/sensor.c': 'void SENSOR_Init(void)\n{\n}\n',
    };
    const model = await architecture.analyze({
      functions: [
        ['dispatchObj', 'app/obis.c', 6, 6],
        ['vMainTask', 'app/obis.c', 7, 7],
        ['main', 'app/obis.c', 8, 8],
        ['SENSOR_Init', 'app/sensor.c', 1, 3],
      ],
      sourceFiles: Object.keys(tableSources),
      readSource: (file: string) => tableSources[file] ?? null,
      callersOf: async () => new Map(),
    });
    expect(model.otherTables.map((table: { name: string }) => table.name)).not.toContain('ObjectTable');
    expect(model.gaps.entriesNotIndexed).toEqual(['MISSING_Hook']);
  });

  it('links positional struct function tables via extern pointer arrays and caps large types per struct type', async () => {
    const icDefs = Array.from(
      { length: 14 },
      (_, idx) => `const tObjTable ic_${idx}_table = { ${idx}, 0, IC_ProfileGet, NULL };`
    ).join('\n');
    const posSources: Record<string, string> = {
      'app/ic_xx.h': [
        'typedef int IC_GET(void);',
        'typedef int IC_ACT(void);',
        'typedef struct { int class_id; int ver; IC_GET *getFunc; IC_ACT *actFunc; } tObjTable;',
        'typedef struct { void (*sample)(void); } tMicOps;',
        'extern const tObjTable* const ObjectTable[];',
        '',
      ].join('\n'),
      'app/obis_table.c': `${icDefs}\nconst tMicOps micOps = { MIC_Sample };\n`,
      'app/dlms_api.c': 'int dispatchGet(int i)\n{\n    return ObjectTable[i]->getFunc();\n}\n',
      'app/ic_07.c': 'int IC_ProfileGet(void)\n{\n    return 1;\n}\n',
      'app/mic.c': 'void MIC_Sample(void)\n{\n    micOps.sample();\n}\n',
    };
    const model = await architecture.analyze({
      functions: [
        ['dispatchGet', 'app/dlms_api.c', 1, 4],
        ['IC_ProfileGet', 'app/ic_07.c', 1, 4],
        ['MIC_Sample', 'app/mic.c', 1, 4],
      ],
      sourceFiles: Object.keys(posSources),
      readSource: (file: string) => posSources[file] ?? null,
      callersOf: async () => new Map(),
    });
    const rendered = architecture.render(model, labels['en-US'], { language: 'en-US', date: 'd', mode: 'full' });
    expect(rendered).toContain('### `tObjTable`');
    expect(rendered).toContain('- `.getFunc`: called in `dispatchGet` (app/dlms_api.c:3)');
    expect(rendered).toContain('### `tMicOps`');
  });

  it('refuses positional mapping when a struct definition contains #if directives that shift fields', async () => {
    const guardedSources: Record<string, string> = {
      'app/cfg.h': 'typedef struct {\n#if EXTRA_SLOT\n    int extra;\n#endif\n    void (*run)(void);\n} tGuardedOps;\n',
      'app/cfg.c': 'const tGuardedOps ops = { HOOK_Run };\nvoid HOOK_Run(void)\n{\n}\n',
    };
    const model = await architecture.analyze({
      functions: [['HOOK_Run', 'app/cfg.c', 2, 4]],
      sourceFiles: Object.keys(guardedSources),
      readSource: (file: string) => guardedSources[file] ?? null,
      callersOf: async () => new Map(),
    });
    expect(model.structTables).toEqual([]);
  });

  it('maps inter-image vector API macros, X-Macro headers, and pure data-table files', async () => {
    const bigRows = Array.from({ length: 55 }, (_, idx) => `    ${idx},`).join('\n');
    const fwSources: Record<string, string> = {
      'app/app1_api.h': [
        'typedef struct { void (*en_init)(void); void (*EN_Reset)(void); void (*EXT_Only)(void); } tLegalEntry;',
        '#define legal_api ((tLegalEntry*)APP1_ENTRY_ADDR)',
        '#define EN_Initialize legal_api->en_init',
        '#define EN_Reset legal_api->EN_Reset',
        '#define EXT_Only legal_api->EXT_Only',
        '',
      ].join('\n'),
      'app/app1_api.c':
        'const tLegalEntry legal_entry_list = {\n#undef EN_Initialize\n    en_init,\n    EN_Reset,\n};\n',
      'app/energy.c': 'void en_init(void)\n{\n}\nvoid EN_Reset(void)\n{\n}\n',
      'app/mtask.c':
        'void appStart(void)\n{\n    EN_Initialize();\n}\nint main(void)\n{\n    appStart();\n    return 0;\n}\n',
      'app/eeprom_addr_table.h': 'ENTRY(NVM_ALARM, 64)\nENTRY(NVM_DISP, 128)\nENTRY(NVM_STATE, 32)\n',
      'app/datastore.h': 'typedef enum {\n#define ENTRY(id, sz) id,\n#include "eeprom_addr_table.h"\n} tNvmIdx;\n',
      'app/obis_data.c': `const int DataObj[] = {\n${bigRows}\n};\n`,
    };
    const model = await architecture.analyze({
      functions: [
        ['en_init', 'app/energy.c', 1, 3],
        ['EN_Reset', 'app/energy.c', 4, 6],
        ['appStart', 'app/mtask.c', 1, 4],
        ['main', 'app/mtask.c', 5, 9],
      ],
      sourceFiles: Object.keys(fwSources),
      readSource: (file: string) => fwSources[file] ?? null,
      callersOf: async () => new Map(),
    });
    const rendered = architecture.render(model, labels['en-US'], { language: 'en-US', date: 'd', mode: 'full' });
    expect(rendered).toContain(
      '- `legal_api` (app/app1_api.h, `APP1_ENTRY_ADDR`): 3 entries (2 in index); vector table `legal_entry_list` (app/app1_api.c:1); renamed macros: `EN_Initialize` → `.en_init`; outside index: `EXT_Only`'
    );
    expect(rendered).toContain('- app/eeprom_addr_table.h: X-Macro `ENTRY` (3 entries), expanded in app/datastore.h:3');
    expect(rendered).toContain('- app/obis_data.c: `DataObj` (1-57)');
  });
});
