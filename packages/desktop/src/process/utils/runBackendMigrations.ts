/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { migrateConfigStorage, migrateLegacyMcpConfigToDb, migrateProviders } from '@/common/config/configMigration';
import { httpRequest } from '@/common/adapter/httpBridge';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { ImageGenerationModelSetting } from '@/common/config/clientSettings';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import {
  removeImageGenerationEnvKeys,
  resolveImageGenerationMcpEnv,
  type ImageGenerationMcpEnvResolveResult,
} from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import { getBuiltinMcpScriptPath, type ProcessConfig as ProcessConfigType } from './initStorage';
import { migrateAssistantsToBackend } from './migrateAssistants';
import { TODO_SCAN_JOB_NAME } from '@process/bridge/todoBridge';
import { CODEBASE_MEMORY_MCP_NAME } from '@/common/types/codebaseMemory/constants';

type ConfigFile = typeof ProcessConfigType;
type MigrationStepResult = boolean;
type McpImportServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;
type BackendClientPreferences = Record<string, unknown>;
const BUILTIN_CHROME_DEVTOOLS_NAME = 'chrome-devtools';

/**
 * 待办 MCP 条目名。注册为 enabled 且非 builtin:按 aioncore 的会话快照规则,
 * 这类条目自动挂进所有新建会话(用户无需在 MCP 选择器里勾选),定时扫描
 * 拉起的会话同样带上——这是 agent 能读写待办、扫描任务能写库的前提。
 *
 * Todo MCP row name. Registered enabled + non-builtin so aioncore's session
 * snapshot auto-attaches it to every new conversation (no manual MCP picker
 * selection), including conversations spawned by the scheduled scan job.
 */
const TODO_MCP_NAME = 'aionui-todo';

/**
 * 内置「应用内浏览器」MCP。
 *
 * 与 chrome-devtools 的区别：那个默认关闭，开启后会由 MCP 自己开一个独立 Chrome
 * 窗口 —— 用户在 APP 里看不见。这个默认开启，且强制连到 APP 自己的 CDP 端口，
 * Agent 的每一步操作都发生在用户能看到的侧边预览面板里。
 *
 * The built-in in-app browser MCP. Unlike `chrome-devtools` (default-disabled and
 * spawning its own separate Chrome window the user cannot see), this one is
 * enabled by default and pinned to the app's own CDP port, so every agent action
 * happens in the side preview panel where the user can watch it.
 */
const BUILTIN_BROWSER_SCRIPT = 'builtin-mcp-browser';

const LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS = [
  'assistants',
  'migration.assistantEnabledFixed',
  'migration.coworkDefaultSkillsAdded',
  'migration.builtinDefaultSkillsAdded_v2',
  'migration.promptsI18nAdded',
  'migration.assistantsSplitCustom',
] as const;

async function cleanupLegacyClientPreferences(): Promise<void> {
  const payloadEntries = LEGACY_BACKEND_CLIENT_PREFERENCE_KEYS.map((key): [string, null] => [key, null]);
  const payload = Object.fromEntries(payloadEntries);
  await httpRequest<void>('PUT', '/api/settings/client', payload);
}

const CLEANUP_STEPS: Array<{
  name: string;
  run: () => Promise<void>;
}> = [{ name: 'cleanupLegacyClientPreferences', run: async () => cleanupLegacyClientPreferences() }];

async function fetchBackendClientPreferences(): Promise<BackendClientPreferences> {
  try {
    return (await httpRequest<BackendClientPreferences>('GET', '/api/settings/client')) || {};
  } catch {
    return {};
  }
}

async function fetchProviders(): Promise<IProvider[]> {
  try {
    return (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
  } catch (error) {
    console.warn('[Migration] MCP bootstrap could not load providers for image generation env resolution', error);
    return [];
  }
}

export function resolveImageGenerationMigrationConfig(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): ImageGenerationModelSetting | undefined {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return backendConfig as ImageGenerationModelSetting;
  }
  return fileConfig;
}

function resolveImageGenerationMigrationConfigSource(
  backendPrefs: BackendClientPreferences,
  fileConfig?: ImageGenerationModelSetting
): 'backend' | 'file' | 'none' {
  const backendConfig = backendPrefs['tools.imageGenerationModel'];
  if (backendConfig && typeof backendConfig === 'object') {
    return 'backend';
  }
  return fileConfig ? 'file' : 'none';
}

function logImageGenerationEnvResolution(
  result: ImageGenerationMcpEnvResolveResult,
  context: 'bootstrap' | 'update'
): void {
  if (result.ok === true) {
    console.info(
      '[Migration] image MCP env resolved via %s during %s, provider id: %s, platform: %s, model: %s, api key present: %s',
      result.source,
      context,
      result.provider.id,
      result.provider.platform,
      result.model,
      result.provider.api_key ? 'yes' : 'no'
    );
    return;
  }

  console.warn(
    '[Migration] image MCP env resolution failed during %s, reason: %s, message: %s, candidates: %s',
    context,
    result.reason,
    result.message,
    result.candidates?.join(',') || 'none'
  );
}

