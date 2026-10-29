import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, expect } from '../../fixtures';
import type { ProjectDetailDto } from '../../../../packages/desktop/src/common/types/project';
import {
  createLiveChat,
  importLiveProvider,
  liveRequest,
  liveTools,
  liveTurn,
  openLiveChat,
  waitLiveIdle,
  type LiveChat,
  type LiveModel,
} from '../conversations/aionrs/workspaceLive';

test.describe.serial('Natural-language code changes through to Git review', () => {
  test.skip(process.env.E2E_LIVE_WORKSPACE !== '1', 'Requires an explicitly enabled real provider');
  test.setTimeout(240_000);
  let model: LiveModel;
  let chat: LiveChat;
  let appRoot: string;
  let libRoot: string;
  let checkScript: string;
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  const scope =
    '这是已授权的集成测试，只能操作当前工作区里的样例文件。不要访问用户目录或凭据，不调用 MCP、不委派任务、不提交 Git。';
  const config = (root: string): { pageSize: number; externalKeep?: string } =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-p', `JSON.stringify(require(${JSON.stringify(path.join(root, 'config.cjs'))}))`],
        { encoding: 'utf8', windowsHide: true }
      )
    );

  test.beforeAll(async ({ page }) => {
    model = await importLiveProvider(page);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-natural-git-'));
    appRoot = path.join(base, 'application');
    libRoot = path.join(base, 'library');
    checkScript =
      'const assert = require("node:assert/strict");\nconst app = require("./config.cjs");\nconst lib = require("../library/config.cjs");\nassert.equal(app.pageSize, lib.pageSize);\nassert.ok(app.pageSize > 0);\nconsole.log("PAGINATION_CHECK_OK " + app.pageSize);\n';
    for (const root of [appRoot, libRoot]) {
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'config.cjs'), 'module.exports = { pageSize: 20 };\n');
      fs.writeFileSync(path.join(root, 'README.md'), 'Keep this documentation unchanged.\n');
      if (root === appRoot) fs.writeFileSync(path.join(root, 'check.cjs'), checkScript);
      git(root, 'init', '-q');
      git(root, 'config', 'core.autocrlf', 'false');
      git(root, 'add', '.');
      git(
        root,
        '-c',
        'user.name=Scenario Test',
        '-c',
        'user.email=scenario@example.invalid',
        'commit',
        '-qm',
        'Baseline'
      );
    }
    let workspace = await liveRequest<ProjectDetailDto>(page, 'POST', '/api/projects/workspaces', {
      name: '真实模型日常修改',
      uri: pathToFileURL(appRoot).href,
    });
    workspace = await liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
      name: workspace.name,
      roots: [
        { pe_id: workspace.explorer.entries[0].pe_id, uri: pathToFileURL(appRoot).href, display_name: 'application' },
        { uri: pathToFileURL(libRoot).href, display_name: 'library' },
      ],
      default_pe_id: workspace.explorer.entries[0].pe_id,
    });
    await liveRequest(page, 'POST', `/api/projects/${workspace.project_id}/workspace/save`, {
      path: path.join(base, 'model.woody-workspace'),
    });
    chat = await createLiveChat(page, workspace.project_id, model, '修改分页并查看 Git');
    await openLiveChat(page, chat);
  });

  test.afterAll(async ({ page }) => {
    if (chat) {
      const state = await liveRequest<LiveChat>(page, 'GET', `/api/conversations/${chat.id}`).catch(() => null);
      if (state?.runtime?.turn_id && state.runtime.is_processing) {
        await liveRequest(page, 'POST', `/api/conversations/${chat.id}/cancel`, { turn_id: state.runtime.turn_id });
        await waitLiveIdle(page, chat.id, 30_000);
      }
    }
    if (model) {
      try {
        await liveRequest(page, 'DELETE', `/api/providers/${model.provider_id}`);
      } finally {
        await model.transport.close();
      }
    }
  });

  test('ordinary Chinese request edits both repositories, runs the check and exposes real Git changes', async ({
    page,
  }, info) => {
    const messages = await liveTurn(
      page,
      chat,
      scope +
        '请把 application 和 library 两个项目 config.cjs 中的默认分页数量都从20改成50。保留README和检查脚本不变，修改后运行 application 里的 check.cjs 验证，再告诉我改了哪些文件。',
      info,
      'natural-pagination'
    );
    expect(config(appRoot).pageSize).toBe(50);
    expect(config(libRoot).pageSize).toBe(50);
    expect(
      liveTools(messages).some((tool) => tool.status === 'completed' && tool.output?.includes('PAGINATION_CHECK_OK 50'))
    ).toBe(true);
    const panel = page.locator('[data-project-panel-host]');
    await panel.getByRole('button', { name: /^(Changes|变更)$/ }).click();
    for (const [repo, root] of [
      ['application', appRoot],
      ['library', libRoot],
    ]) {
      expect(git(root, 'diff', '--name-only').trim()).toBe('config.cjs');
      await panel.locator('[data-scm-repo-item]').filter({ hasText: repo }).click();
      await panel.getByRole('button', { name: /^(Refresh changes|刷新变更)$/ }).click();
      await panel.locator('[data-scm-resource][title="config.cjs"]').click();
      await expect(page.locator('.d2h-file-wrapper:visible')).toContainText('50');
    }
    await page.screenshot({ path: info.outputPath('model-to-git.png') });
  });

  test('follow-up after a manual edit preserves that edit while changing both roots again', async ({ page }, info) => {
    fs.writeFileSync(
      path.join(appRoot, 'config.cjs'),
      'module.exports = { pageSize: 50, externalKeep: "用户刚加的设置" };\n'
    );
    const messages = await liveTurn(
      page,
      chat,
      scope +
        '分页50还是太多，请把两个项目都改成30。我刚在 application 的 config.cjs 加了 externalKeep 字段，请保留我的改动。不要修改README和检查脚本，改完再次运行检查。',
      info,
      'followup-preserve-manual-edit'
    );
    expect(
      liveTools(messages).some((tool) => tool.status === 'completed' && tool.output?.includes('PAGINATION_CHECK_OK 30'))
    ).toBe(true);
    expect(config(appRoot)).toEqual({ pageSize: 30, externalKeep: '用户刚加的设置' });
    expect(config(libRoot).pageSize).toBe(30);
    expect(fs.readFileSync(path.join(appRoot, 'check.cjs'), 'utf8')).toBe(checkScript);
    for (const root of [appRoot, libRoot]) {
      expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('Keep this documentation unchanged.\n');
      expect(git(root, 'diff', '--cached')).toBe('');
      expect(git(root, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    }
    expect(
      execFileSync(process.execPath, [path.join(appRoot, 'check.cjs')], { encoding: 'utf8', windowsHide: true })
    ).toContain('PAGINATION_CHECK_OK 30');
    const panel = page.locator('[data-project-panel-host]');
    await panel.getByRole('button', { name: /^(Changes|变更)$/ }).click();
    for (const repo of ['library', 'application']) {
      await panel.locator('[data-scm-repo-item]').filter({ hasText: repo }).click();
      await panel.getByRole('button', { name: /^(Refresh changes|刷新变更)$/ }).click();
      await panel.locator('[data-scm-resource][title="config.cjs"]').click();
      await page.getByTestId('preview-refresh').click();
      await expect(page.locator('.d2h-file-wrapper:visible')).toContainText('30');
    }
    await expect(page.locator('.d2h-file-wrapper:visible')).toContainText('externalKeep');
    await page.screenshot({ path: info.outputPath('manual-edit-preserved.png') });
  });
});
