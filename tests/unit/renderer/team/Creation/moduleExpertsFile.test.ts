import { describe, expect, it } from 'vitest';
import {
  expertIssue,
  MODULE_EXPERTS_LIMIT,
  parseExpertPaths,
  validateExpertsFile,
  type ModuleExpert,
} from '@/common/types/team/moduleExperts';

const sensor: ModuleExpert = { id: 'sensor', name: 'Sensor 专家', summary: 'Sensor sampling', paths: ['src/sensor.c'] };

describe('module experts file', () => {
  it('normalizes typed paths: one per line or comma, forward slashes, no ./ and no duplicates', () => {
    expect(parseExpertPaths('.\\src\\sensor.c\r\n\nsrc/sensor.h, src//drivers/\nsrc/sensor.c')).toEqual([
      'src/sensor.c',
      'src/sensor.h',
      'src/drivers/',
    ]);
  });

  it('reports the first problem of an expert', () => {
    expect(expertIssue(sensor, [])).toBeNull();
    expect(expertIssue({ ...sensor, id: 'Sensor' }, [])).toBe('id');
    expect(expertIssue({ ...sensor, id: 'sensor-' }, [])).toBe('id');
    expect(expertIssue(sensor, [{ ...sensor, name: 'Other' }])).toBe('idTaken');
    expect(expertIssue({ ...sensor, name: ' ' }, [])).toBe('name');
    expect(expertIssue(sensor, [{ ...sensor, id: 'other' }])).toBe('nameTaken');
    expect(expertIssue({ ...sensor, summary: '' }, [])).toBe('summary');
    expect(expertIssue({ ...sensor, paths: [] }, [])).toBe('paths');
    expect(expertIssue({ ...sensor, paths: ['../outside.c'] }, [])).toBe('paths');
    expect(expertIssue({ ...sensor, paths: ['D:/work/sensor.c'] }, [])).toBe('paths');
    expect(expertIssue({ ...sensor, paths: ['/sensor.c'] }, [])).toBe('paths');
  });

  it('validates and normalizes a saved file', () => {
    expect(
      validateExpertsFile({
        version: 1,
        experts: [{ id: ' sensor ', name: 'Sensor 专家', summary: ' Sensor sampling ', paths: ['src\\sensor.c'] }],
      })
    ).toEqual({ version: 1, experts: [sensor], shared: [] });
  });

  it('refuses files it does not understand', () => {
    expect(() => validateExpertsFile([])).toThrow('JSON object');
    expect(() => validateExpertsFile({ version: 2, experts: [] })).toThrow('version');
    expect(() => validateExpertsFile({ version: 1, experts: {} })).toThrow('experts must be a list');
    expect(() => validateExpertsFile({ version: 1, experts: [sensor, sensor] })).toThrow('invalid idTaken');
    expect(() => validateExpertsFile({ version: 1, experts: [{ ...sensor, paths: 'sensor.c' }] })).toThrow(
      'list of strings'
    );
    expect(() => validateExpertsFile({ version: 1, experts: [], shared: ['../x'] })).toThrow('shared');
    const many = Array.from({ length: MODULE_EXPERTS_LIMIT + 1 }, (_, i) => ({
      ...sensor,
      id: `m${i}`,
      name: `M${i}`,
    }));
    expect(() => validateExpertsFile({ version: 1, experts: many })).toThrow(`At most ${MODULE_EXPERTS_LIMIT}`);
  });
});