function buildBuiltinImageGenerationServer(
  resolution: ImageGenerationMcpEnvResolveResult,
  config?: ImageGenerationModelSetting
): McpImportServer {
  const scriptPath = getBuiltinMcpScriptPath('builtin-mcp-image-gen');
  const env = resolution.ok ? resolution.env : {};
  const serverConfig = {
    command: 'node',
    args: [scriptPath],
    env,
  };

  return {
    name: BUILTIN_IMAGE_GEN_NAME,
    description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
    enabled: config?.switch === true && resolution.ok,
    builtin: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [scriptPath],
      env,
    },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_IMAGE_GEN_NAME]: serverConfig } }, null, 2),
  };
}

function areStringArraysEqual(left?: string[], right?: string[]): boolean {
  const leftValue = left || [];
  const rightValue = right || [];
  return leftValue.length === rightValue.length && leftValue.every((item, index) => item === rightValue[index]);
}

function areStringRecordsEqual(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftValue = left || {};
  const rightValue = right || {};
  const leftKeys = Object.keys(leftValue).toSorted();
  const rightKeys = Object.keys(rightValue).toSorted();
  return areStringArraysEqual(leftKeys, rightKeys) && leftKeys.every((key) => leftValue[key] === rightValue[key]);
}

function isSameStdioTransport(left: IMcpServer['transport'], right: IMcpServer['transport']): boolean {
  return (
    left.type === 'stdio' &&
    right.type === 'stdio' &&
    left.command === right.command &&
    areStringArraysEqual(left.args, right.args) &&
    areStringRecordsEqual(left.env, right.env)
  );
}

function buildBuiltinBrowserServer(): McpImportServer {
  const scriptPath = getBuiltinMcpScriptPath(BUILTIN_BROWSER_SCRIPT);
  const serverConfig = {
    command: 'node',
    args: [scriptPath],
  };

  return {
    name: BUILTIN_BROWSER_MCP_NAME,
    description:
      "Control AionUi's built-in browser (the side preview panel): open pages, click, type and read content. " +
      'Sign-in state is shared across tabs and preserved between sessions.',
    // 默认开启：用户装好即可用，无需任何配置
    // Enabled by default: works out of the box with zero configuration.
    enabled: true,
    builtin: true,
    transport: {
      type: 'stdio',
      command: serverConfig.command,
      args: serverConfig.args,
    },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_BROWSER_MCP_NAME]: serverConfig } }, null, 2),
  };
}

/**
 * 解析安装包内置的 chrome-devtools-mcp 副本（离线优先）。
 *
 * 存在时独立版 chrome-devtools 条目直接用 node 跑内置副本，跳过 npx ——
 * `npx -y chrome-devtools-mcp@latest` 在离线机器上永远起不来（@latest 要联网解析）。
 * 注册发生在目标机器首次启动时，此刻写下的绝对路径对该机器必然有效；
 * 应用日后移动目录由下方启动时的路径对齐逻辑自愈（与浏览器 MCP 同一模式）。
 *
 * --no-usage-statistics 是离线关键：默认遥测在无网环境死等 ~30s TCP 超时，
 * 表现为「测试连接超时」。
 *
 * Resolve the vendored chrome-devtools-mcp copy (offline-first). When present,
 * the standalone chrome-devtools entry runs it with node directly, skipping
 * npx — `npx -y chrome-devtools-mcp@latest` can never start offline. The
 * absolute path written at first-launch registration is valid for that
 * machine; later app moves self-heal via the startup realignment below (same
 * pattern as the browser MCP). --no-usage-statistics is offline-critical:
 * the default telemetry eats a ~30s TCP timeout on networkless machines.
 */
function resolveVendoredChromeDevtoolsSpawn(): { command: string; args: string[] } | null {
  try {
    const baseDir = app.isPackaged
      ? path.join(process.resourcesPath, 'bundled-mcp')
      : path.join(app.getAppPath(), 'resources', 'bundled-mcp');
    const entry = path.join(baseDir, 'chrome-devtools-mcp', 'build', 'src', 'index.js');
    if (!fs.existsSync(entry)) {
      return null;
    }
    return { command: 'node', args: [entry, '--no-usage-statistics'] };
  } catch {
    return null;
  }
}

/**
 * 解析随包内置的 todo MCP 脚本(零依赖 node 脚本,与 chrome-devtools 内置
 * 副本同一目录)。裸 `node` 由 aioncore 的托管运行时解析,不依赖系统 PATH,
 * 离线机器开箱即用。
 *
 * Resolve the bundled todo MCP script (dependency-free node script living in
 * the same bundled-mcp dir as the vendored chrome-devtools copy). The bare
 * `node` command resolves through aioncore's managed runtime, so it works on
 * offline machines with zero setup.
 */
function resolveTodoMcpSpawn(): { command: string; args: string[] } | null {
  try {
    const baseDir = app.isPackaged
      ? path.join(process.resourcesPath, 'bundled-mcp')
      : path.join(app.getAppPath(), 'resources', 'bundled-mcp');
    const entry = path.join(baseDir, 'todo-mcp', 'index.js');
    if (!fs.existsSync(entry)) {
      return null;
    }
    return { command: 'node', args: [entry] };
  } catch {
    return null;
  }
}

