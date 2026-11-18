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

// A synthetic C project with a dispatch table and one module expert; no model call.
test('lists the modules after an index and turns one into an expert with a written card', async ({ page }, info) => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-modules-'));
  const write = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  write(
    'src/task.c',
    [
      'static const tTask secondList[] =',
      '{',
      '    TASK(SENSOR_Second),',
      '    TASK(TICK_Second),',
      '};',
      'void vMainTask(void *p)',
      '{',
      '    for (;;) { for (int i = 0; i < 2; i++) secondList[i].func(); vTaskDelay(25); }',
      '}',
      'void appInit(void)',
      '{',
      '    xTaskCreate(vMainTask, "main", 512, NULL, 3, NULL);',
      '}',
      'int main(void)',
      '{',
      '    appInit();',
      '    return 0;',
      '}',
      '',
    ].join('\n')
  );
  write(
    'src/sensor.c',
    'int sensorLevel;\nvoid SENSOR_Second(void)\n{\n    sensorLevel++;\n}\nvoid SENSOR_Read(void)\n{\n}\n'
  );
  write('src/sensor.h', 'void SENSOR_Second(void);\nvoid SENSOR_Read(void);\n');
  write('src/tick.c', 'void TICK_Second(void)\n{\n    sensorLevel = 0;\n    SENSOR_Read();\n}\n');
  write(
    '.woody/experts.json',
    JSON.stringify({
      version: 1,
      experts: [{ id: 'tick', name: 'Tick expert', summary: 'Counts ticks.', paths: ['src/tick.c'] }],
      shared: ['src/task.c'],
    })
  );
  await page.waitForFunction(() => Boolean((window as Window & { __backendPort?: number }).__backendPort));
  const workspace = await httpPost<ProjectDetailDto>(page, '/api/projects/workspaces', {
    name: 'Modules',
    uri: pathToFileURL(root).href,
  });
  await httpPost(page, `/api/projects/${workspace.project_id}/workspace/save`, {
    path: path.join(root, 'modules.woody-workspace'),
  });
  await page.evaluate((id) => {
    localStorage.setItem('woody.selectedWorkspace', id);
    location.hash = '/guid';
  }, workspace.project_id);
  await page.reload();
  const panel = page.locator('[data-project-panel-host]');
  await panel.waitFor({ timeout: 60_000 });
  await panel.getByRole('button', { name: /^(Architecture|架构)$/ }).click();
  await panel.getByRole('switch', { name: /^(Enable codebase memory|启用代码库记忆)$/ }).click();
  await panel.getByRole('button', { name: /^(Save|保存)$/ }).click();
  await expect
    .poll(() => fs.existsSync(path.join(root, '.woody', 'codebase-memory.json')), { timeout: 10_000 })
    .toBe(true);
  await panel.getByRole('button', { name: /^(Initialize \/ update index|初始化 \/ 更新索引)$/ }).click();
  await expect(panel.getByRole('status')).toHaveText(/^(Index updated|索引已更新)$/, { timeout: 90_000 });

  // The first index wrote the architecture file with its modules, and the expert's brief.
  const architecture = fs.readFileSync(path.join(root, '.woody', 'architecture.md'), 'utf8');
  expect(architecture).toMatch(/## (Modules|模块分类)/);
  const tickCard = () => fs.readFileSync(path.join(root, '.woody', 'features', 'tick.md'), 'utf8');
  expect(tickCard()).toContain('<!-- woody:generated:start -->');
  expect(tickCard()).toContain('`SENSOR_Read`');

  const modules = panel.getByTestId('codebase-modules');
  await expect(modules).toBeVisible();
  await expect(modules.getByTestId('codebase-module-experts')).toContainText('Tick expert');
  await expect(modules.getByTestId('codebase-module-experts')).toContainText(/Not learned|未熟悉/);
  await expect(modules).toContainText('src/sensor.c, src/sensor.h');
  // Arco hides the native input; the label around it takes the click.
  await modules.getByRole('checkbox', { name: 'sensor' }).locator('xpath=..').click();
  await modules.getByRole('button', { name: /^(New expert|设为新专家)$/ }).click();
  const draft = modules.getByTestId('codebase-module-draft');
  await expect(draft.locator('input').nth(1)).toHaveValue('sensor');
  await page.screenshot({ path: info.outputPath('modules-draft.png') });
  await draft.getByRole('button', { name: /^(Save|保存)$/ }).click();
  await expect(draft).toHaveCount(0, { timeout: 30_000 });
  await expect(modules.getByTestId('codebase-module-experts')).toContainText(/sensor/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.woody', 'experts.json'), 'utf8')) as {
    experts: Array<{ id: string; paths: string[] }>;
  };
  expect(saved.experts.find((expert) => expert.id === 'sensor')?.paths).toEqual(['src/sensor.c', 'src/sensor.h']);
  const sensorCard = fs.readFileSync(path.join(root, '.woody', 'features', 'sensor.md'), 'utf8');
  expect(sensorCard).toContain('`TICK_Second`');
  expect(sensorCard).toContain('`sensorLevel`');
  await page.screenshot({ path: info.outputPath('modules-saved.png') });

  const name = `woody-${createHash('sha256').update(fs.realpathSync.native(root).toLowerCase()).digest('hex')}`;
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'AionUi', 'codebase-memory', name);
  try {
    fs.rmSync(cache, { recursive: true, force: true });
  } catch {
    /* A few kilobytes are left behind until the daemon exits. */
  }
});
