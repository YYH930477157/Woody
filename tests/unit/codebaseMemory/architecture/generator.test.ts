import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const architecture = require(path.resolve('resources/bundled-mcp/codebase-memory/architecture.cjs'));
const labels = require(path.resolve('resources/bundled-mcp/codebase-memory/architecture-labels.json'));

type Row = [string, string, number, number];

/** A small FreeRTOS project in the styles different people write. */
const sources: Record<string, string> = {
  'app/main.c': `
void appInit(void)
{
#if DEMO_TASK_ENABLE
    xTaskCreate(vMeterTask, "meter", 512, NULL, 3, NULL);   /* main loop */
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
  // CRLF line endings, as in the user's firmware.
  'app/sched.c': `
typedef struct { void (*func)(void); const char *name; } tTask;
#define TASK(f) {f, #f}
static const tTask secondList[] =
{
    TASK(ALARM_Second),
    // Clock must run before tariff
    TASK(CLOCK_Second),
    #if PREPAY_ENABLE
    TASK(PAY_Second),   // must be after CLOCK_Second
    #endif
#if 0
    TASK(OLD_Second),
#endif
    TASK(TF_Second),    /* tariff is placed last */
};
static void (* const idleList[])(void) = { DISP_Idle, ALARM_Idle };
static const struct { int id; void (*init)(void); } initList[] = {
    [0] = { 1, ALARM_Init },
    { .id = 2, .init = CLOCK_Init },
    { 3, DISP_Init },
    { 4, MISSING_Init },
};
#ifdef BIG
static const tTask pdList[] = { TASK(ALARM_Save) };
#else
static const tTask pdList[] = { TASK(ALARM_Save), TASK(CLOCK_Save), TASK(DISP_Save) };
#endif
static void SecondProc(void)
{
    for (int i = 0; i < 4; i++) secondList[i].func();
}
static void IdleProc(void)
{
    for (int i = 0; i < 2; i++) idleList[i]();
}
static void InitProc(void)
{
    for (int i = 0; i < 4; i++) initList[i].init();
}
static void PdProc(void)
{
    for (int i = 0; i < 3; i++) (*pdList[i].func)();
}
void vMeterTask(void *p)
{
    InitProc();
    for (;;)
    {
        if (tick()) SecondProc();
        IdleProc();
        vTaskDelay(25);
    }
    PdProc();
}
void vCommTask(void *p)
{
    for (;;) { xQueueReceive(commQueue, &msg, portMAX_DELAY); handle(&msg); }
}
static void handle(void *m)
{
}
`.replace(/\n/g, '\r\n'),
  'app/alarm.c':
    'void ALARM_Second(void)\n{\n}\nvoid ALARM_Idle(void)\n{\n}\nvoid ALARM_Init(void)\n{\n}\nvoid ALARM_Save(void)\n{\n}\n',
  'app/clock.c': 'void CLOCK_Second(void)\n{\n}\nvoid CLOCK_Init(void)\n{\n}\nvoid CLOCK_Save(void)\n{\n}\n',
  'app/display.c': 'void DISP_Idle(void)\n{\n}\nvoid DISP_Init(void)\n{\n}\nvoid DISP_Save(void)\n{\n}\n',
  'app/pay.c': 'void PAY_Second(void)\n{\n}\n',
  'app/tariff.c': 'void TF_Second(void)\n{\n}\n',
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
    expect(model.tasks.map((task: { entry: { name: string } }) => task.entry.name)).toEqual([
      'vMeterTask',
      'vCommTask',
    ]);
    const [meter, comm] = model.tasks;
    expect(meter).toMatchObject({
      creator: { name: 'appInit' },
      site: 'app/main.c:5',
      condition: ['DEMO_TASK_ENABLE'],
      args: ['"meter"', '512', '3'],
      waits: ['vTaskDelay(25)'],
      calls: ['InitProc', 'SecondProc', 'IdleProc', 'PdProc'],
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
      { position: 1, names: ['ALARM_Second'], conditions: [], comment: '', file: 'app/alarm.c' },
      {
        position: 2,
        names: ['CLOCK_Second'],
        conditions: [],
        comment: 'Clock must run before tariff',
        file: 'app/clock.c',
      },
      {
        position: 3,
        names: ['PAY_Second'],
        conditions: ['PREPAY_ENABLE'],
        comment: 'must be after CLOCK_Second',
        file: 'app/pay.c',
      },
      // #if 0 drops OLD_Second.
      { position: 4, names: ['TF_Second'], conditions: [], comment: 'tariff is placed last', file: 'app/tariff.c' },
    ]);
    expect(entries('idleList').map((entry) => entry.names)).toEqual([['DISP_Idle'], ['ALARM_Idle']]);
    // Designated initializers name the function, not the index; a function the index lacks keeps its place.
    expect(entries('initList').map((entry) => [entry.names, entry.file])).toEqual([
      [['ALARM_Init'], 'app/alarm.c'],
      [['CLOCK_Init'], 'app/clock.c'],
      [['DISP_Init'], 'app/display.c'],
      [['MISSING_Init'], undefined],
    ]);
    expect(model.gaps.entriesNotIndexed).toEqual(['MISSING_Init']);
    // Two definitions under #ifdef / #else, both reached through (*pdList[i].func)().
    expect(tables.pdList.map((variant) => (variant as { conditions: string[] }).conditions)).toEqual([
      ['defined(BIG)'],
      ['!defined(BIG)'],
    ]);
    expect(entries('pdList', 1).map((entry) => entry.names[0])).toEqual(['ALARM_Save', 'CLOCK_Save', 'DISP_Save']);
    const second = model.tables.find((table: { name: string }) => table.name === 'secondList');
    expect(second.dispatchers[0].paths.map((p: Array<{ name: string }>) => p.map((def) => def.name))).toEqual([
      ['vMeterTask', 'SecondProc'],
    ]);
  });

  it('shows which tables most modules register in and which modules differ', async () => {
    const { model } = await analyzed();
    const { columns, rows, common, differs } = model.modules;
    // idleList holds functions from two files only, so it is not a module table.
    expect(columns.map((table: { name: string }) => table.name)).toEqual(['initList', 'secondList', 'pdList']);
    expect(common).toEqual([0, 1, 2]);
    expect(differs).toEqual([{ file: 'app/display.c', missing: [1] }]);
    expect(rows.get('app/alarm.c')).toEqual(
      new Map([
        [0, ['ALARM_Init']],
        [1, ['ALARM_Second']],
        [2, ['ALARM_Save']],
      ])
    );
  });

  it('renders the map with the order constraints and the unresolved parts', async () => {
    const { model } = await analyzed();
    const { language, text } = architecture.labelsFor(labels, 'en-US');
    const generated = architecture.render(model, text, { language, date: '2026-11-07 20:00', mode: 'full' });
    expect(generated).toContain('<!-- woody:architecture version=1 language=en-US -->');
    expect(generated).toContain(
      '| `vMeterTask` (app/sched.c:45) | `appInit` (app/main.c:5) | DEMO_TASK_ENABLE | "meter", 512, 3 | `vTaskDelay(25)` |'
    );
    expect(generated).toContain('| 3 | `PAY_Second` | app/pay.c:1 | PREPAY_ENABLE | must be after CLOCK_Second |');
    expect(generated).toContain('| 4 | `MISSING_Init` | not in the index | — | — |');
    expect(generated).toContain('This definition applies only when `!defined(BIG)`.');
    expect(generated).toContain('- `secondList` #2 `CLOCK_Second`: Clock must run before tariff');
    expect(generated).toContain('- `secondList` #4 `TF_Second`: tariff is placed last');
    expect(generated).toContain('Most modules register in: `initList`, `secondList`, `pdList`.');
    expect(generated).toContain('- app/display.c: not in `secondList`');
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
    const edited = created.replace('# 架构', '# 架构（团队版）') + '- 新的秒任务加在 STATE_SecondProc 之前。\n';
    const updated = architecture.merge(edited, 'second', text);
    expect(updated).toBe(edited.replace('\nfirst\n', '\nsecond\n'));
    expect(() => architecture.merge('# hand written\n', 'second', text)).toThrow(/markers/);
    expect(architecture.languageOf('<!-- woody:architecture version=1 language=zh-TW -->')).toBe('zh-TW');
    expect(architecture.labelsFor(labels, 'xx-XX').language).toBe('en-US');
  });
});