function buildDefaultMcpServers(): McpImportServer[] {
  const vendored = resolveVendoredChromeDevtoolsSpawn();
  const chromeConfig = vendored ?? { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] };
  const todoSpawn = resolveTodoMcpSpawn();
  const servers: McpImportServer[] = [
    {
      name: BUILTIN_CHROME_DEVTOOLS_NAME,
      description: 'Default MCP server: chrome-devtools',
      enabled: false,
      builtin: true,
      transport: {
        type: 'stdio',
        command: chromeConfig.command,
        args: chromeConfig.args,
      },
      original_json: JSON.stringify({ mcpServers: { [BUILTIN_CHROME_DEVTOOLS_NAME]: chromeConfig } }, null, 2),
    },
    buildBuiltinBrowserServer(),
  ];
  if (todoSpawn) {
    servers.push({
      name: TODO_MCP_NAME,
      description: "Manage the user's todo list (read/create/complete). Auto-attached to conversations.",
      // 默认启用 + 非 builtin:aioncore 会话快照规则下自动挂进所有新会话。
      // Enabled + non-builtin: the aioncore session snapshot auto-attaches it
      // to every new conversation.
      enabled: true,
      builtin: false,
      transport: {
        type: 'stdio',
        command: todoSpawn.command,
        args: todoSpawn.args,
      },
      original_json: JSON.stringify(
        { mcpServers: { [TODO_MCP_NAME]: { command: todoSpawn.command, args: todoSpawn.args } } },
        null,
        2
      ),
    });
  }
  const terminalEntry = path.join(
    app.isPackaged
      ? path.join(process.resourcesPath, 'bundled-mcp')
      : path.join(app.getAppPath(), 'resources', 'bundled-mcp'),
    'terminal-mcp',
    'index.cjs'
  );
  if (fs.existsSync(terminalEntry)) {
    const config = { command: 'node', args: [terminalEntry] };
    servers.push({
      name: 'woody-terminal',
      description:
        'Shared local Shell and Serial connections. Select for a new chat, then grant access from the terminal panel.',
      enabled: true,
      builtin: true,
      transport: { type: 'stdio', ...config },
      original_json: JSON.stringify({ mcpServers: { 'woody-terminal': config } }, null, 2),
    });
  }
  const cmakeEntry = path.join(path.dirname(path.dirname(terminalEntry)), 'cmake-mcp', 'index.cjs');
  const memoryDir = path.join(path.dirname(path.dirname(terminalEntry)), 'codebase-memory');
  const memoryEntry = path.join(memoryDir, 'index.cjs');
  const memoryBinary = path.join(memoryDir, 'bin', 'win32-x64', 'codebase-memory-mcp.exe');
  if (
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    fs.existsSync(memoryEntry) &&
    fs.existsSync(memoryBinary)
  ) {
    const config = { command: 'node', args: [memoryEntry] };
    servers.push({
      name: CODEBASE_MEMORY_MCP_NAME,
      description:
        'Local project architecture and code navigation. Enable in the project Architecture panel before opening a new conversation.',
      enabled: true,
      builtin: true,
      transport: { type: 'stdio', ...config },
      original_json: JSON.stringify({ mcpServers: { [CODEBASE_MEMORY_MCP_NAME]: config } }, null, 2),
    });
  }
  if (fs.existsSync(cmakeEntry)) {
    const config = { command: 'node', args: [cmakeEntry] };
    servers.push({
      name: 'woody-cmake',
      description:
        'Shared offline CMake builds and GDB debugging. Enable build and debug project access separately in the workbench.',
      enabled: true,
      builtin: true,
      transport: { type: 'stdio', ...config },
      original_json: JSON.stringify({ mcpServers: { 'woody-cmake': config } }, null, 2),
    });
  }
  return servers;
}

async function isCommandAvailable(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 3000 }, (error) => {
      if (!error) {
        resolve(true);
        return;
      }

      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        resolve(false);
        return;
      }

      resolve(true);
    });
  });
}

async function ensureBuiltinChromeDevtoolsAvailability(server?: IMcpServer): Promise<void> {
  if (
    !server ||
    server.name !== BUILTIN_CHROME_DEVTOOLS_NAME ||
    server.transport.type !== 'stdio' ||
    server.transport.command !== 'npx'
  ) {
    return;
  }

  const hasNpx = await isCommandAvailable(server.transport.command);
  if (hasNpx) {
    return;
  }

  try {
    await mcpService.testMcpConnection.invoke(server);
  } catch (error) {
    console.warn('[Migration] chrome-devtools MCP preflight failed', error);
  }
}

function buildOriginalJsonFromTransport(server: Pick<IMcpServer, 'name' | 'description' | 'transport'>): string {
  const transport_config =
    server.transport.type === 'stdio'
      ? {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        }
      : {
          type: server.transport.type,
          url: server.transport.url,
          ...(server.transport.headers ? { headers: server.transport.headers } : {}),
        };

  return JSON.stringify(
    {
      mcpServers: {
        [server.name]: {
          ...(server.description ? { description: server.description } : {}),
          ...transport_config,
        },
      },
    },
    null,
    2
  );
}

