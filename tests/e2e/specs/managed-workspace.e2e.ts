import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from '../fixtures';
import { httpGet, httpPost } from '../helpers/httpBridge';
import { selectAgent } from '../helpers/conversation';
import type { ProjectDetailDto } from '../../../packages/desktop/src/common/types/project';

// Uses the isolated Electron fixture and a real local backend; no model call.
test('managed roots round-trip through desktop UI and shared conversation identity', async ({
  page,
  electronApp,
}, testInfo) => {
  test.setTimeout(120_000);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-workspace-e2e-'));
  const first = path.join(temp, 'application');
  const second = path.join(temp, 'library');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'keep.ts'), 'export const keep = 1;\n');
  const config = path.join(temp, 'sample.woody-workspace');
  await page.waitForFunction(() => Boolean((window as Window & { __backendPort?: number }).__backendPort));
  const workspace = await httpPost<ProjectDetailDto>(page, '/api/projects/workspaces', {
    name: 'Workspace smoke',
    uri: pathToFileURL(first).href,
  });
  const endpoint = `/api/projects/${workspace.project_id}`;
  await httpPost(page, `${endpoint}/workspace/save`, { path: config });
  await page.evaluate((id) => {
    localStorage.setItem('woody.selectedWorkspace', id);
    location.hash = '/guid';
  }, workspace.project_id);
  await page.reload();
  await selectAgent(page, 'aionrs');
  await page
    .getByRole('button', { name: /^(Workspaces|工作区管理)$/ })
    .first()
    .click();
  const modal = page.locator('.arco-modal:visible');
  await expect(modal.getByLabel(/^(Workspace name|工作区名称)$/)).toHaveValue('Workspace smoke');
  await electronApp.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, second);
  await modal.getByRole('button', { name: /^(Add folder to project|添加文件夹到项目)$/ }).click();
  await expect.poll(async () => (await httpGet<ProjectDetailDto>(page, endpoint)).explorer.entries.length).toBe(2);
  await modal.getByRole('button', { name: /^(Save|保存)$/ }).click();
  await expect.poll(async () => (await httpGet<ProjectDetailDto>(page, endpoint)).workspace?.dirty).toBe(false);
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
  expect(saved.roots).toHaveLength(2);
  await modal
    .getByRole('button', { name: /^(Remove from project|从项目移除)$/ })
    .first()
    .click();
  await expect.poll(async () => (await httpGet<ProjectDetailDto>(page, endpoint)).explorer.entries.length).toBe(1);
  await modal.getByRole('button', { name: /^(Discard changes|放弃更改)$/ }).click();
  await expect.poll(async () => (await httpGet<ProjectDetailDto>(page, endpoint)).explorer.entries.length).toBe(2);
  expect(fs.readFileSync(path.join(first, 'keep.ts'), 'utf8')).toBe('export const keep = 1;\n');
  const chats = [];
  for (const name of ['First chat', 'Second chat']) {
    chats.push(
      await httpPost<{ id: string; project_id: string }>(page, '/api/conversations', {
        type: 'aionrs',
        name,
        extra: { workspace_project_id: workspace.project_id },
      })
    );
  }
  expect(chats[0].project_id).toBe(workspace.project_id);
  expect(chats[1].project_id).toBe(workspace.project_id);
  expect(chats[0].id).not.toBe(chats[1].id);
  await page.screenshot({ path: testInfo.outputPath('managed-workspace.png') });
});
