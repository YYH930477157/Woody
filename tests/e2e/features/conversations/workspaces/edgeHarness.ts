import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import type { ProjectDetailDto } from '../../../../../packages/desktop/src/common/types/project';
import { createLiveChat, liveRequest, type LiveModel, type LiveMessage } from '../aionrs/workspaceLive';

export const scope =
  '这是已授权的临时工作区集成测试。只操作当前工作区中的样例文件，不读取凭据、用户目录或其他项目，不调用 MCP、不委派任务。';
export const value = 'export const value = 1;\n';
export const normalize = (text: string) =>
  text
    .replaceAll('\\', '/')
    .replace(/^\/\/\?\//, '')
    .toLowerCase();
export const answer = (messages: LiveMessage[]) =>
  messages
    .filter((message) => message.position === 'left' && message.type === 'text')
    .map((message) => (message.content as { content: string }).content)
    .join('\n');

export async function createCase(page: Page, model: LiveModel, names = ['application', 'library']) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'woody-edge-'));
  const directories = names.map((_, index) => {
    const directory = path.join(base, `目录 ${index}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'value.ts'), value);
    return directory;
  });
  let workspace = await liveRequest<ProjectDetailDto>(page, 'POST', '/api/projects/workspaces', {
    name: 'Workspace edge test',
    uri: pathToFileURL(directories[0]).href,
  });
  workspace = await liveRequest(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
    name: workspace.name,
    roots: directories.map((directory, index) => ({
      pe_id: index === 0 ? workspace.explorer.entries[0].pe_id : undefined,
      uri: pathToFileURL(directory).href,
      display_name: names[index],
    })),
    default_pe_id: workspace.explorer.entries[0].pe_id,
  });
  const chat = await createLiveChat(page, workspace.project_id, model, 'Workspace edge chat');
  return { base, directories, workspace, chat };
}

export async function updateCase(
  page: Page,
  workspace: ProjectDetailDto,
  roots = workspace.explorer.entries,
  defaultId: string | null = roots[0]?.pe_id ?? null
) {
  return liveRequest<ProjectDetailDto>(page, 'PUT', `/api/projects/${workspace.project_id}/workspace`, {
    name: workspace.name,
    roots: roots.map((root) => ({
      pe_id: root.pe_id,
      uri: pathToFileURL(root.display_path).href,
      display_name: root.display_name,
    })),
    default_pe_id: defaultId,
  });
}