async function ensureBootstrapMcpServersInDb(configFile: ConfigFile): Promise<void> {
  const [backendPrefs, fileImageConfig, providers] = await Promise.all([
    fetchBackendClientPreferences(),
    configFile.get('tools.imageGenerationModel').catch((): undefined => undefined),
    fetchProviders(),
  ]);
  const imageConfig = resolveImageGenerationMigrationConfig(backendPrefs, fileImageConfig);
  const imageConfigSource = resolveImageGenerationMigrationConfigSource(backendPrefs, fileImageConfig);
  const existing = await mcpService.listServers.invoke();
  const existingByName = new Map((existing ?? []).map((server) => [server.name, server]));
  const existingImageServer = existingByName.get(BUILTIN_IMAGE_GEN_NAME);
  const existingImageEnv =
    existingImageServer?.transport.type === 'stdio' ? existingImageServer.transport.env : undefined;
  const imageEnvResolution = resolveImageGenerationMcpEnv(imageConfig, providers, existingImageEnv);
  logImageGenerationEnvResolution(imageEnvResolution, 'bootstrap');
  const imageServer = buildBuiltinImageGenerationServer(imageEnvResolution, imageConfig);
  const defaultServers = buildDefaultMcpServers();
  for (const name of ['woody-terminal', 'woody-cmake', CODEBASE_MEMORY_MCP_NAME]) {
    const desired = defaultServers.find((server) => server.name === name);
    const current = existingByName.get(name);
    if (
      desired &&
      current &&
      (!isSameStdioTransport(current.transport, desired.transport) ||
        current.builtin !== true ||
        current.original_json !== desired.original_json)
    ) {
      await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport: desired.transport, builtin: true, original_json: desired.original_json },
      });
    }
  }
  const missing = [...defaultServers, imageServer].filter((server) => !existingByName.has(server.name));
  let imageServerUpdated = false;

  if (missing.length > 0) {
    await mcpService.batchImportServers.invoke({ servers: missing });
  }

  const existingChromeDevtools = existingByName.get(BUILTIN_CHROME_DEVTOOLS_NAME);
  if (
    existingChromeDevtools &&
    (existingChromeDevtools.builtin !== true ||
      !existingChromeDevtools.original_json ||
      existingChromeDevtools.original_json.trim() === '' ||
      existingChromeDevtools.original_json.trim() === '{}')
  ) {
    await mcpService.updateServer.invoke({
      id: existingChromeDevtools.id,
      data: {
        builtin: true,
        original_json: buildOriginalJsonFromTransport(existingChromeDevtools),
      },
    });
  }

  const refreshedServers = await mcpService.listServers.invoke();
  const chromeDevtoolsServer = refreshedServers.find((server) => server.name === BUILTIN_CHROME_DEVTOOLS_NAME);
  await ensureBuiltinChromeDevtoolsAvailability(chromeDevtoolsServer);

  if (
    imageEnvResolution.ok === true &&
    existingImageServer &&
    existingImageServer.transport.type === 'stdio' &&
    imageServer.transport.type === 'stdio'
  ) {
    const mergedEnv = {
      ...removeImageGenerationEnvKeys(existingImageServer.transport.env || {}),
      ...imageEnvResolution.env,
    };
    const updatedTransport = {
      ...imageServer.transport,
      env: mergedEnv,
    };
    const original_json = JSON.stringify(
      {
        mcpServers: {
          [BUILTIN_IMAGE_GEN_NAME]: {
            command: updatedTransport.command,
            args: updatedTransport.args || [],
            env: mergedEnv,
          },
        },
      },
      null,
      2
    );
    const imageTransportChanged = !isSameStdioTransport(existingImageServer.transport, updatedTransport);
    const imageOriginalJsonChanged = existingImageServer.original_json !== original_json;
    const imageServerChanged = imageTransportChanged || imageOriginalJsonChanged;
    console.info(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      existingImageServer.id,
      imageTransportChanged ? 'yes' : 'no',
      imageOriginalJsonChanged ? 'yes' : 'no',
      imageServerChanged ? 'yes' : 'no'
    );
    if (imageServerChanged) {
      await mcpService.updateServer.invoke({
        id: existingImageServer.id,
        data: {
          transport: updatedTransport,
          original_json,
        },
      });
      imageServerUpdated = true;
    }
  } else if (existingImageServer && imageEnvResolution.ok === false) {
    console.warn(
      '[Migration] skipped image MCP env update because provider could not be resolved, server id: %s, reason: %s',
      existingImageServer.id,
      imageEnvResolution.reason
    );
  }

  /**
   * 修复浏览器 MCP 记录里过期的脚本绝对路径。
   *
   * 注册时把绝对路径写进了 transport.args，只在「首次插入」时写一次。应用被移动过
   * （用户把 .app 拖出 /Applications、Windows 重装到别的目录、开发时换 worktree）
   * 之后这条路径就失效了，而按名字判断「已注册」使它永远不会被重新插入 ——
   * 结果是浏览器工具永久失效且不会自愈。所以每次启动都对齐一次实际路径。
   *
   * Repair a stale absolute script path in the browser MCP record. The path is baked
   * into transport.args and only written on first insert, so once the app moves (user
   * drags the .app out of /Applications, a Windows reinstall to a different directory,
   * a developer switching worktrees) it goes stale — and because "already registered"
   * is decided by name, it is never re-inserted, leaving the browser tools broken with
   * no self-heal. Reconcile against the real path on every startup instead.
   */
  const existingBrowserServer = existing.find((server) => server.name === BUILTIN_BROWSER_MCP_NAME);
  let browserServerUpdated = false;
  if (existingBrowserServer) {
    const desiredBrowserServer = buildBuiltinBrowserServer();
    const browserTransportChanged = !isSameStdioTransport(
      existingBrowserServer.transport,
      desiredBrowserServer.transport
    );
    const browserJsonChanged = existingBrowserServer.original_json !== desiredBrowserServer.original_json;
    if (browserTransportChanged || browserJsonChanged) {
      console.info(
        '[Migration] browser MCP path drifted, server id: %s, transport changed: %s, json changed: %s',
        existingBrowserServer.id,
        browserTransportChanged ? 'yes' : 'no',
        browserJsonChanged ? 'yes' : 'no'
      );
      await mcpService.updateServer.invoke({
        id: existingBrowserServer.id,
        data: {
          transport: desiredBrowserServer.transport,
          original_json: desiredBrowserServer.original_json,
        },
      });
      browserServerUpdated = true;
    }
  }

  /**
   * 独立版 chrome-devtools 的离线改写：老安装的数据库里存的是 npx @latest 配置，
   * 离线机器永远起不来。与上面浏览器 MCP 同一「期望态对齐」模式——每次启动把
   * 期望配置（有内置副本时为 node 直跑）对齐进数据库，enabled 状态保持用户原样。
   *
   * Offline rewrite for the standalone chrome-devtools entry: older installs
   * carry the npx @latest config, which can never start offline. Same
   * desired-state realignment as the browser MCP above — align the desired
   * config (node + vendored copy when available) into the DB on every
   * startup, preserving the user's enabled state.
   */
  const existingChromeStandalone = existing.find((server) => server.name === BUILTIN_CHROME_DEVTOOLS_NAME);
  let chromeStandaloneUpdated = false;
  if (existingChromeStandalone) {
    const desiredChromeStandalone = defaultServers.find((server) => server.name === BUILTIN_CHROME_DEVTOOLS_NAME);
    if (
      desiredChromeStandalone &&
      (!isSameStdioTransport(existingChromeStandalone.transport, desiredChromeStandalone.transport) ||
        existingChromeStandalone.original_json !== desiredChromeStandalone.original_json)
    ) {
      console.info('[Migration] chrome-devtools standalone MCP config drifted, repointing to vendored copy');
      await mcpService.updateServer.invoke({
        id: existingChromeStandalone.id,
        data: {
          transport: desiredChromeStandalone.transport,
          original_json: desiredChromeStandalone.original_json,
        },
      });
      chromeStandaloneUpdated = true;
    }
  }

  /**
   * todo MCP 同样做期望态对齐(应用移动目录后脚本绝对路径失效时自愈)。
   * 与浏览器 MCP 不同的是 enabled 保持用户原样不动——用户若在设置里
   * 关掉它,agent 即失去待办工具,这是明确的选择,不覆盖。
   *
   * Same desired-state realignment for the todo MCP (self-heals the absolute
   * script path after the app moves). Unlike the browser MCP, the enabled
   * flag stays as the user set it — disabling it in settings deliberately
   * removes agent todo access and must not be overridden.
   */
  const existingTodoServer = existing.find((server) => server.name === TODO_MCP_NAME);
  let todoServerUpdated = false;
  if (existingTodoServer) {
    const desiredTodoServer = defaultServers.find((server) => server.name === TODO_MCP_NAME);
    if (
      desiredTodoServer &&
      (!isSameStdioTransport(existingTodoServer.transport, desiredTodoServer.transport) ||
        existingTodoServer.original_json !== desiredTodoServer.original_json)
    ) {
      console.info('[Migration] todo MCP config drifted, repointing to bundled script');
      await mcpService.updateServer.invoke({
        id: existingTodoServer.id,
        data: {
          transport: desiredTodoServer.transport,
          original_json: desiredTodoServer.original_json,
        },
      });
      todoServerUpdated = true;
    }
  }

  console.info(
    '[Migration] MCP bootstrap completed, imported %d missing defaults, updated image server: %s, updated browser server: %s, updated chrome standalone server: %s, updated todo server: %s, image config source: %s, image enabled: %s',
    missing.length,
    imageServerUpdated ? 'yes' : 'no',
    browserServerUpdated ? 'yes' : 'no',
    chromeStandaloneUpdated ? 'yes' : 'no',
    todoServerUpdated ? 'yes' : 'no',
    imageConfigSource,
    imageConfig?.switch === true ? 'yes' : 'no'
  );
}

