import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '../../../fixtures';
import {
  importLiveProvider,
  liveRequest,
  liveTurn,
  liveTools,
  openLiveChat,
  waitLiveIdle,
  type LiveChat,
  type LiveModel,
} from '../aionrs/workspaceLive';
import { createCase, updateCase, scope, value, answer, normalize } from './edgeHarness';

test.describe('Real model workspace boundaries', () => {
  test.skip(process.env.E2E_LIVE_WORKSPACE !== '1', 'Explicit real endpoint opt-in required');
  test.setTimeout(240_000);
  let model: LiveModel;
  let current: Awaited<ReturnType<typeof createCase>>;
  let requestStart = 0;
  test.beforeAll(async ({ page }) => {
    model = await importLiveProvider(page);
  });
  test.beforeEach(async ({ page }) => {
    requestStart = model.transport.evidence.length;
    current = await createCase(page, model);
  });
  test.afterEach(async ({ page }, info) => {
    const active = await liveRequest<LiveChat>(page, 'GET', `/api/conversations/${current.chat.id}`).catch(() => null);
    if (active?.runtime?.turn_id && active.runtime.is_processing) {
      await liveRequest(page, 'POST', `/api/conversations/${current.chat.id}/cancel`, {
        turn_id: active.runtime.turn_id,
      });
      await waitLiveIdle(page, current.chat.id, 30_000);
    }
    fs.writeFileSync(
      info.outputPath('workspace-requests.json'),
      JSON.stringify(model.transport.evidence.slice(requestStart), null, 2)
    );
  });
  test.afterAll(async ({ page }) => {
    if (model) {
      try {
        await liveRequest(page, 'DELETE', `/api/providers/${model.provider_id}`);
      } finally {
        await model.transport.close();
      }
    }
  });

  test('natural language finds the nondefault root without tool or path hints', async ({ page }, info) => {
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        '请把 library 目录里的 value.ts 中 value 从 1 改成 9，application 目录里的同名文件保持原样。请实际修改文件。',
      info,
      'natural-edit'
    );
    expect(fs.readFileSync(path.join(current.directories[1], 'value.ts'), 'utf8').trim()).toBe(
      'export const value = 9;'
    );
    expect(fs.readFileSync(path.join(current.directories[0], 'value.ts'), 'utf8')).toBe(value);
    // Natural requests may use valid system metadata or local discovery; assert the actual target above.
    expect(liveTools(messages).some((tool) => tool.name === 'Edit' && tool.status === 'completed')).toBe(true);
  });

  test('Unicode spaced alias preserves literal file content and command text', async ({ page }, info) => {
    current.workspace = await updateCase(
      page,
      current.workspace,
      current.workspace.explorer.entries.map((root, index) => ({
        ...root,
        display_name: index === 1 ? '公共 library' : 'application',
      })),
      null
    );
    const literal = 'const alias = "@application/value.ts";\n';
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        `调用 Write，file_path 必须是 "@{公共 library}/literal.ts"，content 必须是 ${JSON.stringify(literal)}。然后用 Read 读取该引用确认原文。再调用 ExecCommand，workdir="@{公共 library}"，shell="powershell"，cmd="Write-Output '@application/value.ts'"。不得把文件内容或命令正文中的引用改成绝对路径。`,
      info,
      'unicode-literals'
    );
    expect(fs.readFileSync(path.join(current.directories[1], 'literal.ts'), 'utf8')).toBe(literal);
    const command = liveTools(messages).find((tool) => tool.name === 'ExecCommand');
    expect(command?.status).toBe('completed');
    expect(command?.output).toContain('@application/value.ts');
  });

  test('duplicate aliases are rejected and explicit root identity selects only one file', async ({ page }, info) => {
    current.workspace = await updateCase(
      page,
      current.workspace,
      current.workspace.explorer.entries.map((root) => ({ ...root, display_name: 'library' })),
      null
    );
    const rejected = await liveTurn(
      page,
      current.chat,
      scope +
        '这是错误处理测试。请调用一次 Read，file_path="@library/value.ts"。收到错误后停止，不要改用别的路径，不要写文件。',
      info,
      'duplicate-error'
    );
    expect(
      liveTools(rejected).some(
        (tool) => tool.name === 'Read' && tool.status === 'error' && tool.output?.includes('ambiguous')
      )
    ).toBe(true);
    const id = current.workspace.explorer.entries[1].pe_id;
    await liveTurn(
      page,
      current.chat,
      scope + `我选择根目录 ID ${id}。请用 @{${id}}/value.ts 读取后把 value 从 1 改成 4，不修改其他目录。`,
      info,
      'duplicate-id'
    );
    expect(
      current.directories.map((directory) => fs.readFileSync(path.join(directory, 'value.ts'), 'utf8').trim())
    ).toEqual(['export const value = 1;', 'export const value = 4;']);
  });

  test('natural ambiguous request asks for clarification without modifying either file', async ({ page }, info) => {
    current.workspace = await updateCase(
      page,
      current.workspace,
      current.workspace.explorer.entries.map((root) => ({ ...root, display_name: 'library' })),
      null
    );
    const messages = await liveTurn(
      page,
      current.chat,
      scope + '请把 library 中的 value.ts 改成 value = 8。',
      info,
      'natural-ambiguous'
    );
    expect(current.directories.map((directory) => fs.readFileSync(path.join(directory, 'value.ts'), 'utf8'))).toEqual([
      value,
      value,
    ]);
    expect(answer(messages)).toMatch(/哪个|哪一个|选择|确认|明确|重名|同名|which|ambiguous/i);
    expect(liveTools(messages).filter((tool) => ['Write', 'Edit', 'ExecCommand'].includes(tool.name))).toHaveLength(0);
  });

  test('cached chat follows root relocation and rename using stable identity', async ({ page }, info) => {
    const id = current.workspace.explorer.entries[1].pe_id;
    await liveTurn(
      page,
      current.chat,
      scope + `使用 Read 读取 @{${id}}/value.ts，记下内容，不写文件。`,
      info,
      'before-relocation'
    );
    const replacement = path.join(current.base, '新位置 library');
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, 'value.ts'), 'export const value = 20;\n');
    current.workspace = await updateCase(
      page,
      current.workspace,
      current.workspace.explorer.entries.map((root) =>
        root.pe_id === id ? { ...root, display_name: '新 library', display_path: replacement } : root
      )
    );
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        `现在目录配置已更新，请重新读取 @{${id}}/value.ts，把当前 value 加 1。使用这个引用定位，不能使用上次缓存的绝对路径。`,
      info,
      'after-relocation'
    );
    expect(fs.readFileSync(path.join(replacement, 'value.ts'), 'utf8').trim()).toBe('export const value = 21;');
    expect(fs.readFileSync(path.join(current.directories[1], 'value.ts'), 'utf8')).toBe(value);
    expect(liveTools(messages).some((tool) => tool.name === 'Read' && tool.output?.includes('20'))).toBe(true);
  });

  test('removed root rejects stale references in an existing chat', async ({ page }, info) => {
    await liveTurn(page, current.chat, scope + '读取 @library/value.ts，不写文件。', info, 'before-removal');
    current.workspace = await updateCase(page, current.workspace, [current.workspace.explorer.entries[0]]);
    const messages = await liveTurn(
      page,
      current.chat,
      scope + '这是旧引用测试。调用一次 Read，file_path="@library/value.ts"。收到错误后停止，不搜索或使用旧绝对路径。',
      info,
      'after-removal'
    );
    expect(
      liveTools(messages).some(
        (tool) => tool.name === 'Read' && tool.status === 'error' && tool.output?.includes('Unknown')
      )
    ).toBe(true);
    expect(fs.readFileSync(path.join(current.directories[1], 'value.ts'), 'utf8')).toBe(value);
  });

  test('unavailable default directory fails and explicit other root remains usable', async ({ page }, info) => {
    // Point the first root at a missing path without moving or deleting any files.
    current.workspace = await updateCase(
      page,
      current.workspace,
      current.workspace.explorer.entries.map((root, index) =>
        index === 0 ? { ...root, display_path: path.join(current.base, 'missing') } : root
      )
    );
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        '先用 ExecCommand 执行 (Get-Location).Path，shell=powershell，省略 workdir。预期默认目录不可用，应返回错误。再用相同命令、workdir="@library" 执行一次。不要猜测其他目录。',
      info,
      'missing-default-root'
    );
    const commands = liveTools(messages).filter((tool) => tool.name === 'ExecCommand');
    expect(commands).toHaveLength(2);
    expect(commands[0].status).toBe('error');
    expect(commands[1].status).toBe('completed');
    expect(normalize(commands[1].output ?? '')).toContain(normalize(current.directories[1]));
  });

  test('traversal reference produces error without changing an outside file', async ({ page }, info) => {
    const outside = path.join(current.base, 'outside.txt');
    fs.writeFileSync(outside, 'unchanged');
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        '这是引用校验测试。调用一次 Write，file_path="@library/../outside.txt"，content="must be rejected"。程序应拒绝这个引用；收到错误后停止，不重试其他路径。',
      info,
      'traversal'
    );
    expect(
      liveTools(messages).some(
        (tool) => tool.name === 'Write' && tool.status === 'error' && tool.output?.includes('outside')
      )
    ).toBe(true);
    expect(fs.readFileSync(outside, 'utf8')).toBe('unchanged');
  });

  test('read after an edit returns the updated code instead of referring to stale content', async ({ page }, info) => {
    const messages = await liveTurn(
      page,
      current.chat,
      scope +
        '请依次调用 Read 读取 @library/value.ts，Edit 把 value 从 1 改成 6，再调用 Read 读取同一个引用。必须通过最后一次 Read 核对改后的内容，不调用其他工具。',
      info,
      'read-after-edit'
    );
    const calls = liveTools(messages);
    const reads = calls.filter((tool) => tool.name === 'Read');
    expect(reads).toHaveLength(2);
    expect(reads[1].output).toContain('value = 6;');
    expect(fs.readFileSync(path.join(current.directories[1], 'value.ts'), 'utf8').trim()).toBe(
      'export const value = 6;'
    );
  });

  test('desktop search scope and removal update the visible roots', async ({ page }, info) => {
    await openLiveChat(page, current.chat);
    const panel = page.locator('[data-project-panel-host]');
    await panel.getByRole('button', { name: /^(Files|文件)$/ }).click();
    const search = panel.getByRole('textbox', { name: /Search files by name|按文件名搜索/ });
    await search.fill('value.ts');
    const hits = panel.locator('[role="button"][title="value.ts"]');
    await expect(hits).toHaveCount(2);
    // Arco may put aria-label on the outer select itself.
    const selector = panel.locator('[aria-label="Search scope"], [aria-label="搜索范围"]').first();
    await selector.click();
    await page
      .locator('.arco-select-option')
      .filter({ hasText: /^library$/ })
      .click();
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('library');
    await page
      .getByRole('button', { name: /^(Workspaces|工作区管理)$/ })
      .first()
      .click();
    const modal = page.locator('.arco-modal:visible');
    await modal
      .getByRole('button', { name: /^(Remove from project|从项目移除)$/ })
      .nth(1)
      .click();
    await expect
      .poll(
        async () =>
          (await liveRequest<typeof current.workspace>(page, 'GET', `/api/projects/${current.workspace.project_id}`))
            .explorer.entries.length
      )
      .toBe(1);
    await modal.locator('.arco-modal-close-icon').click();
    await expect(hits).toHaveCount(1);
    await expect(hits.first()).toContainText('application');
    await expect(panel).not.toContainText('library');
    expect(fs.readFileSync(path.join(current.directories[1], 'value.ts'), 'utf8')).toBe(value);
    await page.screenshot({ path: info.outputPath('search-after-removal.png') });
    // Save the visible test workspace so the fixture can close without the intentional unsaved-config prompt.
    await liveRequest(page, 'POST', `/api/projects/${current.workspace.project_id}/workspace/save`, {
      path: path.join(current.base, 'search.woody-workspace'),
    });
  });
});
