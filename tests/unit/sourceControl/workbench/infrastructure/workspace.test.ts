import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectRootResolver } from '@process/services/sourceControl/workbench/workspace';
import type { ProjectDetailDto } from '@/common/types/project';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'woody-scope-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
});
const scope = { projectId: 'project', peId: 'allowed', relativePath: '' };
const project = (): ProjectDetailDto => ({
  project_id: 'project',
  name: 'test',
  explorer: {
    workspace_pe_id: 'allowed',
    entries: [{ pe_id: 'allowed', role: 'workspace', display_path: root, runtime_status: 'available', order_index: 0 }],
  },
});

describe('registered project repository roots', () => {
  it('resolves only roots returned for the requested project', async () => {
    const resolve = createProjectRootResolver(async (id) => {
      expect(id).toBe('project');
      return project();
    });
    expect(await resolve(scope)).toBe(root);
    await expect(resolve({ ...scope, peId: 'unregistered' })).rejects.toThrow();
  });
  it('rejects a mismatched project response', async () => {
    const resolve = createProjectRootResolver(async () => ({ ...project(), project_id: 'other' }));
    await expect(resolve(scope)).rejects.toThrow();
  });
  it('allows a nested repository path but rejects lexical traversal', async () => {
    await mkdir(path.join(root, 'nested'));
    const resolve = createProjectRootResolver(async () => project());
    expect(await resolve({ ...scope, relativePath: 'nested' })).toBe(path.join(root, 'nested'));
    await expect(resolve({ ...scope, relativePath: '../outside' })).rejects.toThrow();
  });
  it('rejects a junction that escapes the registered root', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'woody-outside-'));
    try {
      await symlink(outside, path.join(root, 'escape'), 'junction');
      const resolve = createProjectRootResolver(async () => project());
      await expect(resolve({ ...scope, relativePath: 'escape' })).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
