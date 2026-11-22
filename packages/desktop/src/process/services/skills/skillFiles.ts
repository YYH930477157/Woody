/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillFileNode } from '@/common/adapter/ipcBridge';
import fs from 'fs/promises';
import path from 'path';

export type SkillFileServiceOptions = {
  getAllowedLocations?: () => Promise<string[]>;
};

const normalizeComparisonPath = (filePath: string): string =>
  process.platform === 'win32' ? filePath.toLowerCase() : filePath;

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(normalizeComparisonPath(root), normalizeComparisonPath(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const toSkillDirectory = (skillLocation: string): string => {
  const location = path.resolve(skillLocation);
  return path.basename(location).toLowerCase() === 'skill.md' ? path.dirname(location) : location;
};

const resolveAllowedRoots = async (getAllowedLocations: () => Promise<string[]>): Promise<string[]> => {
  const locations = await getAllowedLocations();
  const roots = await Promise.all(
    locations
      .filter((loc): loc is string => typeof loc === 'string' && path.isAbsolute(loc))
      .map(async (loc) => {
        try {
          return await fs.realpath(toSkillDirectory(loc));
        } catch {
          return null;
        }
      })
  );
  return roots.filter((item): item is string => item !== null);
};

const resolveSkillRoot = async (
  skillLocation: string,
  getAllowedLocations?: () => Promise<string[]>
): Promise<string> => {
  if (!path.isAbsolute(skillLocation)) {
    throw new Error('Skill location must be absolute');
  }

  const root = await fs.realpath(toSkillDirectory(skillLocation));
  if (getAllowedLocations) {
    const allowedRoots = await resolveAllowedRoots(getAllowedLocations);
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, root))) {
      throw new Error('Skill location is outside registered skill directories');
    }
  }
  return root;
};

const resolveExistingEntry = async (root: string, relativePath: string): Promise<string> => {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('Skill file path must be relative');
  }

  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw new Error('Skill file path is outside the skill directory');
  }

  const realTarget = await fs.realpath(candidate);
  if (!isWithin(root, realTarget)) {
    throw new Error('Skill file path resolves outside the skill directory');
  }
  return realTarget;
};

const compareEntries = (a: SkillFileNode, b: SkillFileNode): number => {
  const aPinned = a.relativePath.toLowerCase() === 'skill.md';
  const bPinned = b.relativePath.toLowerCase() === 'skill.md';
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
};

const listDirectory = async (root: string, directory: string): Promise<SkillFileNode[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nodes: SkillFileNode[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        relativePath,
        type: 'directory',
        children: await listDirectory(root, absolutePath),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, relativePath, type: 'file' });
    }
  }

  return nodes.toSorted(compareEntries);
};

export const createSkillFileService = (options: SkillFileServiceOptions = {}) => ({
  async list(skillLocation: string): Promise<SkillFileNode[]> {
    const root = await resolveSkillRoot(skillLocation, options.getAllowedLocations);
    return listDirectory(root, root);
  },

  async read(skillLocation: string, relativePath: string): Promise<string> {
    const root = await resolveSkillRoot(skillLocation, options.getAllowedLocations);
    const target = await resolveExistingEntry(root, relativePath);
    return fs.readFile(target, 'utf8');
  },
});