/**
 * 邮件待办扫描的技能文件内容。定时任务每次运行把它注入扫描会话,LLM 按
 * 此指示从快照提取任务。Message-ID 去重由 todo MCP 的 todo_create 内建,
 * 技能只需指示 agent 原样传递 email_ref。
 *
 * Skill content for the scheduled email scan. Each cron run injects it into
 * the scan conversation; the LLM follows it to extract tasks from the
 * snapshot. Message-ID dedup lives inside the todo MCP's todo_create, so the
 * skill only needs the agent to pass email_ref through verbatim. Ownership
 * signals (my_role, thread_todo, user corrections) come from
 * email_snapshot_read; the skill turns them into the decision rules.
 */
const TODO_SCAN_SKILL = `---
name: todo-email-scan
---

# Email → Todo scan

You are a scheduled job inside AionUi. Goal: put the mailbox owner's OWN tasks on their todo list — nothing else. Mail about other people's work, mail the user is only copied on, and machine-sent mail stay off the list; they are logged as skipped with a reason the user can review and restore.

Steps:
1. Call the \`email_snapshot_read\` tool. It refreshes the mailbox snapshot when it is stale and returns ONLY unprocessed emails, at most 15 per call. Its header names the mailbox owner — "me" below — and may list corrections the user made to earlier scans: decide similar emails the same way.
2. If it reports an error, or "No email snapshot available", reply with a one-line status and stop. Do not create anything.
3. Decide each email with three checks, in order:
   A. Is it MY task? Look for the ask in latest_message. quoted_history is context only: an old ask quoted there is not new unless latest_message repeats it to me.
      MINE when any of:
      - the ask names me — my name, given name, English name, @me — or says "你/you" in a mail where my_role is "to" and I am the only or main recipient;
      - my_role is "to" and the ask goes to every recipient ("请各位/大家/all", a team-wide deadline);
      - my_role is "self" (a note I sent myself), or flagged is true (I flagged it for follow-up);
      - a system mail asks ME by name to approve, review or act (审批、评审指派、系统待办).
      NOT MINE when any of:
      - the ask names someone else ("张三请…", "@Tom please…", "Hi Lily,") — even when I am in To;
      - my_role is "cc" and latest_message does not name me;
      - my_role is "not_listed" (a distribution list or BCC) and the ask is not explicitly for me;
      - my_role is "sender": I asked others; their reply or acknowledgement is not my task unless it asks me something new.
      A mail that gives several people tasks: create todos ONLY for my part.
      Unclear whose it is: create it when my_role is "to" or "self"; otherwise skip it as not_mine with a note.
   B. Is there something for me to DO? Announcements, information, meeting minutes without my action items, receipts, newsletters, automated reports, alerts and spam are skipped (reason fyi or automated; automated=true marks bulk or machine-sent mail). A meeting invitation is a todo only when it needs preparation from me.
   C. Is it already tracked? thread_todo is a todo made from the same mail thread. While it is not done, do not create a second todo for the same ask: if the new mail moves its deadline, call \`todo_update\` with its id and the new due_at; if it now has to wait on someone, set status "waiting" with blocked_reason. Then skip the mail with reason tracked. A NEW, different ask for me in the thread is a new todo. Mail of one thread is listed together: judge it together, the newest message decides.
4. Call \`email_mark_skipped\` once per batch with every email that gets no new todo: {message_id (VERBATIM), reason, owner (for not_mine: whose task it is), note (one short line on why, in the email's language)}. Every email returned must end up either in todo_create (with email_ref) or in email_mark_skipped.
5. For each of MY tasks call \`todo_create\` with:
   - title: 具体动作+对象 ONLY, from my point of view, ≤ 45 字, e.g. "回复 Virgo 06 样机 6 项客户反馈". NEVER append requester names or dates — those go in the dedicated fields. Match the email's language.
   - requester: the person asking me — prefer the Chinese display name when the email has one (e.g. 李国强), else the raw sender.
   - due_at: ONLY if the email states an explicit deadline for my part (pass epoch ms or ISO string). Relative wording like "今天内/明天下班前/周五前" resolves against the email's received_local date. Never guess beyond that.
   - status: pass "waiting" instead of the default when execution is blocked on an external reply or input (待客户确认 / 等实验室数据 / 待上游答复...), and put the blocking condition into blocked_reason, e.g. "待客户确认固件方案后再执行".
   - subtasks: when the email lists concrete execution steps or acceptance items, pass them as 2–5 short imperative lines: [{text: "..."}, ...]. One entry per real step; skip when the ask is single-step.
   - notes: MUST follow this exact structure (keep each 标签, values in the email's language):
     要做什么: <one line: concrete action + deliverable/acceptance criterion>
     关键点:
     - <point extracted from the email: requirement, constraint, acceptance criteria, or decision to make>
     (2–6 points, most important first; preserve numbers/codes/model names exactly)
     原文关键句: "<one verbatim sentence from the email that best captures the ask>"
   - email_ref: pass the email's message_id / subject / received_at fields VERBATIM — this is the dedup key. For from, use the email's from_name field (fallback to from_address when from_name is empty); NEVER invent or leave it blank. The thread is filled in automatically.
6. If todo_create returns duplicate, that email is already tracked — skip it.
7. If email_snapshot_read said more unprocessed emails remain, call it again and repeat steps 3–6 for the next batch (at most 10 batches per run).
8. Finish with a one-line summary: scanned N emails, created M todos, skipped K (not mine / info or automated / already tracked).

Rules:
- Only the mailbox owner's own tasks become todos. A wrong todo costs the user attention; a skipped mail can be restored from the skipped list in one click.
- At most one todo per email, unless it genuinely contains multiple distinct tasks for me with different deadlines.
- Never delete todos or mark them done.
- A missing due_at is always better than a wrong one.
- The todo must be actionable from the notes alone: a reader who never saw the email should know exactly what to do, by when, for whom.
`;

