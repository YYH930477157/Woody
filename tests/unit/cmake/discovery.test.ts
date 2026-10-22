import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CmakeService } from '@/process/services/cmake/cmakeService';

let root: string;
let workspace: string;
let service: CmakeService;
async function project(relative: string) {
  const directory = path.join(workspace, relative);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'CMakeLists.txt'), 'project(meter LANGUAGES C)');
  return fs.realpath(directory);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'woody-discovery-'));
  workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  service = new CmakeService(path.join(root, 'settings'), { env: { PATH: '' } });
});
afterEach(async () => {
  await service.dispose();
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace CMake discovery', () => {
  async function settings(source: string) {
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), source);
  }

  it('honors JSONC sourceDirectory instead of selecting the first root CMakeLists', async () => {
    await project('.');
    const nested = await project('firmware/virtual meter');
    await settings(
      '{ // existing VS Code configuration\n "cmake.sourceDirectory": "${workspaceFolder}/firmware/virtual meter", }'
    );
    expect((await service.discover(workspace)).selectedProjectPath).toBe(nested);
  });

  it('offers each configured source directory as a separate candidate', async () => {
    const a = await project('one');
    const b = await project('two');
    await project('unrelated');
    await settings('{"cmake.sourceDirectory": ["one", "${workspaceRoot}/two", "one"]}');
    expect((await service.discover(workspace)).projects.map((entry) => entry.projectPath)).toEqual([a, b]);
  });

  it.each(['"${command:chooseSource}"', '"../outside"', '42', '[]', '"missing"'])(
    'reports an invalid configured source without silently choosing another project: %s',
    async (value) => {
      await project('firmware');
      await settings(`{"cmake.sourceDirectory": ${value}}`);
      await expect(service.discover(workspace)).rejects.toThrow('cmake.invalidProject');
    }
  );

  it('scans folders when VS Code settings cannot be read and reports why', async () => {
    const firmware = await project('firmware');
    await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
    // Transparently encrypted bytes are not valid text; without PowerShell 7 the reader cannot recover them.
    await fs.writeFile(path.join(workspace, '.vscode/settings.json'), Buffer.from([0xc3, 0x28, 0xff, 0x81]));
    const scanning = new CmakeService(path.join(root, 'settings'), {
      env: { PATH: '', ProgramFiles: path.join(root, 'no-powershell') },
    });
    try {
      const found = await scanning.discover(workspace);
      expect(found.selectedProjectPath).toBe(firmware);
      expect(found.settingsDiagnostic).toMatchObject({ kind: 'read', message: 'cmake.readPowerShellMissing' });
    } finally {
      await scanning.dispose();
    }
  });

  it('loads workspace variants for a configured nested source and remembers the context after restart', async () => {
    const nested = await project('firmware');
    await settings('{"cmake.sourceDirectory": "firmware"}');
    const variantsFile = path.join(workspace, '.vscode/cmake-variants.yaml');
    await fs.writeFile(variantsFile, Buffer.from('\ufeffmode: {choices: {sim: {short: Simulator}}}', 'utf16le'));
    await fs.writeFile(path.join(nested, 'cmake-variants.yaml'), 'mode: {choices: {wrong: {short: Wrong}}}');
    await service.discover(workspace);
    const restarted = new CmakeService(path.join(root, 'settings'), { env: { PATH: '' } });
    try {
      const found = await restarted.inspect(nested);
      expect(found.selection).toEqual({ mode: 'sim' });
      expect(found).toMatchObject({ workspacePath: await fs.realpath(workspace), variantsFile });
    } finally {
      await restarted.dispose();
    }
  });

  it('reads JSON variants and reports their path', async () => {
    const nested = await project('firmware');
    const variantsFile = path.join(workspace, 'cmake-variants.json');
    await fs.writeFile(variantsFile, JSON.stringify({ mode: { choices: { unit: { short: 'UnitTest' } } } }));
    const found = await service.inspect(workspace, true);
    expect(found.selection).toEqual({ mode: 'unit' });
    expect(found.variantsFile).toBe(variantsFile);
    expect(found.projectPath).toBe(nested);
  });

  it('keeps project details and saved selections during a variants error and recovers after repair', async () => {
    const nested = await project('firmware');
    const variantsFile = path.join(workspace, 'cmake-variants.yaml');
    const valid = 'mode: {choices: {sim: {short: Simulator}, unit: {short: UnitTest}}}';
    await fs.writeFile(variantsFile, valid);
    const initial = await service.inspect(workspace, true);
    await service.save(nested, { ...initial.config, selections: { mode: 'unit' } });
    await fs.writeFile(variantsFile, 'mode: \0 broken');
    const invalid = await service.inspect(nested);
    expect(invalid).toMatchObject({
      projectPath: nested,
      variantsFile,
      dimensions: [],
      config: { selections: { mode: 'unit' } },
    });
    expect(invalid.configurationError).toContain(variantsFile);
    expect(invalid.buildDirectory).toBe('');
    await service.save(nested, { ...invalid.config, jobs: 3 });
    await fs.writeFile(variantsFile, valid);
    expect(await service.inspect(nested)).toMatchObject({ selection: { mode: 'unit' }, config: { jobs: 3 } });
  });

  it.each(['configure', 'build', 'test', 'run'] as const)(
    'rejects %s with invalid workspace variants before starting any process',
    async (action) => {
      const nested = await project('firmware');
      await fs.writeFile(path.join(workspace, 'cmake-variants.yaml'), 'mode: \0 invalid');
      await service.discover(workspace);
      await expect(service.start(nested, action)).rejects.toThrow('cmake.invalidVariants');
      expect(await fs.readdir(nested)).toEqual(['CMakeLists.txt']);
    }
  );

  it('blocks debugger launch on invalid workspace variants', async () => {
    const nested = await project('firmware');
    await fs.writeFile(path.join(workspace, 'cmake-variants.yaml'), 'mode: \0 invalid');
    await service.discover(workspace);
    await expect(service.acquireDebugTarget(nested)).rejects.toThrow('cmake.invalidVariants');
  });

  it('retains the panel when individually valid dimensions conflict', async () => {
    const nested = await project('firmware');
    await fs.writeFile(
      path.join(workspace, 'cmake-variants.yaml'),
      'a: {choices: {x: {settings: {MODE: one}}}}\nb: {choices: {x: {settings: {MODE: two}}}}'
    );
    const found = await service.inspect(workspace, true);
    expect(found.projectPath).toBe(nested);
    expect(found.configurationError).toContain('cmake.variantConflict');
    await expect(service.start(nested, 'build')).rejects.toThrow('cmake.variantConflict');
  });

  it('retains choices so a conflicting saved combination can be repaired in the panel', async () => {
    const nested = await project('firmware');
    await fs.writeFile(
      path.join(workspace, 'cmake-variants.yaml'),
      'a: {choices: {x: {settings: {MODE: one}}}}\nb: {choices: {ok: {settings: {MODE: one}}, conflict: {settings: {MODE: two}}}}'
    );
    const initial = await service.inspect(workspace, true);
    const invalid = await service.save(nested, { ...initial.config, selections: { b: 'conflict' } });
    expect(invalid.configurationError).toContain('cmake.variantConflict');
    expect(invalid.dimensions).toHaveLength(2);
    expect(invalid.selection).toEqual({ a: 'x', b: 'conflict' });
    const repaired = await service.save(nested, { ...invalid.config, selections: { b: 'ok' } });
    expect(repaired.configurationError).toBeUndefined();
  });

  it('uses a deterministic variants priority and never falls back past an invalid preferred file', async () => {
    await project('firmware');
    await fs.writeFile(path.join(workspace, 'cmake-variants.yaml'), 'mode: \0 invalid');
    await fs.writeFile(path.join(workspace, 'cmake-variants.json'), '{"mode":{"choices":{"sim":{"short":"OK"}}}}');
    const found = await service.inspect(workspace, true);
    expect(found.variantsFile).toBe(path.join(workspace, 'cmake-variants.yaml'));
    expect(found.configurationError).toContain('cmake.invalidVariants');
  });

  it('automatically selects the only detected project without configuring or building', async () => {
    const nested = await project('firmware');
    const found = await service.discover(workspace);
    expect(found.selectedProjectPath).toBe(nested);
    expect(found.projects).toEqual([{ projectPath: nested, relativePath: 'firmware' }]);
    expect(await fs.readdir(nested)).toEqual(['CMakeLists.txt']);
  });
  it('returns multiple choices and remembers an explicit selection after restart', async () => {
    await project('meter-a');
    const selected = await project('meter-b');
    expect((await service.discover(workspace)).selectedProjectPath).toBeUndefined();
    expect((await service.discover(workspace, 'meter-b')).selectedProjectPath).toBe(selected);
    const restarted = new CmakeService(path.join(root, 'settings'), { env: { PATH: '' } });
    try {
      expect((await restarted.discover(workspace)).selectedProjectPath).toBe(selected);
    } finally {
      await restarted.dispose();
    }
  });
  it('rediscovers changed directories and does not retain a missing choice', async () => {
    const removed = await project('meter-a');
    await project('meter-b');
    await service.discover(workspace, 'meter-a');
    await fs.rm(removed, { recursive: true });
    await project('meter-c');
    const found = await service.discover(workspace);
    expect(found.projects.map((candidate) => candidate.relativePath)).toEqual(['meter-b', 'meter-c']);
    expect(found.selectedProjectPath).toBeUndefined();
  });
  it('rejects selections outside the detected candidate list', async () => {
    await project('firmware');
    await expect(service.discover(workspace, '../external')).rejects.toThrow('cmake.invalidProject');
    await expect(service.discover(workspace, 'firmware/src')).rejects.toThrow('cmake.invalidProject');
  });
  it('returns an empty project list so the panel can offer rescan', async () => {
    expect((await service.discover(workspace)).projects).toEqual([]);
    const nested = await project('firmware');
    expect((await service.discover(workspace)).selectedProjectPath).toBe(nested);
  });
  it('finds a nested project and reads its variants', async () => {
    const nested = await project('firmware/virtual meter');
    await fs.writeFile(
      path.join(nested, 'cmake-variants.yaml'),
      'mode: {default: sim, choices: {sim: {short: Simulator}}}'
    );
    const found = await service.inspect(workspace, true);
    expect(found.projectPath).toBe(nested);
    expect(found.selection).toEqual({ mode: 'sim' });
    expect(found.buildDirectory.startsWith(path.join(nested, 'build'))).toBe(true);
  });
  it('prefers the workspace root over component CMakeLists files', async () => {
    const expected = await project('.');
    await project('src/component');
    expect((await service.inspect(workspace, true)).projectPath).toBe(expected);
  });
  it('treats nested component files below an identified project as part of that project', async () => {
    const expected = await project('firmware');
    await project('firmware/src/component');
    expect((await service.inspect(workspace, true)).projectPath).toBe(expected);
  });
  it('reports all independent candidates instead of picking the first', async () => {
    await project('meter-a');
    await project('meter-b');
    await expect(service.inspect(workspace, true)).rejects.toThrow('cmake.ambiguousProject: meter-a, meter-b');
  });
  it('skips generated and dependency directories', async () => {
    await Promise.all(['build', 'out', 'node_modules', '.git', 'cmake-build-debug'].map(project));
    const expected = await project('firmware');
    expect((await service.inspect(workspace, true)).projectPath).toBe(expected);
  });
  it('does not traverse directory links or search outside the workspace', async () => {
    const external = path.join(root, 'external');
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'CMakeLists.txt'), 'project(external)');
    const link = path.join(workspace, 'linked');
    await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      await expect(service.inspect(workspace, true)).rejects.toThrow('cmake.projectMissing');
    } finally {
      await fs.unlink(link);
    }
  });
  it('reports a missing project without exposing a raw ENOENT error', async () => {
    await expect(service.inspect(workspace, true)).rejects.toThrow('cmake.projectMissing');
  });
  it('does not rediscover a different project for an AI call or a saved build target', async () => {
    await project('firmware');
    await expect(service.inspect(workspace)).rejects.toThrow();
    await expect(service.start(workspace, 'build')).rejects.toThrow();
  });
  it('discovers the current location after the workspace is moved', async () => {
    await project('firmware');
    const previous = await service.inspect(workspace, true);
    const moved = path.join(root, 'offline workspace');
    await fs.rename(workspace, moved);
    const found = await service.inspect(moved, true);
    expect(found.projectPath).toBe(await fs.realpath(path.join(moved, 'firmware')));
    expect(found.projectPath).not.toBe(previous.projectPath);
  });
  it('reports an incomplete search instead of selecting a candidate before the depth limit', async () => {
    await project('meter');
    await fs.mkdir(path.join(workspace, ...Array<string>(17).fill('nested')), { recursive: true });
    await expect(service.inspect(workspace, true)).rejects.toThrow('cmake.projectSearchLimit');
  });
});
