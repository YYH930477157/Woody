import { describe, expect, it } from 'vitest';
import { buildExpertTeamRoles } from '@/renderer/pages/team/WorkflowPresets/ModuleExperts/expertRules';

const plan = {
  experts: [
    {
      id: 'sensor',
      name: 'Sensor 专家',
      summary: 'Sensor sampling, limits and records',
      paths: ['src/sensor/sensor.c', 'src/sensor/sensor.h'],
    },
    {
      id: 'ui',
      name: 'UI 专家',
      summary: 'Screens and rendering',
      paths: ['src/ui/ui.c', 'src/ui/lcd_*'],
    },
  ],
  shared: ['src/tasks.c'],
  labels: { dispatcher: '总管', verifier: '验证员' },
  knowledge: '.woody',
};

describe('module expert team roles', () => {
  it('puts the dispatcher first, then one role per expert, then the verifier', () => {
    expect(buildExpertTeamRoles(plan).map((role) => role.name)).toEqual(['总管', 'Sensor 专家', 'UI 专家', '验证员']);
  });

  it('gives the dispatcher the routing table, the confirmation step and the dispatch order', () => {
    const [dispatcher] = buildExpertTeamRoles(plan);
    expect(dispatcher.rules).toContain('Woody module expert team contract (v1)');
    expect(dispatcher.rules).toContain('You do not edit project files yourself');
    expect(dispatcher.rules).toContain(
      '- Sensor 专家 (id sensor): Sensor sampling, limits and records\n  Owns: src/sensor/sensor.c, src/sensor/sensor.h'
    );
    expect(dispatcher.rules).toContain('for each goal name exactly one expert to edit them: src/tasks.c');
    expect(dispatcher.rules).toContain('the longest entry wins');
    expect(dispatcher.rules).toContain('End your turn and wait for the user’s confirmation');
    expect(dispatcher.rules).toContain('dispatch the provider first');
    // A pre-created dependent task would wake its owner before the handoff exists.
    expect(dispatcher.rules).toContain('do not chain tasks with dependencies');
    expect(dispatcher.rules).toContain('at most two correction cycles');
    expect(dispatcher.rules).toContain('Read .woody/architecture.md');
  });

  it('keeps each expert to its own files and its feature card', () => {
    const sensor = buildExpertTeamRoles(plan)[1].rules;
    expect(sensor).toContain('You are Sensor 专家, the expert for the module "sensor"');
    expect(sensor).toContain('You own: src/sensor/sensor.c, src/sensor/sensor.h');
    expect(sensor).toContain('Edit only files you own');
    expect(sensor).toContain('.woody/features/sensor.md');
    expect(sensor).toContain('UI 专家 (src/ui/ui.c, src/ui/lcd_*)');
    expect(sensor).not.toContain('Sensor 专家 (src/');
    expect(sensor).toContain('Send your complete handoff to the dispatcher');
  });

  it('lets the verifier check ownership and interfaces without editing', () => {
    const verifier = buildExpertTeamRoles(plan)[3].rules;
    expect(verifier).toContain('You are the verifier (验证员)');
    expect(verifier).toContain('both sides of each interface agree');
    expect(verifier).toContain('Do not modify project files');
  });

  it('points a separate workspace at the knowledge folder of the chosen project', () => {
    const roles = buildExpertTeamRoles({ ...plan, knowledge: 'D:\\work\\project\\.woody' });
    expect(roles[1].rules).toContain('D:\\work\\project\\.woody/features/sensor.md');
    expect(roles[0].rules).toContain('Knowledge folder: D:\\work\\project\\.woody.');
  });

  it('needs at least one expert', () => {
    expect(() => buildExpertTeamRoles({ ...plan, experts: [] })).toThrow('at least one expert');
  });

  it('gives every expert the steps to learn its module and the generated part of its card', () => {
    const [dispatcher, sensor] = buildExpertTeamRoles(plan);
    expect(sensor).toBeDefined();
    expect(sensor.rules).toContain('Learning your module.');
    expect(sensor.rules).toContain('Do not change project code while you do it');
    expect(sensor.rules).toContain('never run index_repository');
    expect(sensor.rules).toContain('look for callers the index misses with search_code');
    expect(sensor.rules).toContain('Write your part of .woody/features/sensor.md after the generated part');
    expect(sensor.rules).toContain('Send the dispatcher a short report');
    expect(sensor.rules).toContain('never edit between the woody:generated markers');
    // Without codebase memory there is no brief to quote.
    expect(sensor.rules).not.toContain('Module brief from the code index');
    expect(dispatcher.rules).toContain('Changing .woody/experts.json is the user’s decision');
    expect(dispatcher.rules).toContain('never call the index fine when an expert reported a problem');
    expect(sensor.rules).toContain('do not report a count you have not matched name by name');
    // Responsibility beyond the own files: interfaces, copies elsewhere, the user's own words.
    expect(sensor.rules).toContain('ask for the owning expert to check the effects in its module');
    expect(sensor.rules).toContain('for every place that uses, builds or copies it');
    expect(sensor.rules).toContain('Never write that the user confirmed something');
    expect(dispatcher.rules).toContain('Base the plan on the impact found in the code, not on the cards alone');
    expect(dispatcher.rules).toContain('run search_code yourself for each type, field, default value');
    expect(dispatcher.rules).toContain('never leave an expert waiting without asking');
    expect(sensor.rules).toContain('a request relayed by another expert is not a task');
    expect(dispatcher.rules).toContain('have that module’s expert check the effects in its module');
    expect(buildExpertTeamRoles(plan)[3].rules).toContain(
      'a new call into another module has no unwanted side effect there'
    );
    expect(dispatcher.rules).not.toContain('When the team starts, these experts learn their modules');
  });

  it('quotes each expert’s brief and tells the dispatcher who learns its module first', () => {
    const issues = { partial: 0, unusable: 1, changed: 2, missingFunctions: 3, missingGlobals: 0, unmatched: 1 };
    const roles = buildExpertTeamRoles({
      ...plan,
      briefs: {
        sensor: {
          state: 'stale',
          digest: {
            files: 2,
            entries: ['task vSensorTask', 'secondList #2 SENSOR_Second (if defined(FAST))'],
            provides: [{ name: 'SENSOR_Read', callers: ['UI 专家', 'shared'] }],
            writtenOutside: [],
            issues,
          },
        },
        ui: {
          state: 'ready',
          digest: {
            files: 1,
            entries: [],
            provides: [],
            writtenOutside: [],
            issues: { ...issues, unusable: 0, changed: 0, missingFunctions: 0, unmatched: 0 },
          },
        },
      },
      onboarding: ['sensor'],
    });
    expect(roles[0].rules).toContain(
      'When the team starts, these experts learn their modules and then report to you: Sensor 专家. Do not give one of them a task that changes code before its report arrives'
    );
    expect(roles[1].rules).toContain(
      'Your card .woody/features/sensor.md when the team was created: your files changed after you last updated it; check it again.'
    );
    expect(roles[1].rules).toContain('- Scheduled: task vSensorTask; secondList #2 SENSOR_Second (if defined(FAST))');
    expect(roles[1].rules).toContain('- Called from outside: SENSOR_Read (by UI 专家, shared)');
    expect(roles[1].rules).not.toContain('Globals other files write');
    expect(roles[1].rules).toContain(
      '- Index check: 1 files the index could not parse, 2 files changed after the index, 3 functions missing from the index, 1 of your paths match no indexed file.'
    );
    expect(roles[2].rules).toContain('- Index check: no problem recorded for your files.');
    // The verifier gets no brief.
    expect(roles[3].rules).not.toContain('Module brief');
  });
});