/** Bump with every TODO_SCAN_SKILL change so existing scan jobs get the new text. */
export const TODO_SCAN_SKILL_FLAG = 'migration.todoScanSkillV6';

interface CronJobApiShape {
  id: string;
  name: string;
}

interface ProviderApiShape {
  id: string;
  name?: string;
  enabled?: boolean;
  models?: string[];
}

interface AssistantApiShape {
  id: string;
  name: string;
  enabled: boolean;
  agent?: { type?: string };
}

interface AssistantDetailApiShape {
  defaults?: {
    mcps?: {
      mode?: string;
      value?: string[];
    };
  };
  preferences?: {
    last_mcp_ids?: string[];
  };
}

interface McpServerApiShape {
  id: string;
  name: string;
  enabled?: boolean;
}

/**
 * 邮件扫描定时任务的期望态保障:① 默认 aionrs 助手的 defaults.mcps 对齐为
 * fixed 并保留当前集合、追加 aionui-todo(cron 会话的 MCP 取自助手快照,
 * enabled 状态挂不上);
 * ② "Todo email scan" 任务缺失时创建(每小时,new_conversation 模式,带
 * 技能文件),用户已建/改名/改频率/停用则不动。新装机还没配模型时本轮
 * 跳过,下次启动重试(本步骤每启动都跑,天然自愈)。
 *
 * Desired-state guarantees for the email scan: (1) align the default aionrs
 * assistant's defaults.mcps to fixed while preserving the current effective set
 * and appending aionui-todo — cron conversations take their MCP selection from
 * the assistant snapshot, which the enabled flag alone never satisfies; (2) create the "Todo email scan" job when missing
 * (hourly, new_conversation mode, with its skill file) — user renames /
 * schedule edits / disabling are never touched. Fresh installs without a
 * configured model defer to the next startup (the step runs every start).
 */
