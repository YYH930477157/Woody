import { describe, expect, it } from 'vitest';
import { parseVariants, resolveVariants } from '../../../packages/desktop/src/process/services/cmake/variants';
import { configureCommand } from '../../../packages/desktop/src/process/services/cmake/commands';
import {
  defaultConfiguration,
  normalizeConfiguration,
  configurationHash,
  childEnvironment,
} from '../../../packages/desktop/src/process/services/cmake/configuration';

const yaml = `buildType:
  default: debug
  choices:
    debug:
      short: Debug
      buildType: Debug
      settings:
        MESSAGE: 'a & echo unsafe'
    release:
      short: Release
      buildType: Release
meterType:
  default: meter1
  choices:
    meter1:
      short: First meter
      settings:
        METER: 1
        FEATURE: true
      env:
        SDK_DIR: 'C:/SDK folder'
    meter2:
      short: Second meter
      settings:
        METER: 2
`;

describe('CMake variants and commands', () => {
  it('keeps YAML values as literal individual command arguments with legacy configure syntax', () => {
    const config = defaultConfiguration();
    const resolved = resolveVariants(parseVariants(yaml), {});
    const command = configureCommand('C:/source with space', config, resolved, config.tools);
    expect(command.args).toContain('-DMESSAGE=a & echo unsafe');
    expect(command.args).toContain('-DFEATURE=ON');
    expect(command.args.at(-1)).toBe('C:/source with space');
    expect(command.args).not.toContain('-S');
  });
  it('rejects unknown dimensions and choices', () => {
    const dimensions = parseVariants(yaml);
    expect(() => resolveVariants(dimensions, { typo: 'debug' })).toThrow(/selection/);
    expect(() => resolveVariants(dimensions, { buildType: 'typo' })).toThrow(/selection/);
  });
  it.each([
    'axis: {default: missing, choices: {ok: {short: OK}}}',
    'axis: {choices: {ok: {settings: {FLAGS: [a, b]}}}}',
    'axis: {choices: {ok: {env: {"BAD=NAME": value}}}}',
    'axis: {choices: {ok: {env: {AIONUI_BACKEND_TOKEN: secret}}}}',
    'axis: {choices: {ok: {linkage: static}}}',
    'axis: {choices: {ok: {settings: {CMAKE_GENERATOR: Ninja}}}}',
    'axis: &cycle {choices: {ok: {settings: *cycle}}}',
    '!!js/function "function(){}"',
  ])('rejects unsupported or unsafe YAML: %s', (input) => {
    expect(() => parseVariants(input)).toThrow();
  });
  it('supplies Debug and Release only when no variants file exists', () => {
    expect(parseVariants(undefined)[0].choices.map((choice) => choice.id)).toEqual(['Debug', 'Release']);
    expect(() => parseVariants('')).toThrow();
  });
  it('rejects conflicting values across dimensions', () => {
    const dimensions = parseVariants(
      'a: {choices: {x: {settings: {MODE: one}}}}\nb: {choices: {x: {settings: {MODE: two}}}}'
    );
    expect(() => resolveVariants(dimensions, {})).toThrow(/conflict/);
  });
  it('accepts an empty environment value to clear an inherited setting', () => {
    const resolved = resolveVariants(parseVariants('mode: {choices: {normal: {env: {CFLAGS: ""}}}}'), {});
    expect(resolved.env.CFLAGS).toBe('');
  });
  it('changes build identity on variant and toolchain changes but not parallelism', () => {
    const config = defaultConfiguration();
    const resolved = resolveVariants(parseVariants(yaml), {});
    expect(configurationHash(config, resolved)).not.toBe(
      configurationHash({ ...config, tools: { ...config.tools, cCompiler: 'C:/other/gcc.exe' } }, resolved)
    );
    expect(configurationHash(config, resolved)).not.toBe(
      configurationHash(config, resolveVariants(parseVariants(yaml), { meterType: 'meter2' }))
    );
    expect(configurationHash(config, resolved)).toBe(configurationHash({ ...config, jobs: 8 }, resolved));
  });
  it('validates bounded process settings', () => {
    expect(() => normalizeConfiguration({ ...defaultConfiguration(), jobs: 0 })).toThrow();
    expect(() => normalizeConfiguration({ ...defaultConfiguration(), timeoutMs: 86400001 })).toThrow();
    expect(() => normalizeConfiguration({ ...defaultConfiguration(), runArguments: ['a\0b'] })).toThrow();
  });
  it('strips application credentials and merges PATH case-insensitively on Windows', () => {
    const env = childEnvironment(
      { Path: 'base', AIONUI_BACKEND_TOKEN: 'secret', AIONUI_TERMINAL_PORT: '1', KEEP: 'ok' },
      { SDK: 'sdk' },
      ['C:/tool bin']
    );
    expect(Object.keys(env).some((key) => /AIONUI_.*(?:TOKEN|PORT)/i.test(key))).toBe(false);
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(env.PATH).toContain('C:/tool bin');
  });
});
