import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import {
  resolveImageGenerationMigrationConfig,
  runBackendMigrations,
  TODO_SCAN_SKILL_FLAG,
} from '@/process/utils/runBackendMigrations';

const {
  batchImportServersMock,
  configFileGetMock,
  configFileSetMock,
  httpRequestMock,
  listServersMock,
  testMcpConnectionMock,
  updateServerMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  configFileGetMock: vi.fn(),
  configFileSetMock: vi.fn(),
  httpRequestMock: vi.fn(),
  listServersMock: vi.fn(),
  testMcpConnectionMock: vi.fn(),
  updateServerMock: vi.fn(),
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
}));

vi.mock('@/process/bridge/todoBridge', () => ({
  TODO_SCAN_JOB_NAME: 'Todo email scan',
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
    updateServer: { invoke: updateServerMock },
    testMcpConnection: { invoke: testMcpConnectionMock },
  },
}));

vi.mock('@/common/config/configMigration', () => ({
  migrateConfigStorage: vi.fn().mockResolvedValue(undefined),
  migrateLegacyMcpConfigToDb: vi.fn().mockResolvedValue(undefined),
  migrateProviders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/process/utils/initStorage', () => ({
  getBuiltinMcpScriptPath: (name: string) => `/mock/${name}.js`,
}));

vi.mock('@/process/utils/migrateAssistants', () => ({
  migrateAssistantsToBackend: vi.fn().mockResolvedValue(true),
}));

const provider: IProvider = {
  id: 'provider-1',
  platform: 'gemini',
  name: 'Gemini',
  base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'provider-key',
  models: ['gemini-image'],
  enabled: true,
};

const imageEnv = {
  [IMAGE_GEN_ENV_KEYS.providerId]: 'provider-1',
  [IMAGE_GEN_ENV_KEYS.platform]: 'gemini',
  [IMAGE_GEN_ENV_KEYS.baseUrl]: 'https://generativelanguage.googleapis.com',
  [IMAGE_GEN_ENV_KEYS.apiKey]: 'provider-key',
  [IMAGE_GEN_ENV_KEYS.model]: 'gemini-image',
};

const imageServer = (): IMcpServer => ({
  id: 'image-server-id',
  name: BUILTIN_IMAGE_GEN_NAME,
  description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/mock/builtin-mcp-image-gen.js'],
    env: imageEnv,
  },
  created_at: 1,
  updated_at: 1,
  original_json: JSON.stringify(
    {
      mcpServers: {
        [BUILTIN_IMAGE_GEN_NAME]: {
          command: 'node',
          args: ['/mock/builtin-mcp-image-gen.js'],
          env: imageEnv,
        },
      },
    },
    null,
    2
  ),
});

const configFile = {
  get: configFileGetMock,
  set: configFileSetMock,
};

beforeEach(() => {
  vi.clearAllMocks();
  configFileGetMock.mockResolvedValue(undefined);
  configFileSetMock.mockResolvedValue(undefined);
  batchImportServersMock.mockResolvedValue([]);
  updateServerMock.mockImplementation(async ({ id, data }) => ({
    ...imageServer(),
    id,
    ...data,
  }));
  testMcpConnectionMock.mockResolvedValue({ success: false, error: 'Command not found: npx' });
  httpRequestMock.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/api/settings/client') {
      return {
        'tools.imageGenerationModel': {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
        },
      };
    }
    if (method === 'GET' && path === '/api/providers') {
      return [provider];
    }
    return undefined;
  });
});

describe('resolveImageGenerationMigrationConfig', () => {
  it('uses backend client preference when local config file no longer has the image model', () => {
    const backendConfig = {
      id: 'gemini',
      name: 'Gemini',
      platform: 'gemini',
      base_url: 'https://example.test',
      api_key: 'backend-key',
      use_model: 'gemini-image',
    };

    expect(resolveImageGenerationMigrationConfig({ 'tools.imageGenerationModel': backendConfig }, undefined)).toEqual(
      backendConfig
    );
  });
});