async function ensureTodoScanCronJob(): Promise<void> {
  const todoSpawn = resolveTodoMcpSpawn();
  if (!todoSpawn) {
    return; // 无 todo MCP 脚本(裁剪过的部署)则整个扫描链路不启用
  }

  const jobs = (await httpRequest<CronJobApiShape[]>('GET', '/api/cron/jobs')) || [];
  const jobExists = jobs.some((job) => job.name === TODO_SCAN_JOB_NAME);

  const [assistants, providers, mcpServers] = await Promise.all([
    (await httpRequest<AssistantApiShape[]>('GET', '/api/assistants').catch(() => [] as AssistantApiShape[])) || [],
    (await httpRequest<ProviderApiShape[]>('GET', '/api/providers').catch(() => [] as ProviderApiShape[])) || [],
    (await httpRequest<McpServerApiShape[]>('GET', '/api/mcp/servers').catch(() => [] as McpServerApiShape[])) || [],
  ]);
  const aionrs = assistants.find((assistant) => assistant.enabled && assistant.agent?.type === 'aionrs');
  const usable = providers.find((provider) => provider.enabled !== false && (provider.models?.length ?? 0) > 0);
  const todoMcp = mcpServers.find((server) => server.name === TODO_MCP_NAME);

  /**
   * cron 会话的 MCP 选择取自 assistant 快照(auto 模式空历史 = 显式零个),
   * enabled 状态挂不上 todo MCP。把默认 aionrs 助手的 defaults.mcps 设为
   * fixed 并保留原有集合、追加 todo id 后,扫描会话(及所有经该助手创建的
   * 会话)都会解析出 todo MCP。仅在 auto 模式时改写;用户自设过 fixed 集合则完全尊重。
   *
   * Cron conversations resolve their MCP selection from the assistant
   * snapshot (auto mode with no history = explicit zero), so the enabled flag
   * alone never attaches the todo MCP. Setting the default aionrs assistant's
   * defaults.mcps to fixed while preserving the existing set and appending the
   * todo id makes the scan conversation — and every other assistant-backed
   * conversation — resolve it. Only rewrites when the mode is auto; a
   * user-authored fixed set is respected verbatim.
   */
  if (aionrs && todoMcp) {
    try {
      const detail = await httpRequest<AssistantDetailApiShape>('GET', `/api/assistants/${aionrs.id}`);
      const mcps = detail?.defaults?.mcps;
      const isFixedWithoutTodo = mcps?.mode === 'fixed' && !(mcps.value || []).includes(todoMcp.id);
      if (mcps?.mode !== 'fixed') {
        const currentMcpIds =
          mcps?.mode === 'auto'
            ? detail?.preferences?.last_mcp_ids || []
            : Array.isArray(mcps?.value)
              ? mcps.value
              : [];
        await httpRequest('PUT', `/api/assistants/${aionrs.id}`, {
          defaults: { mcps: { mode: 'fixed', value: [...new Set([...currentMcpIds, todoMcp.id])] } },
        });
        console.info('[Migration] default assistant mcps pinned to include [aionui-todo]');
      } else if (isFixedWithoutTodo) {
        console.info(
          '[Migration] default assistant has a user-defined fixed mcp set without aionui-todo — respected as-is'
        );
      }
    } catch (error) {
      console.warn('[Migration] failed to set default assistant mcps:', error);
    }
  }

  if (jobExists) {
    // 技能文件按版本自愈重发:SKILL 内容升级(如 v6 的归属判断与跳过原因)后,
    // 已存在的 cron 任务也要拿到新指令。
    // Skill re-post on version bump so existing jobs pick up new instructions.
    try {
      const prefs = (await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) || {};
      if (!prefs[TODO_SCAN_SKILL_FLAG]) {
        const existing = jobs.find((job) => job.name === TODO_SCAN_JOB_NAME);
        if (existing?.id) {
          await httpRequest('POST', `/api/cron/jobs/${existing.id}/skill`, { content: TODO_SCAN_SKILL });
          await httpRequest('PUT', '/api/settings/client', { [TODO_SCAN_SKILL_FLAG]: true });
          console.info('[Migration] todo scan skill refreshed (%s)', TODO_SCAN_SKILL_FLAG);
        }
      }
    } catch (error) {
      console.warn('[Migration] todo scan skill refresh failed:', error);
    }
    return;
  }
  if (!aionrs || !usable) {
    // 新装机还没配模型:本轮跳过,下次启动重试(本步骤每启动都跑,自愈)。
    // Fresh install without a model yet: skip and retry next startup.
    console.info('[Migration] todo scan cron job deferred — no aionrs assistant or no configured model yet');
    return;
  }

  /**
   * assistant_id 是后端对新 cron 任务的强制要求;todo MCP 的挂载由上面助手
   * 的 fixed defaults 保证。model 动态取首个可用 provider 的首个模型。
   *
   * assistant_id is mandated by the backend for new cron jobs; todo MCP
   * attachment is guaranteed by the assistant's fixed defaults above. model
   * resolves to the first usable provider's first model.
   */
  const job = await httpRequest<CronJobApiShape>('POST', '/api/cron/jobs', {
    name: TODO_SCAN_JOB_NAME,
    description: 'Scan the email snapshot and turn actionable emails into todos',
    // 后端 CronScheduleDto 的 every 变体字段是 every_ms(snake_case),而 UI 实际
    // 只发 cron 表达式变体——沿用经过上游验证的形态,每小时 = 0 * * * *。
    // The backend's every variant takes every_ms (snake_case) while the UI only
    // ever sends the cron-expr variant — use the upstream-proven shape instead.
    schedule: { kind: 'cron', expr: '0 * * * *', description: 'every hour' },
    prompt: 'Run the email-to-todo scan following the skill file instructions.',
    conversation_id: '',
    conversation_title: 'Todo email scan',
    created_by: 'user',
    execution_mode: 'new_conversation',
    queue_enabled: true,
    agent_config: {
      name: aionrs.name,
      assistant_id: aionrs.id,
      model: { provider_id: usable.id, model: usable.models![0] },
    },
  });
  if (!job?.id) {
    console.warn('[Migration] todo scan cron job creation returned no id');
    return;
  }
  await httpRequest('POST', `/api/cron/jobs/${job.id}/skill`, { content: TODO_SCAN_SKILL });
  console.info(`[Migration] todo scan cron job created (${job.id}), hourly`);
}

