/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform-agnostic application bridge handlers.
 * Safe to use in both Electron and WebUI server mode.
 * Electron-only handlers (restart, devtools, zoom, CDP) remain in applicationBridge.ts.
 */
import os from 'os';
import path from 'path';
import { ipcBridge } from '@/common';
import { createSkillFileService } from '@process/services/skills';
import { getCronSkillsDir, getSkillsDir, getSystemDir, ProcessEnv } from '@process/utils/initStorage';
import { copyDirectoryRecursively, getConfigPath, getDataPath, resolveCliSafePath } from '@process/utils';

export function initApplicationBridgeCore(): void {
  const skillFiles = createSkillFileService({
    getAllowedLocations: async () => {
      const [skills, skillPaths, externalPaths] = await Promise.all([
        ipcBridge.fs.listAvailableSkills
          .invoke()
          .then((items) => items.map((item) => item.location))
          .catch(() => [] as string[]),
        ipcBridge.fs.getSkillPaths
          .invoke()
          .then((paths) => [paths.user_skills_dir, paths.builtin_skills_dir])
          .catch(() => [] as string[]),
        ipcBridge.fs.getCustomExternalPaths
          .invoke()
          .then((items) => items.map((item) => item.path))
          .catch(() => [] as string[]),
      ]);
      const bundledResourcesRoot =
        (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || path.join(process.cwd(), 'resources');
      return [
        getSkillsDir(),
        getCronSkillsDir(),
        path.join(bundledResourcesRoot, 'bundled-mcp', 'codebase-memory', 'skills'),
        ...skills,
        ...skillPaths,
        ...externalPaths,
      ];
    },
  });
  ipcBridge.fs.listSkillFiles.provider(({ skill_location }) => skillFiles.list(skill_location));
  ipcBridge.fs.readSkillFile.provider(({ skill_location, relative_path }) =>
    skillFiles.read(skill_location, relative_path)
  );

  // application.systemInfo is served by the backend via HTTP; updateSystemInfo
  // and getPath below remain buildProvider (true IPC) because they need
  // main-process-only APIs (copyDirectoryRecursively, os.homedir()).
  ipcBridge.application.updateSystemInfo.provider(async ({ cacheDir, workDir, logDir }) => {
    const oldDir = getSystemDir();
    const safeCacheDir = resolveCliSafePath(cacheDir, getConfigPath());
    const safeWorkDir = resolveCliSafePath(workDir, getDataPath());
    const safeLogDir = logDir ? resolveCliSafePath(logDir, oldDir.logDir) : oldDir.logDir;

    if (oldDir.cacheDir !== safeCacheDir) {
      await copyDirectoryRecursively(oldDir.cacheDir, safeCacheDir);
    }
    await ProcessEnv.set('aionui.dir', { cacheDir: safeCacheDir, workDir: safeWorkDir, logDir: safeLogDir });
  });

  ipcBridge.application.getPath.provider(({ name }) => {
    // Resolve common paths without Electron
    const home = os.homedir();
    const map: Record<string, string> = {
      home,
      desktop: path.join(home, 'Desktop'),
      downloads: path.join(home, 'Downloads'),
    };
    return Promise.resolve(map[name] ?? home);
  });
}
