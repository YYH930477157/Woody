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
});
