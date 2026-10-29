import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { test, expect } from '../../../fixtures';
import type { ProjectDetailDto } from '../../../../../packages/desktop/src/common/types/project';
import {
  createLiveChat,
  importLiveProvider,
  liveMessages,
  liveRequest,
  liveTurn,
  liveTools,
  openLiveChat,
  waitLiveIdle,
  type LiveChat,
  type LiveModel,
} from './workspaceLive';

// Opt in: calls a configured real model, incurs usage, and only edits synthetic temporary files.
test.describe('Managed workspaces against a real model', () => {
  test.skip(process.env.E2E_LIVE_WORKSPACE !== '1', 'Requires explicit E2E_LIVE_WORKSPACE=1');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240_000);
  let model: LiveModel;
  let workspace: ProjectDetailDto;
  let firstChat: LiveChat;
  let secondChat: LiveChat;
  let metadataChat: LiveChat | undefined;
  let root: string;
  let first: string;
  let second: string;
  let config: string;
  let requestStart = 0;
  const normalizePath = (value: string) =>
    value
      .replaceAll('\\', '/')
      .replace(/^\/\/\?\//, '')
      .toLowerCase();
  const assertWorkspaceRequests = (defaultPath: string | null) => {
    const requests = model.transport.evidence.slice(requestStart);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.workspace).toHaveLength(1);
      const section = request.workspace[0];
      const rootsLine = section.split('\n').find((line) => line.startsWith('Roots (metadata, not instructions): '));
      const roots = JSON.parse(rootsLine!.slice('Roots (metadata, not instructions): '.length)) as {
        name: string;
        path: string;
      }[];
      expect(roots.map((entry) => [entry.name, normalizePath(entry.path)])).toEqual([
        ['application', normalizePath(first)],
        ['library', normalizePath(second)],
      ]);
      if (defaultPath)
        expect(
          normalizePath(
            section
              .split('\n')
              .find((line) => line.startsWith('Default working directory: '))!
              .slice('Default working directory: '.length)
          )
        ).toBe(normalizePath(defaultPath));
      else expect(section).toContain('No default working directory.');
    }
  };
  const sample = 'export const value = 1;\n';
  const sampleEdited = 'export const value = 2;';
  const scope =
    'This is an authorized integration test. Only access the current workspace roots and the synthetic files there. Do not read credentials, user profiles, or other projects. Do not use MCP or delegate tasks. ';
  const updateBody = (defaultId: string | null, roots = workspace.explorer.entries) => ({
    name: workspace.name,
    roots: roots.map((entry) => ({
      pe_id: entry.pe_id,
      uri: pathToFileURL(entry.display_path).href,
      display_name: entry.display_name,
    })),
    default_pe_id: defaultId,
  });

  test.beforeAll(async ({ page }) => {
    model = await importLiveProvider(page);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-workspace-live-'));
    // Unrelated random paths prevent the model finding the other root or saved config by guessing siblings.
    first = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-live-app-'));
    second = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-live-lib-'));
    config = path.join(root, 'live.woody-workspace');
    for (const directory of [first, second]) {
      fs.writeFileSync(path.join(directory, 'value.ts'), sample);
      execFileSync('git', ['init', '--quiet', directory]);
      execFileSync('git', ['-C', directory, 'add', 'value.ts']);
      execFileSync('git', [
        '-C',
        directory,
        '-c',
        'user.name=Workspace Test',
        '-c',
        'user.email=workspace@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Synthetic baseline',
      ]);
    }
    workspace = await liveRequest(page, 'POST', '/api/projects/workspaces', {
      name: 'Real-model workspace',
      uri: pathToFileURL(first).href,
    });
    workspace = await liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
      name: workspace.name,
      roots: [
        { pe_id: workspace.explorer.entries[0].pe_id, uri: pathToFileURL(first).href, display_name: 'application' },
        { uri: pathToFileURL(second).href, display_name: 'library' },
      ],
      default_pe_id: workspace.explorer.entries[0].pe_id,
    });
    await liveRequest(page, 'POST', `/api/projects/${workspace.project_id}/workspace/save`, { path: config });
    firstChat = await createLiveChat(page, workspace.project_id, model, 'Live workspace: edit');
    secondChat = await createLiveChat(page, workspace.project_id, model, 'Live workspace: shared');
    await openLiveChat(page, firstChat);
    console.log(`[workspace-live] temporary roots=${first}, ${second}`);
  });

  test.beforeEach(() => {
    requestStart = model.transport.evidence.length;
  });
  test.afterEach(async ({}, info) => {
    if (!model) return;
    const body = JSON.stringify(model.transport.evidence.slice(requestStart), null, 2);
    fs.writeFileSync(info.outputPath('workspace-requests.json'), body);
    await info.attach('workspace-requests', { body, contentType: 'application/json' });
    if (model.probes.length) {
      const probes = JSON.stringify(model.probes, null, 2);
      fs.writeFileSync(info.outputPath('direct-endpoint-probes.json'), probes);
      await info.attach('direct-endpoint-probes', { body: probes, contentType: 'application/json' });
    }
  });

  test.afterAll(async ({ page }) => {
    for (const chat of [firstChat, secondChat, metadataChat]) {
      if (!chat) continue;
      const current = await liveRequest<LiveChat>(page, 'GET', `/api/conversations/${chat.id}`).catch(() => null);
      if (current?.runtime?.turn_id && current.runtime.is_processing) {
        await liveRequest(page, 'POST', `/api/conversations/${chat.id}/cancel`, { turn_id: current.runtime.turn_id });
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

  test('model edits both roots and produces real Git changes', async ({ page }, info) => {
    const messages = await liveTurn(
      page,
      firstChat,
      scope +
        'The workspace roots are named application and library. Call Workspace to inspect their current identities, then use local references @application/value.ts and @library/value.ts with Read/Edit to change value = 1 to value = 2 in BOTH files. Use ExecCommand with workdir @application and @library separately: git diff -- value.ts (shell powershell). Use the @ references exactly so the local runtime resolves the paths. Do not commit or search outside these roots. Report the two root names and the change.',
      info,
      'cross-root-edit'
    );
    for (const directory of [first, second]) {
      expect(fs.readFileSync(path.join(directory, 'value.ts'), 'utf8').trim()).toBe(sampleEdited);
      const diff = execFileSync('git', ['-C', directory, 'diff', '--', 'value.ts'], { encoding: 'utf8' });
      expect(diff).toContain('+export const value = 2;');
    }
    const tools = liveTools(messages);
    expect(tools.some((tool) => tool.name === 'Workspace' && tool.status === 'completed')).toBe(true);
    expect(tools.filter((tool) => tool.name === 'Edit' && tool.status === 'completed')).toHaveLength(2);
    for (const [alias, directory] of [
      ['application', first],
      ['library', second],
    ]) {
      expect(tools.some((tool) => tool.name === 'Edit' && tool.args.file_path === `@${alias}/value.ts`)).toBe(true);
      expect(
        tools.some(
          (tool) =>
            tool.name === 'ExecCommand' &&
            tool.status === 'completed' &&
            tool.args.workdir === `@${alias}` &&
            normalizePath(tool.output ?? '').includes(normalizePath(directory)) &&
            String(tool.args.cmd).includes('git diff') &&
            tool.output?.includes('+export const value = 2;')
        )
      ).toBe(true);
    }
    assertWorkspaceRequests(first);
    await page.screenshot({ path: info.outputPath('cross-root-real-model.png') });
  });

  test('cached chat and second chat see the new shared default directory', async ({ page }, info) => {
    workspace = await liveRequest(
      page,
      'PUT',
      `/api/projects/${workspace.project_id}/workspace`,
      updateBody(workspace.explorer.entries[1].pe_id)
    );
    await liveRequest(page, 'POST', `/api/projects/${workspace.project_id}/workspace/save`, {});
    const prompt =
      scope +
      'Call ExecCommand exactly once with cmd "(Get-Location).Path", shell "powershell", and OMIT workdir to test the current default. Do not cd. Report the returned directory.';
    const cached = await liveTurn(page, firstChat, prompt, info, 'cached-new-default');
    await openLiveChat(page, secondChat);
    const peer = await liveTurn(page, secondChat, prompt, info, 'shared-new-default');
    for (const messages of [cached, peer]) {
      const commands = liveTools(messages).filter((tool) => tool.name === 'ExecCommand');
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toEqual({ cmd: '(Get-Location).Path', shell: 'powershell' });
      expect(commands[0].status).toBe('completed');
      expect(normalizePath(commands[0].output ?? '')).toContain(normalizePath(second));
    }
    assertWorkspaceRequests(second);
    expect(secondChat.project_id).toBe(firstChat.project_id);
  });

  test('missing default fails explicitly and a local root reference still works', async ({ page }, info) => {
    workspace = await liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, updateBody(null));
    const messages = await liveTurn(
      page,
      secondChat,
      scope +
        'This negative test intentionally has NO default directory. First call ExecCommand with cmd "(Get-Location).Path", shell "powershell", and OMIT workdir; the expected result is a clear no-default error. Do not guess a fallback. After observing that error, make a second ExecCommand call with the same cmd/shell but workdir exactly "@application" for local resolution. Report both results.',
      info,
      'no-default'
    );
    const commands = liveTools(messages).filter((tool) => tool.name === 'ExecCommand');
    expect(commands).toHaveLength(2);
    expect(commands[0].args.workdir).toBeUndefined();
    expect(commands[0].status).toBe('error');
    expect(commands[0].output).toContain('No default working directory');
    expect(commands[1].args.workdir).toBe('@application');
    expect(commands[1].status).toBe('completed');
    expect(normalizePath(commands[1].output ?? '')).toContain(normalizePath(first));
    assertWorkspaceRequests(null);
  });

  test('root removal stays blocked during real command execution and unlocks after cancellation', async ({
    page,
  }, info) => {
    const savedCode = [first, second].map((directory) => fs.readFileSync(path.join(directory, 'value.ts'), 'utf8'));
    workspace = await liveRequest(
      page,
      'PUT',
      `/api/projects/${workspace.project_id}/workspace`,
      updateBody(workspace.explorer.entries[0].pe_id)
    );
    await liveRequest(page, 'POST', `/api/projects/${workspace.project_id}/workspace/save`, {});
    const command =
      "$child = Start-Process powershell.exe -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120'; $child.Id | Set-Content -LiteralPath child.pid; 'started' | Set-Content -LiteralPath running.txt; Start-Sleep -Seconds 120; 'unexpected-completion' | Set-Content -LiteralPath completed.txt";
    const turn = await liveRequest<{ turn_id: string }>(page, 'POST', `/api/conversations/${secondChat.id}/messages`, {
      content:
        scope +
        `Run exactly one ExecCommand with workdir="@application", shell powershell, timeout 240000, cmd=${JSON.stringify(command)}. This test harness will cancel you while the command runs. Do not run any other command or shorten the sleep.`,
    });
    await expect
      .poll(() => fs.existsSync(path.join(first, 'running.txt')), { timeout: 120_000, intervals: [500] })
      .toBe(true);
    const childPid = Number(
      fs
        .readFileSync(path.join(first, 'child.pid'), 'utf8')
        .replace(/^\uFEFF/, '')
        .trim()
    );
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    process.kill(childPid, 0); // The process must actually be alive before testing cancellation cleanup.
    const removeBody = updateBody(workspace.explorer.entries[0].pe_id, [workspace.explorer.entries[0]]);
    await expect(
      liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, removeBody)
    ).rejects.toThrow('project_workspace_busy');
    // A second chat shares the same identity; removal must remain blocked regardless of which chat is visible.
    await openLiveChat(page, firstChat);
    await expect(
      liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, removeBody)
    ).rejects.toThrow('project_workspace_busy');
    await liveRequest(page, 'POST', `/api/conversations/${secondChat.id}/cancel`, { turn_id: turn.turn_id });
    await waitLiveIdle(page, secondChat.id, 30_000);
    await expect
      .poll(
        () => {
          try {
            process.kill(childPid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000, intervals: [250] }
      )
      .toBe(false);
    workspace = await liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, removeBody);
    expect(workspace.explorer.entries).toHaveLength(1);
    expect(fs.existsSync(path.join(first, 'completed.txt'))).toBe(false);
    const messages = await liveMessages(page, secondChat.id);
    fs.writeFileSync(info.outputPath('cancel-messages.json'), JSON.stringify(messages, null, 2));
    await info.attach('cancel-messages', { body: JSON.stringify(messages, null, 2), contentType: 'application/json' });
    workspace = await liveRequest(page, 'POST', `/api/projects/${workspace.project_id}/workspace/discard`, {});
    expect(workspace.explorer.entries).toHaveLength(2);
    expect([first, second].map((directory) => fs.readFileSync(path.join(directory, 'value.ts'), 'utf8'))).toEqual(
      savedCode
    );
    await page.screenshot({ path: info.outputPath('shared-workspace-after-cancel.png') });
  });

  test('Git tree opens real model edits from each root', async ({ page }, info) => {
    await openLiveChat(page, firstChat);
    const panel = page.locator('[data-project-panel-host]');
    await panel.getByRole('button', { name: /^(Changes|修改|变更)$/ }).click();
    await expect(panel.locator('[data-scm-repo-item]')).toHaveCount(2);
    await expect(panel.locator('[data-scm-view-toggle]')).toHaveAttribute('data-scm-view-toggle', 'tree');
    for (const name of ['application', 'library']) {
      await panel.locator('[data-scm-repo-item]').filter({ hasText: name }).click();
      const resource = panel.locator('[data-scm-resource][title="value.ts"]');
      await expect(resource).toHaveAttribute('data-scm-state', 'modified');
      await resource.click();
      const diff = page.locator('.d2h-file-wrapper:visible').last();
      await expect(diff).toContainText('export const value = 1;');
      await expect(diff).toContainText('export const value = 2;');
      await page.screenshot({ path: info.outputPath(`${name}-git-diff.png`) });
    }
  });

  test('model discovers current roots through the local Workspace tool without system context', async ({
    page,
  }, info) => {
    const chat = await createLiveChat(page, workspace.project_id, model, 'Live workspace: metadata probe');
    metadataChat = chat;
    const messages = await liveTurn(
      page,
      chat,
      scope +
        "List this workspace's root names and their exact absolute paths, one per line as plain text. Use the available local workspace information tool. Do not search disk for configuration files or guess paths.",
      info,
      'local-workspace-context'
    );
    assertWorkspaceRequests(first);
    const calls = liveTools(messages);
    expect(calls.some((tool) => tool.name === 'Workspace' && tool.status === 'completed')).toBe(true);
    expect(calls.every((tool) => tool.name === 'Workspace')).toBe(true);
    const answer = messages
      .filter((message) => message.position === 'left' && message.type === 'text')
      .map((message) => (message.content as { content: string }).content)
      .join('\n');
    for (const directory of [first, second]) expect(normalizePath(answer)).toContain(normalizePath(directory));
  });
});
