import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, type Locator, type Page } from '@playwright/test';
import { test } from '../../fixtures';
import { httpInvoke, httpPost } from '../../helpers/httpBridge';
import type { ProjectDetailDto } from '../../../../packages/desktop/src/common/types/project';

const MERGE_TAB = /^(Resolve conflicts|解决冲突)$/;
const SHELF_TAB = /^(Shelves and patches|Shelf 与补丁)$/;
const HISTORY_TAB = /^(Local history|本地历史)$/;
const OPERATIONS_TAB = /^(Repository operations|仓库操作)$/;
const CONFIRM = /^(Confirm|确定)$/;

// Every repository here is synthetic and lives in a temporary folder.
test.describe.serial('Git workbench panels in the real app', () => {
  let base: string;
  let conflictRoot: string;
  let plainRoot: string;
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const write = (root: string, file: string, text: string) => fs.writeFileSync(path.join(root, file), text);
  const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const commit = (root: string, message: string) => {
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Scenario Test', '-c', 'user.email=scenario@example.invalid', 'commit', '-qm', message);
  };
  const panel = (page: Page) => page.locator('[data-project-panel-host]');
  const visibleModals = (page: Page) => page.locator('.arco-modal:visible');
  const chooseRepo = async (page: Page, name: string) => {
    await panel(page)
      .getByRole('button', { name: /^(Changes|变更)$/ })
      .click();
    await panel(page).locator('[data-scm-repo-item]').filter({ hasText: name }).click();
    await panel(page)
      .getByRole('button', { name: /^(Refresh changes|刷新变更)$/ })
      .click();
    await expect(panel(page).locator('[data-scm-loading]')).toHaveCount(0);
  };
  const openWorkbench = async (page: Page, repo: string, tab: RegExp): Promise<Locator> => {
    await chooseRepo(page, repo);
    await panel(page)
      .getByRole('button', { name: /^(Git history|Git 历史)$/ })
      .click();
    const modal = visibleModals(page).first();
    await modal.getByRole('tab', { name: tab }).click();
    return modal;
  };
  const closeWorkbench = async (page: Page) => {
    await visibleModals(page).first().locator('.arco-modal-close-icon').click();
    await expect(visibleModals(page)).toHaveCount(0);
  };
  const confirmDialog = (page: Page) => visibleModals(page).last();
  const confirm = (page: Page, name = CONFIRM) => confirmDialog(page).getByRole('button', { name }).click();

  test.beforeAll(async ({ page, electronApp }) => {
    test.setTimeout(90_000);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-git-panels-'));
    conflictRoot = path.join(base, 'conflict');
    plainRoot = path.join(base, 'plain');
    for (const root of [conflictRoot, plainRoot]) {
      fs.mkdirSync(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'core.autocrlf', 'false');
      git(root, 'config', 'user.name', 'Scenario Test');
      git(root, 'config', 'user.email', 'scenario@example.invalid');
    }

    const lines = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`);
    write(conflictRoot, 'long.txt', `${lines.join('\n')}\n`);
    commit(conflictRoot, 'Initial fixture');
    git(conflictRoot, 'checkout', '-qb', 'feature');
    lines[399] = 'feature side';
    write(conflictRoot, 'long.txt', `${lines.join('\n')}\n`);
    commit(conflictRoot, 'Feature');
    git(conflictRoot, 'checkout', '-q', 'main');
    lines[399] = 'main side';
    write(conflictRoot, 'long.txt', `${lines.join('\n')}\n`);
    commit(conflictRoot, 'Main');
    expect(spawnSync('git', ['-C', conflictRoot, 'merge', 'feature'], { windowsHide: true }).status).toBe(1);

    write(plainRoot, 'notes.txt', 'original notes\n');
    write(plainRoot, 'extra.txt', 'original extra\n');
    write(plainRoot, 'history.txt', 'first version\n');
    commit(plainRoot, 'Initial fixture');

    let workspace = await httpPost<ProjectDetailDto>(page, '/api/projects/workspaces', {
      name: 'Git panels',
      uri: pathToFileURL(conflictRoot).href,
    });
    workspace = await httpInvoke(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
      name: workspace.name,
      roots: [
        { pe_id: workspace.explorer.entries[0].pe_id, uri: pathToFileURL(conflictRoot).href, display_name: 'conflict' },
        { uri: pathToFileURL(plainRoot).href, display_name: 'plain' },
      ],
      default_pe_id: workspace.explorer.entries[0].pe_id,
    });
    await httpPost(page, `/api/projects/${workspace.project_id}/workspace/save`, {
      path: path.join(base, 'panels.woody-workspace'),
    });
    await page.evaluate((id) => {
      localStorage.setItem('woody.selectedWorkspace', id);
      location.hash = '/guid';
    }, workspace.project_id);
    await page.reload();
    await panel(page).waitFor({ timeout: 60_000 });
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.maximize();
    });
    await panel(page)
      .getByRole('button', { name: /^(Changes|变更)$/ })
      .click();
    await expect(panel(page).locator('[data-scm-repo-item]')).toHaveCount(2, { timeout: 30_000 });
  });

  test('a conflict deep in a file opens at the conflict', async ({ page }, info) => {
    const modal = await openWorkbench(page, 'conflict', MERGE_TAB);
    const [ours, result, theirs] = [0, 1, 2].map((index) => modal.locator('section').nth(index));

    await expect(result.locator('.cm-content')).toContainText('<<<<<<<', { timeout: 15_000 });
    for (const [pane, line] of [
      [result, '<<<<<<<'],
      [ours, 'main side'],
      [theirs, 'feature side'],
    ] as const) {
      // Each editor scrolls itself. Scrolling its frame instead would hide the title and could not be undone by a wheel.
      await expect
        .poll(() => pane.locator('.cm-scroller').evaluate((element) => element.scrollTop))
        .toBeGreaterThan(1000);
      expect(await pane.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(pane.locator('h4')).toBeInViewport();
      await expect(pane.locator('.cm-content')).toContainText(line);
    }
    await page.screenshot({ path: info.outputPath('merge-opened-at-conflict.png') });

    const scroller = ours.locator('.cm-scroller');
    const before = await scroller.evaluate((element) => element.scrollTop);
    await scroller.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(before);
    await closeWorkbench(page);
  });

  test('a conflict is resolved through to a merge commit', async ({ page }) => {
    const modal = await openWorkbench(page, 'conflict', MERGE_TAB);
    const continueMerge = modal.getByRole('button', { name: /^(Continue operation|继续操作)$/ });
    await expect(continueMerge).toBeDisabled();

    await modal.getByRole('button', { name: /^(Rebuild and auto-merge|重新生成并自动合并)$/ }).click();
    await confirm(page);
    await modal.getByRole('button', { name: /^(Use ours for change|此处采用当前侧)$/ }).click();
    const finish = modal.getByRole('button', { name: /^(Mark resolved and stage|标记解决并暂存)$/ });
    await expect(finish).toBeEnabled();
    await finish.click();
    await confirm(page);

    await expect(modal.getByText(/All files are resolved|所有文件已解决/)).toBeVisible({ timeout: 15_000 });
    await expect(continueMerge).toBeEnabled();
    await continueMerge.click();
    await confirm(page);

    await expect
      .poll(() => spawnSync('git', ['-C', conflictRoot, 'rev-parse', '-q', '--verify', 'MERGE_HEAD']).status)
      .toBe(1);
    expect(git(conflictRoot, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
    expect(read(conflictRoot, 'long.txt')).toContain('main side');
    expect(read(conflictRoot, 'long.txt')).not.toContain('<<<<<<<');
    await closeWorkbench(page);
  });

  test('a shelf takes every change by default, and gives it back', async ({ page }) => {
    write(plainRoot, 'notes.txt', 'edited notes\n');
    write(plainRoot, 'extra.txt', 'edited extra\n');
    const modal = await openWorkbench(page, 'plain', SHELF_TAB);

    await modal.getByRole('button', { name: /^(Save changes to shelf|保存更改到 Shelf)$/ }).click();
    const dialog = confirmDialog(page);
    await expect(dialog.getByRole('checkbox', { name: 'notes.txt' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'extra.txt' })).toBeChecked();
    await dialog.getByRole('textbox').fill('Both edits');
    await dialog
      .locator('.arco-checkbox')
      .filter({ hasText: /Restore selected files|保存后还原/ })
      .click();
    await confirm(page);

    const shelf = modal.getByRole('button', { name: 'Both edits' });
    await expect(shelf).toBeVisible({ timeout: 15_000 });
    expect(read(plainRoot, 'notes.txt')).toBe('original notes\n');
    expect(read(plainRoot, 'extra.txt')).toBe('original extra\n');

    await shelf.click();
    await modal.getByRole('button', { name: /^(Apply saved changes|应用保存的更改)$/ }).click();

    await expect.poll(() => read(plainRoot, 'notes.txt')).toBe('edited notes\n');
    expect(read(plainRoot, 'extra.txt')).toBe('edited extra\n');
    await expect(shelf).toBeVisible();
    git(plainRoot, 'checkout', '--', '.');
    await closeWorkbench(page);
  });

  test('a recorded version can be compared and restored', async ({ page }) => {
    const modal = await openWorkbench(page, 'plain', HISTORY_TAB);
    const entries = modal.getByRole('button', { name: 'history.txt' });
    const recorded = async (count: number) => {
      await expect(async () => {
        await modal.getByRole('button', { name: /^(Refresh|刷新)$/ }).click();
        expect(await entries.count()).toBeGreaterThanOrEqual(count);
      }).toPass({ timeout: 30_000 });
    };

    // An event keeps the file as it was after that change, so an older version needs a newer one after it.
    await recorded(1);
    const baseline = await entries.count();
    write(plainRoot, 'history.txt', 'second version\n');
    await recorded(baseline + 1);
    write(plainRoot, 'history.txt', 'third version\n');
    await recorded(baseline + 2);

    await entries.nth(1).click();
    await expect(modal.getByText('second version')).toBeVisible();
    await expect(modal.getByText('third version')).toBeVisible();

    await modal.getByRole('button', { name: /^(Restore this version|恢复此版本)$/ }).click();
    await confirm(page);

    await expect.poll(() => read(plainRoot, 'history.txt')).toBe('second version\n');
    await closeWorkbench(page);
  });

  test('forms clear after they work and never leak into each other', async ({ page }) => {
    const modal = await openWorkbench(page, 'plain', OPERATIONS_TAB);
    const refresh = modal.getByRole('button', { name: /^(Refresh|刷新)$/ });
    await expect(refresh).toBeEnabled();
    const branchName = modal.getByRole('textbox', { name: /^(New name|新名称)$/ });

    await branchName.fill('feature/from-panel');
    await modal.getByRole('button', { name: /^(Create branch|创建分支)$/ }).click();

    await expect.poll(() => git(plainRoot, 'branch', '--list', 'feature/from-panel')).toContain('feature/from-panel');
    await expect(branchName).toHaveValue('');

    await branchName.fill('half typed');
    await modal.getByRole('tab', { name: /^(Remotes|远程仓库)$/ }).click();
    await expect(modal.getByRole('textbox', { name: /^(New name|新名称)$/ }).last()).toHaveValue('');
    await closeWorkbench(page);
  });

  test('a damaged changelist file does not take the changes panel down', async ({ page, electronApp }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
    write(plainRoot, 'notes.txt', 'edited again\n');
    await chooseRepo(page, 'plain');
    const storage = path.join(userData, 'git-storage', 'git-workbench');
    const newList = panel(page).getByRole('button', { name: /^(New changelist|新建变更列表)$/ });
    await expect(newList).toBeVisible({ timeout: 15_000 });

    const stores = fs
      .readdirSync(storage)
      .filter((name) => fs.existsSync(path.join(storage, name, 'changelists.json')));
    expect(stores.length).toBeGreaterThan(0);
    for (const store of stores) fs.writeFileSync(path.join(storage, store, 'changelists.json'), '{not json');

    // Lists resync when the set of changed files moves.
    write(plainRoot, 'extra.txt', 'edited too\n');
    await panel(page)
      .getByRole('button', { name: /^(Refresh changes|刷新变更)$/ })
      .click();

    await expect
      .poll(() =>
        stores.some((store) =>
          fs.readdirSync(path.join(storage, store)).some((name) => name.startsWith('changelists.damaged-'))
        )
      )
      .toBe(true);
    await expect(newList).toBeEnabled();
    await expect(panel(page).locator('[data-scm-resource]').filter({ hasText: 'notes.txt' })).toBeVisible();
  });
});
