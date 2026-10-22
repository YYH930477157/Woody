import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CmakeTools } from '@/common/types/cmake';
import { resolveTools } from '@/process/services/cmake/toolchain';
import { parseVariants, resolveVariants } from '../../../packages/desktop/src/process/services/cmake/variants';
import { loadDimensions } from '../../../packages/desktop/src/process/services/cmake/workspace';
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

describe('CMake variants file encoding', () => {
  let root: string;
  const source = yaml.replace('First meter', '\u4e09\u76f8\u7535\u8868');
  const encodings = [
    { name: 'UTF-8', bytes: Buffer.from(source) },
    { name: 'UTF-8 BOM', bytes: Buffer.from('\ufeff' + source) },
    { name: 'UTF-16LE BOM', bytes: Buffer.from('\ufeff' + source, 'utf16le') },
    { name: 'UTF-16BE BOM', bytes: Buffer.from('\ufeff' + source, 'utf16le').swap16() },
  ];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-variants-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const filename of [
    'cmake-variants.yaml',
    'cmake-variants.yml',
    '.vscode/cmake-variants.yaml',
    '.vscode/cmake-variants.yml',
  ]) {
    it.each(encodings)(`loads ${filename} in $name without changing variant values`, async ({ bytes }) => {
      const file = path.join(root, filename);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      expect(await loadDimensions(root)).toEqual(parseVariants(source));
      expect(await fs.readFile(file)).toEqual(bytes);
    });
  }

  it.each([
    { name: 'literal NUL', bytes: Buffer.from(yaml.replace('First meter', 'First\0meter')) },
    { name: 'truncated UTF-16', bytes: Buffer.from('\ufeff' + yaml, 'utf16le').subarray(0, -1) },
    { name: 'invalid UTF-8', bytes: Buffer.concat([Buffer.from(yaml + '# '), Buffer.from([0xff])]) },
  ])('rejects $name rather than silently repairing the configuration', async ({ bytes }) => {
    const file = path.join(root, 'cmake-variants.yaml');
    await fs.writeFile(file, bytes);
    await expect(loadDimensions(root)).rejects.toThrow('cmake.invalidVariants');
    await expect(loadDimensions(root)).rejects.toThrow(file);
  });

  it('keeps the byte limit for UTF-16 files', async () => {
    await fs.writeFile(
      path.join(root, 'cmake-variants.yaml'),
      Buffer.from('\ufeff' + yaml + '# ' + 'x'.repeat(131072), 'utf16le')
    );
    await expect(loadDimensions(root)).rejects.toThrow('cmake.fileTooLarge');
  });
});

describe('independent CMake tool discovery', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-tools-'));
    for (const name of ['cmake', 'ctest', 'gcc', 'g++', 'mingw32-make'])
      await fs.writeFile(path.join(root, `${name}.exe`), 'fixture');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  function denyCmake(): string {
    const denied = path.join(root, 'cmake.exe');
    const original = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation(((file, ...args) => {
      if (file === denied)
        return Promise.reject(Object.assign(new Error('private operating system detail'), { code: 'EACCES' }));
      return Reflect.apply(original, fs, [file, ...args]);
    }) as typeof fs.stat);
    return denied;
  }
  it('keeps accessible tools discoverable when one configured executable denies access', async () => {
    const denied = denyCmake();
    const errors: Partial<Record<keyof CmakeTools, string>> = {};
    const tools = await resolveTools({ ...defaultConfiguration().tools, cmake: denied }, { PATH: root }, errors);
    expect(errors).toEqual({ cmake: 'cmake.readDenied' });
    expect(tools).toEqual({
      cmake: denied,
      ctest: path.join(root, 'ctest.exe'),
      cCompiler: path.join(root, 'gcc.exe'),
      cxxCompiler: path.join(root, 'g++.exe'),
      make: path.join(root, 'mingw32-make.exe'),
    });
  });
  it('keeps strict configure resolution failures when no error collector was requested', async () => {
    const denied = denyCmake();
    await expect(
      resolveTools({ ...defaultConfiguration().tools, cmake: denied }, { PATH: root })
    ).rejects.toMatchObject({ code: 'EACCES' });
  });
  it('isolates invalid manual scripts without substituting another executable', async () => {
    const manual = path.join(root, 'cmake.cmd');
    const errors: Partial<Record<keyof CmakeTools, string>> = {};
    const tools = await resolveTools({ ...defaultConfiguration().tools, cmake: manual }, { PATH: root }, errors);
    expect(errors).toEqual({ cmake: 'cmake.toolPath' });
    expect(tools.cmake).toBe(manual);
    expect(tools.cCompiler).toBe(path.join(root, 'gcc.exe'));
  });
});

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