const MIGRATION_STEPS: Array<{
  name: string;
  run: (configFile: ConfigFile) => Promise<MigrationStepResult>;
}> = [
  {
    name: 'migrateLegacyMcpConfigToDb',
    run: async (configFile) => (await migrateLegacyMcpConfigToDb(configFile), true),
  },
  { name: 'migrateConfigStorage', run: async (configFile) => (await migrateConfigStorage(configFile), true) },
  { name: 'migrateProviders', run: async (configFile) => (await migrateProviders(configFile), true) },
  {
    name: 'ensureBootstrapMcpServersInDb',
    run: async (configFile) => (await ensureBootstrapMcpServersInDb(configFile), true),
  },
  { name: 'migrateAssistantsToBackend', run: async (configFile) => migrateAssistantsToBackend(configFile) },
  { name: 'ensureTodoScanCronJob', run: async () => (await ensureTodoScanCronJob(), true) },
];

async function syncBuiltinMcpConfig(configFile: ConfigFile): Promise<void> {
  const localMcpConfig = ((await configFile.get('mcp.config').catch((): IMcpServer[] => [])) || []) as IMcpServer[];
  const localBuiltinServers = localMcpConfig.filter((server) => server?.builtin === true);

  if (localBuiltinServers.length === 0) {
    return;
  }

  const backendSettings = (await httpRequest<Record<string, unknown>>('GET', '/api/settings/client')) || {};
  const backendMcpConfig = Array.isArray(backendSettings['mcp.config'])
    ? (backendSettings['mcp.config'] as IMcpServer[])
    : [];

  const mergedMcpConfig = [...backendMcpConfig.filter((server) => server?.builtin !== true), ...localBuiltinServers];

  if (JSON.stringify(backendMcpConfig) === JSON.stringify(mergedMcpConfig)) {
    return;
  }

  await httpRequest<void>('PUT', '/api/settings/client', { 'mcp.config': mergedMcpConfig });
  console.info(
    '[AionUi] Synced builtin MCP config to backend settings (%d builtin servers)',
    localBuiltinServers.length
  );
}

export async function runBackendMigrations(configFile: ConfigFile): Promise<void> {
  await CLEANUP_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      await step.run();
      console.info(`[AionUi] Backend migration step completed: ${step.name} (${Date.now() - start}ms)`);
    } catch (error) {
      console.error(`[AionUi] Backend migration step failed: ${step.name} (${Date.now() - start}ms)`, error);
    }
  }, Promise.resolve());

  await MIGRATION_STEPS.reduce<Promise<void>>(async (previous, step) => {
    await previous;
    const start = Date.now();
    try {
      const completed = await step.run(configFile);
      const elapsed = Date.now() - start;
      if (!completed) {
        console.warn(`[AionUi] Backend migration step incomplete: ${step.name} (${elapsed}ms)`);
        return;
      }
      console.info(`[AionUi] Backend migration step completed: ${step.name} (${elapsed}ms)`);
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[AionUi] Backend migration step failed: ${step.name} (${elapsed}ms)`, error);
    }
  }, Promise.resolve());

  const syncStart = Date.now();
  try {
    await syncBuiltinMcpConfig(configFile);
    console.info(`[AionUi] Backend migration step completed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`);
  } catch (error) {
    console.error(`[AionUi] Backend migration step failed: syncBuiltinMcpConfig (${Date.now() - syncStart}ms)`, error);
  }
}
