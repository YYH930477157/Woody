import { test, expect } from '../fixtures';
import { httpPost } from '../helpers/httpBridge';
import { selectAgent } from '../helpers/conversation';
import type { ProjectDetailDto } from '../../../packages/desktop/src/common/types/project';

const SELECTED_WORKSPACE = 'woody.selectedWorkspace';

// Uses the isolated Electron fixture and a real local backend; no model call.
test('closing waits for the unsaved workspace decision and cancelling keeps the app open', async ({
  page,
  electronApp,
}) => {
  test.setTimeout(90_000);
  await page.waitForFunction(() => Boolean((window as Window & { __backendPort?: number }).__backendPort));
  const workspace = await httpPost<ProjectDetailDto>(page, '/api/projects/workspaces', { name: 'Close guard' });
  await page.evaluate(
    ([key, id]) => {
      localStorage.setItem(key, id);
      location.hash = '/guid';
    },
    [SELECTED_WORKSPACE, workspace.project_id]
  );
  await page.reload();
  await selectAgent(page, 'aionrs');
  await expect(page.getByRole('button', { name: /^(Workspaces|工作区管理)$/ }).first()).toBeVisible();

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => !window.isDestroyed() && window.isVisible())
      ?.close();
  });

  const prompt = page.locator('.arco-modal:visible').filter({ hasText: /Unsaved changes|未保存/ });
  await expect(prompt).toBeVisible();

  // Past the fixed deadline this replaced: a dialog on screen is not a hung renderer.
  await page.waitForTimeout(7_000);
  await expect(prompt).toBeVisible();

  await prompt.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
  await expect(prompt).toBeHidden();
  expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);

  // Leave no unsaved selection behind, or closing the app at the end of the run would prompt again.
  await page.evaluate((key) => localStorage.removeItem(key), SELECTED_WORKSPACE);
  await page.reload();
});
