import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { _electron as electron, type Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { httpGet, httpInvoke, httpPost } from '../../helpers/httpBridge';
import type { ProjectDetailDto } from '../../../../packages/desktop/src/common/types/project';

// All Git mutations and discard confirmations operate on these synthetic repositories.
test.describe('Everyday multi-root Git workflows', () => {
  let base: string;
  let appRoot: string;
  let libRoot: string;
  let conflictRoot: string;
  let workspace: ProjectDetailDto;
  let config: string;
  const frames: string[] = [];
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const write = (root: string, file: string, text: string | Buffer) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, text);
  };
  const commit = (root: string, message: string) => {
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Scenario Test', '-c', 'user.email=scenario@example.invalid', 'commit', '-qm', message);
  };
  const panel = (page: Page) => page.locator('[data-project-panel-host]');
  const source = (page: Page) => page.locator('[data-diff-view="source"]');
  const diff = (page: Page) => page.locator('[data-diff-view="preview"]');
  const row = (page: Page, file: string, group = 'unstaged') =>
    panel(page)
      .locator(`[data-scm-group="${group}"] [data-scm-resource]`)
      .filter({ hasText: path.posix.basename(file) });
  const mode = async (page: Page, kind: 'source' | 'preview') => {
    await page.getByText(kind === 'source' ? /^(Source|原文)$/ : /^(Preview|预览)$/, { exact: true }).click();
    await expect(page.locator(`[data-diff-view="${kind}"]`)).toBeVisible();
  };
  const chooseRepo = async (page: Page, name = 'application') => {
    await panel(page)
      .getByRole('button', { name: /^(Changes|变更)$/ })
      .click();
    await panel(page).locator('[data-scm-repo-item]').filter({ hasText: name }).click();
    await panel(page)
      .getByRole('button', { name: /^(Refresh changes|刷新变更)$/ })
      .click();
    await expect(panel(page).locator('[data-scm-loading]')).toHaveCount(0);
  };
  const openFile = async (page: Page, file: string, group = 'unstaged') => {
    await row(page, file, group).click();
    await expect(
      page
        .locator('div.bg-bg-1')
        .filter({ has: page.locator(`span[title="${path.posix.basename(file)}"]`) })
        .last()
    ).toBeVisible();
    await mode(page, 'preview');
  };

  test.beforeAll(async ({ page, electronApp }) => {
    test.setTimeout(90_000);
    page.on('websocket', (socket) =>
      socket.on('framereceived', (event) => {
        const text = String(event.payload);
        if (text.includes('scm/') || text.includes('repo_id')) frames.push(text);
      })
    );
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-git-everyday-'));
    appRoot = path.join(base, '应用 application');
    libRoot = path.join(base, '公共库 library');
    conflictRoot = path.join(base, 'conflict');
    const docs = path.join(base, '文档');
    fs.mkdirSync(docs);
    for (const root of [appRoot, libRoot, conflictRoot]) {
      fs.mkdirSync(root);
      git(root, 'init', '-q', '-b', 'main');
      git(root, 'config', 'core.autocrlf', 'true');
      write(root, 'src/shared.ts', `export const origin = "${root === appRoot ? 'APP' : 'LIB'}_BASE";\n`);
      write(root, 'README.md', 'Synthetic workspace test\n');
    }
    write(appRoot, 'src/mixed.ts', 'export const level = "BASE";\n');
    write(appRoot, 'src/stage-only.ts', 'export const action = "BASE";\n');
    write(appRoot, 'src/discard.ts', 'export const retained = "BASE";\n');
    write(appRoot, 'src/old-name.ts', 'export const renamed = "RENAME_CONTENT";\n');
    write(appRoot, '中文 目录/配置 文件.ts', '\uFEFFexport const text = "原始值";\r\n');
    write(appRoot, 'assets/icon.bin', Buffer.from([0, 1, 2, 3]));
    write(appRoot, 'src/large.ts', 'export const header = "OLD";\n' + '// unchanged filler line\n'.repeat(50000));
    write(appRoot, 'src/external.ts', 'export const externallySaved = "BASE";\n');
    write(appRoot, 'src/remove-later.ts', 'export const removed = "BASE";\n');
    write(appRoot, '.gitignore', 'ignored/\n');
    write(conflictRoot, 'conflict.txt', 'base\n');
    for (const root of [appRoot, libRoot, conflictRoot]) commit(root, 'Initial fixture');
    write(appRoot, 'src/shared.ts', 'export const origin = "APP_WORKING";\n');
    write(libRoot, 'src/shared.ts', 'export const origin = "LIB_WORKING";\n');
    for (const file of ['src/mixed.ts', 'src/discard.ts']) {
      write(appRoot, file, 'export const level = "STAGED_VALUE";\n');
      git(appRoot, 'add', file);
      write(appRoot, file, 'export const level = "WORKING_VALUE";\n');
    }
    write(appRoot, 'src/stage-only.ts', 'export const action = "STAGE_ONLY";\n');
    git(appRoot, 'mv', 'src/old-name.ts', 'src/重命名 文件.ts');
    write(appRoot, '中文 目录/配置 文件.ts', '\uFEFFexport const text = "中文最新值 @用户 #配置";\r\n');
    write(appRoot, 'assets/icon.bin', Buffer.from([0, 4, 5, 6]));
    write(appRoot, 'empty.ts', '');
    write(appRoot, 'src/large.ts', 'export const header = "NEW";\n' + '// unchanged filler line\n'.repeat(50000));
    write(appRoot, 'src/external.ts', 'export const externallySaved = "FIRST_EDIT";\n');
    write(appRoot, 'src/remove-later.ts', 'export const removed = "EDITED";\n');
    write(appRoot, 'ignored/cache.ts', 'SHOULD_NOT_APPEAR\n');
    git(conflictRoot, 'checkout', '-qb', 'feature');
    write(conflictRoot, 'conflict.txt', 'feature change\n');
    commit(conflictRoot, 'Feature');
    git(conflictRoot, 'checkout', '-q', 'main');
    write(conflictRoot, 'conflict.txt', 'main change\n');
    commit(conflictRoot, 'Main');
    expect(spawnSync('git', ['-C', conflictRoot, 'merge', 'feature'], { windowsHide: true }).status).toBe(1);
    workspace = await httpPost(page, '/api/projects/workspaces', {
      name: '日常 Git 场景',
      uri: pathToFileURL(appRoot).href,
    });
    workspace = await httpInvoke(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
      name: workspace.name,
      roots: [
        { pe_id: workspace.explorer.entries[0].pe_id, uri: pathToFileURL(appRoot).href, display_name: 'application' },
        { uri: pathToFileURL(libRoot).href, display_name: 'library' },
        { uri: pathToFileURL(conflictRoot).href, display_name: 'conflict' },
        { uri: pathToFileURL(docs).href, display_name: '文档' },
      ],
      default_pe_id: workspace.explorer.entries[0].pe_id,
    });
    config = path.join(base, '实际工作.woody-workspace');
    await httpPost(page, `/api/projects/${workspace.project_id}/workspace/save`, { path: config });
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
    await expect(panel(page).locator('[data-scm-repo-item]')).toHaveCount(3, { timeout: 30_000 });
    console.log(`Synthetic repositories: ${base}`);
  });

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      await info.attach('scm-wire', {
        body: JSON.stringify(frames.slice(-50), null, 2),
        contentType: 'application/json',
      });
      fs.writeFileSync(info.outputPath('scm-wire.json'), JSON.stringify(frames.slice(-50), null, 2));
    }
  });

  test('same relative filename in two repositories never shares source or refresh results', async ({ page }, info) => {
    for (const [repo, marker] of [
      ['application', 'APP_WORKING'],
      ['library', 'LIB_WORKING'],
      ['application', 'APP_WORKING'],
    ]) {
      await chooseRepo(page, repo);
      await openFile(page, 'src/shared.ts');
      await expect(diff(page)).toContainText(marker);
      await mode(page, 'source');
      await expect(source(page)).toContainText(marker);
      await page.getByTestId('preview-refresh').click();
      await expect(source(page)).toContainText(marker);
    }
    await page.screenshot({ path: info.outputPath('same-name-isolation.png') });
  });

  test('staged and unstaged versions keep distinct comparisons but share current source', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'src/mixed.ts', 'staged');
    await expect(diff(page)).toContainText('STAGED_VALUE');
    await expect(diff(page)).not.toContainText('WORKING_VALUE');
    await mode(page, 'source');
    await expect(source(page)).toContainText('WORKING_VALUE');
    await openFile(page, 'src/mixed.ts');
    await expect(diff(page)).toContainText('STAGED_VALUE');
    await expect(diff(page)).toContainText('WORKING_VALUE');
  });

  test('stage and unstage through row actions preserve saved code and other files', async ({ page }) => {
    await chooseRepo(page);
    const before = fs.readFileSync(path.join(appRoot, 'src/stage-only.ts'), 'utf8');
    await row(page, 'src/stage-only.ts').hover();
    await row(page, 'src/stage-only.ts').locator('[data-scm-action="stage"]').click();
    await expect(row(page, 'src/stage-only.ts', 'staged')).toBeVisible();
    expect(git(appRoot, 'show', ':src/stage-only.ts')).toBe(before);
    await row(page, 'src/stage-only.ts', 'staged').hover();
    await row(page, 'src/stage-only.ts', 'staged').locator('[data-scm-action="unstage"]').click();
    await expect(row(page, 'src/stage-only.ts')).toBeVisible();
    expect(fs.readFileSync(path.join(appRoot, 'src/stage-only.ts'), 'utf8')).toBe(before);
    expect(git(appRoot, 'show', ':src/mixed.ts')).toContain('STAGED_VALUE');
  });

  test('cancel discard preserves edits; confirming discards only unstaged changes', async ({ page }) => {
    await chooseRepo(page);
    const discard = async () => {
      await row(page, 'src/discard.ts').hover();
      await row(page, 'src/discard.ts').locator('[data-scm-action="discard"]').click();
    };
    await discard();
    await page
      .locator('.arco-modal:visible')
      .getByRole('button', { name: /^(Cancel|取消)$/ })
      .click();
    expect(fs.readFileSync(path.join(appRoot, 'src/discard.ts'), 'utf8')).toContain('WORKING_VALUE');
    await discard();
    await page
      .locator('.arco-modal:visible')
      .getByRole('button', { name: /^(Discard|丢弃)$/ })
      .click();
    await expect(row(page, 'src/discard.ts')).toHaveCount(0);
    expect(fs.readFileSync(path.join(appRoot, 'src/discard.ts'), 'utf8').replaceAll('\r\n', '\n')).toBe(
      git(appRoot, 'show', ':src/discard.ts')
    );
    expect(git(appRoot, 'diff', '--cached', '--', 'src/discard.ts')).toContain('STAGED_VALUE');
  });

  test('staged rename with Chinese and spaces opens the destination file', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'src/重命名 文件.ts', 'staged');
    await expect(row(page, 'src/重命名 文件.ts', 'staged')).toHaveAttribute('data-scm-state', 'renamed');
    await mode(page, 'source');
    await expect(source(page)).toContainText('RENAME_CONTENT');
    expect(fs.existsSync(path.join(appRoot, 'src/old-name.ts'))).toBe(false);
  });

  test('UTF-8 BOM, CRLF, Chinese paths and literal at-signs survive preview', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, '中文 目录/配置 文件.ts');
    await mode(page, 'source');
    await expect(source(page)).toContainText('中文最新值 @用户 #配置');
    expect(fs.readFileSync(path.join(appRoot, '中文 目录/配置 文件.ts'), 'utf8')).toBe(
      '\uFEFFexport const text = "中文最新值 @用户 #配置";\r\n'
    );
  });

  test('binary changes show a notice and never pretend to be source text', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'assets/icon.bin');
    await mode(page, 'source');
    await expect(source(page).getByRole('status')).toBeVisible();
    await expect(source(page)).not.toContainText('diff --git');
  });

  test('an empty new file has empty source without a load error', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'empty.ts');
    await mode(page, 'source');
    await expect(source(page).locator('code')).toBeVisible();
    await expect(source(page).getByRole('status')).toHaveCount(0);
    expect(fs.statSync(path.join(appRoot, 'empty.ts')).size).toBe(0);
  });

  test('oversized Git comparisons are explained instead of being reported as no changes', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'src/large.ts');
    await expect(diff(page)).toContainText(/文件过大|File too large/);
    await mode(page, 'source');
    await expect(source(page)).toContainText(/文件过大|File too large/);
    await mode(page, 'preview');
    await expect(diff(page)).toContainText(/文件过大|File too large/);
    await page.getByTestId('preview-refresh').click();
    await expect(diff(page)).toContainText(/文件过大|File too large/);
  });

  test('external editor saves flag an open file and refresh updates both views', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'src/external.ts');
    await mode(page, 'source');
    await expect(source(page)).toContainText('FIRST_EDIT');
    write(appRoot, 'src/external.ts', 'export const externallySaved = "EXTERNAL_SECOND_EDIT";\n');
    await expect(page.getByTestId('preview-refresh')).toHaveAttribute('data-refresh-state', 'updated');
    await page.getByTestId('preview-refresh').click();
    await expect(source(page)).toContainText('EXTERNAL_SECOND_EDIT');
    await mode(page, 'preview');
    await expect(diff(page)).toContainText('EXTERNAL_SECOND_EDIT');
  });

  test('deleting an already-open file reports unavailable source and keeps its deletion diff', async ({ page }) => {
    await chooseRepo(page);
    await openFile(page, 'src/remove-later.ts');
    await mode(page, 'source');
    await expect(source(page)).toContainText('EDITED');
    fs.unlinkSync(path.join(appRoot, 'src/remove-later.ts'));
    await page.getByTestId('preview-refresh').click();
    await expect(source(page)).toContainText(/无法重新加载|Unable to reload|could not|cannot/i);
    await mode(page, 'preview');
    await expect(diff(page)).toContainText('BASE');
  });

  test('ignored files and a non-Git workspace root do not appear as Git changes', async ({ page }) => {
    await chooseRepo(page);
    await expect(panel(page).locator('[data-scm-repo-item]')).toHaveCount(3);
    await expect(panel(page).locator('[data-scm-resource]').filter({ hasText: 'cache.ts' })).toHaveCount(0);
    expect(
      (await httpGet<ProjectDetailDto>(page, `/api/projects/${workspace.project_id}`)).explorer.entries
    ).toHaveLength(4);
  });

  test('real merge conflicts display conflict markers and block unsafe row actions', async ({ page }, info) => {
    await chooseRepo(page, 'conflict');
    const conflict = row(page, 'conflict.txt', 'blocked');
    await expect(conflict).toHaveAttribute('data-scm-state', 'conflicted');
    await expect(conflict.locator('[data-scm-action]')).toHaveCount(0);
    await openFile(page, 'conflict.txt', 'blocked');
    await mode(page, 'source');
    await expect(source(page)).toContainText('<<<<<<< HEAD');
    await expect(source(page)).toContainText('feature change');
    await page.screenshot({ path: info.outputPath('merge-conflict.png') });
  });

  test('rapid file changes leave the last chosen file in the preview', async ({ page }) => {
    await chooseRepo(page);
    for (let i = 0; i < 4; i++) {
      await row(page, 'src/shared.ts').click();
      await row(page, 'src/stage-only.ts').click();
    }
    await expect(diff(page)).toContainText('STAGE_ONLY');
    await mode(page, 'source');
    await expect(source(page)).toContainText('STAGE_ONLY');
    await expect(source(page)).not.toContainText('APP_WORKING');
  });

  test('list/tree preference and selected repository survive switching panels and reload', async ({ page }) => {
    await chooseRepo(page, 'library');
    const toggle = panel(page).locator('[data-scm-view-toggle]');
    if ((await toggle.getAttribute('data-scm-view-toggle')) === 'tree') await toggle.click();
    await expect(toggle).toHaveAttribute('data-scm-view-toggle', 'list');
    await panel(page)
      .getByRole('button', { name: /^(Files|文件)$/ })
      .click();
    await panel(page)
      .getByRole('button', { name: /^(Changes|变更)$/ })
      .click();
    await expect(toggle).toHaveAttribute('data-scm-view-toggle', 'list');
    await page.reload();
    await panel(page).waitFor();
    await panel(page)
      .getByRole('button', { name: /^(Changes|变更)$/ })
      .click();
    await expect(toggle).toHaveAttribute('data-scm-view-toggle', 'list');
    await openFile(page, 'src/shared.ts');
    await mode(page, 'source');
    await expect(source(page)).toContainText('LIB_WORKING');
    await toggle.click();
  });

  test('removing a root and discarding workspace edits preserves saved code', async ({ page }) => {
    await page
      .getByRole('button', { name: /^(Workspaces|工作区管理)$/ })
      .first()
      .click();
    const modal = page.locator('.arco-modal:visible');
    write(appRoot, 'saved-code.txt', 'Code saved while changing workspace folders\n');
    await modal
      .getByRole('button', { name: /^(Remove from project|从项目移除)$/ })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (await httpGet<ProjectDetailDto>(page, `/api/projects/${workspace.project_id}`)).explorer.entries.length
      )
      .toBe(3);
    await modal.getByRole('button', { name: /^(Discard changes|放弃更改)$/ }).click();
    await expect
      .poll(
        async () =>
          (await httpGet<ProjectDetailDto>(page, `/api/projects/${workspace.project_id}`)).explorer.entries.length
      )
      .toBe(4);
    expect(fs.readFileSync(path.join(appRoot, 'saved-code.txt'), 'utf8')).toContain('Code saved');
    await page.keyboard.press('Escape');
  });

  test('saved workspace reopens through the native picker with the same identity', async ({ page, electronApp }) => {
    await page
      .getByRole('button', { name: /^(Workspaces|工作区管理)$/ })
      .first()
      .click();
    await electronApp.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, config);
    await page
      .locator('.arco-modal:visible')
      .getByRole('button', { name: /^(Open workspace|打开工作区)$/ })
      .click();
    await expect(page.locator('.arco-modal:visible')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('woody.selectedWorkspace'))).toBe(workspace.project_id);
    expect(
      (await httpGet<ProjectDetailDto>(page, `/api/projects/${workspace.project_id}`)).explorer.entries
    ).toHaveLength(4);
  });

  test('full desktop restart restores saved roots and reads current disk content', async ({
    page,
    electronApp,
  }, info) => {
    test.setTimeout(120_000);
    await chooseRepo(page, 'library');
    await openFile(page, 'src/shared.ts');
    await mode(page, 'source');
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'));
    await electronApp.close();
    write(libRoot, 'src/shared.ts', 'export const origin = "LIB_AFTER_RESTART";\n');
    const restarted = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      timeout: 90_000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        AIONUI_E2E_TEST: '1',
        AIONUI_E2E_USER_DATA_DIR: userData,
        AIONUI_DISABLE_AUTO_UPDATE: '1',
        AIONUI_DISABLE_DEVTOOLS: '1',
        AIONUI_CDP_PORT: '0',
      },
    });
    try {
      const reopened = await restarted.firstWindow();
      await panel(reopened).waitFor({ timeout: 60_000 });
      expect(
        (await httpGet<ProjectDetailDto>(reopened, `/api/projects/${workspace.project_id}`)).explorer.entries
      ).toHaveLength(4);
      await chooseRepo(reopened, 'library');
      await openFile(reopened, 'src/shared.ts');
      await mode(reopened, 'source');
      await expect(source(reopened)).toContainText('LIB_AFTER_RESTART');
      await reopened.screenshot({ path: info.outputPath('after-restart.png') });
    } finally {
      await restarted.close();
    }
  });
});
