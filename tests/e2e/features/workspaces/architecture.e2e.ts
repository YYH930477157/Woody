import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '../../fixtures';
import { httpPost } from '../../helpers/httpBridge';
import type { ProjectDetailDto } from '../../../../packages/desktop/src/common/types/project';

const POPUP_OPTION = '.arco-select-popup .arco-select-option';

// Uses a synthetic project and the bundled native indexer; no model call.
test('an index mode can be chosen, saved and indexed with', async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-architecture-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src', 'app.cpp'),
    'int add(int a, int b) { return a + b; }\nint twice(int v) { return add(v, v); }\n'
  );
  await page.waitForFunction(() => Boolean((window as Window & { __backendPort?: number }).__backendPort));
  const workspace = await httpPost<ProjectDetailDto>(page, '/api/projects/workspaces', {
    name: 'Architecture',
    uri: pathToFileURL(root).href,
  });
  await httpPost(page, `/api/projects/${workspace.project_id}/workspace/save`, {
    path: path.join(root, 'architecture.woody-workspace'),
  });
  await page.evaluate((id) => {
    localStorage.setItem('woody.selectedWorkspace', id);
    location.hash = '/guid';
  }, workspace.project_id);
  await page.reload();
  const panel = page.locator('[data-project-panel-host]');
  await panel.waitFor({ timeout: 60_000 });
  await panel.getByRole('button', { name: /^(Architecture|架构)$/ }).click();

  const save = panel.getByRole('button', { name: /^(Save|保存)$/ });
  const savedMode = () =>
    JSON.parse(fs.readFileSync(path.join(root, '.woody', 'codebase-memory.json'), 'utf8')) as { mode: string };
  await panel.getByRole('switch', { name: /^(Enable codebase memory|启用代码库记忆)$/ }).click();
  const select = panel.getByRole('combobox', { name: /^(Indexing mode|索引模式)$/ });

  for (const [option, mode] of [
    [/^(Moderate|适中)$/, 'moderate'],
    [/^(Full|完整)$/, 'full'],
  ] as const) {
    await select.click();
    await expect(select).toHaveAttribute('aria-expanded', 'true');
    // The list has to survive the panel's two-second status poll as well.
    await page.waitForTimeout(2_500);
    await expect(select).toHaveAttribute('aria-expanded', 'true');
    await page.locator(POPUP_OPTION).filter({ hasText: option }).click();
    await expect(select).toContainText(option);
    await save.click();
    await expect.poll(() => savedMode().mode).toBe(mode);
  }

  await panel.getByRole('button', { name: /^(Initialize \/ update index|初始化 \/ 更新索引)$/ }).click();
  await expect(panel.getByRole('status')).toHaveText(/^(Index updated|索引已更新)$/, { timeout: 60_000 });
  await expect(panel.locator('.arco-alert-error')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('architecture-indexed.png') });

  // The app keeps its index under the real profile. It may still be held open, and the name is hashed from the path.
  const name = `woody-${createHash('sha256').update(fs.realpathSync.native(root).toLowerCase()).digest('hex')}`;
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'AionUi', 'codebase-memory', name);
  try {
    fs.rmSync(cache, { recursive: true, force: true });
  } catch {
    /* A few kilobytes are left behind until the daemon exits. */
  }
});