describe('runBackendMigrations', () => {
  it('does not write image generation business config back to local config storage', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    configFileGetMock.mockImplementation(async (key: string) => {
      if (key === 'tools.imageGenerationModel') {
        return {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
          switch: true,
        };
      }
      return undefined;
    });
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/settings/client') {
        return {};
      }
      if (method === 'GET' && path === '/api/providers') {
        return [provider];
      }
      return undefined;
    });

    await runBackendMigrations(configFile as never);

    expect(configFileSetMock).not.toHaveBeenCalledWith('tools.imageGenerationModel', expect.anything());
  });

  it('does not sync the built-in image MCP server when bootstrap makes no effective change', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([imageServer()]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'no',
      'no'
    );
  });

  it('does not sync agents when only the stored image MCP JSON representation differs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([
      {
        ...imageServer(),
        original_json: '{"legacy":true}',
      },
    ]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'yes',
      'yes'
    );
  });

  it.each([
    {
      detail: {
        defaults: { mcps: { mode: 'auto', value: ['unused'] } },
        preferences: { last_mcp_ids: ['mail', 'mail'] },
      },
      expected: ['mail', 'todo'],
    },
    { detail: { defaults: {}, preferences: { last_mcp_ids: [] } }, expected: ['todo'] },
    {
      detail: { defaults: { mcps: { mode: 'auto' } }, preferences: { last_mcp_ids: ['mail', 'todo'] } },
      expected: ['mail', 'todo'],
    },
  ])('preserves effective MCP choices when enabling Todo scanning: $detail', async ({ detail, expected }) => {
    listServersMock.mockResolvedValue([imageServer()]);
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method !== 'GET') return undefined;
      if (path === '/api/assistants') return [{ id: 'assistant', enabled: true, agent: { type: 'aionrs' } }];
      if (path === '/api/assistants/assistant') return detail;
      if (path === '/api/mcp/servers') return [{ id: 'todo', name: 'aionui-todo' }];
      if (path === '/api/cron/jobs') return [{ id: 'scan', name: 'Todo email scan' }];
      if (path === '/api/settings/client') return { [TODO_SCAN_SKILL_FLAG]: true };
      return [];
    });

    await runBackendMigrations(configFile as never);

    expect(httpRequestMock).toHaveBeenCalledWith('PUT', '/api/assistants/assistant', {
      defaults: { mcps: { mode: 'fixed', value: expected } },
    });
  });

  it('respects an explicit fixed MCP selection without Todo', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method !== 'GET') return undefined;
      if (path === '/api/assistants') return [{ id: 'assistant', enabled: true, agent: { type: 'aionrs' } }];
      if (path === '/api/assistants/assistant') return { defaults: { mcps: { mode: 'fixed', value: ['mail'] } } };
      if (path === '/api/mcp/servers') return [{ id: 'todo', name: 'aionui-todo' }];
      if (path === '/api/cron/jobs') return [{ id: 'scan', name: 'Todo email scan' }];
      if (path === '/api/settings/client') return { [TODO_SCAN_SKILL_FLAG]: true };
      return [];
    });

    await runBackendMigrations(configFile as never);

    expect(httpRequestMock).not.toHaveBeenCalledWith('PUT', '/api/assistants/assistant', expect.anything());
  });

  it('does not overwrite MCP choices when loading assistant details fails', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method !== 'GET') return undefined;
      if (path === '/api/assistants') return [{ id: 'assistant', enabled: true, agent: { type: 'aionrs' } }];
      if (path === '/api/assistants/assistant') throw new Error('backend unavailable');
      if (path === '/api/mcp/servers') return [{ id: 'todo', name: 'aionui-todo' }];
      if (path === '/api/cron/jobs') return [{ id: 'scan', name: 'Todo email scan' }];
      if (path === '/api/settings/client') return { [TODO_SCAN_SKILL_FLAG]: true };
      return [];
    });

    await runBackendMigrations(configFile as never);

    expect(httpRequestMock).not.toHaveBeenCalledWith('PUT', '/api/assistants/assistant', expect.anything());
  });

  it('re-posts the Todo scan skill with ownership rules to an existing job once', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method !== 'GET') return undefined;
      if (path === '/api/cron/jobs') return [{ id: 'scan', name: 'Todo email scan' }];
      if (path === '/api/settings/client') return { 'migration.todoScanSkillV5': true };
      return [];
    });

    await runBackendMigrations(configFile as never);

    expect(httpRequestMock).toHaveBeenCalledWith('POST', '/api/cron/jobs/scan/skill', {
      content: expect.stringContaining('my_role'),
    });
    expect(httpRequestMock).toHaveBeenCalledWith('PUT', '/api/settings/client', { [TODO_SCAN_SKILL_FLAG]: true });
  });
});
