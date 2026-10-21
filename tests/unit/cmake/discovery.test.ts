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
