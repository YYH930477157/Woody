import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { captureWorkspaceRequests } from './workspaceLiveTransport';

export type LiveChat = {
  id: string;
  project_id: string;
  status: string;
  runtime?: { state: string; is_processing: boolean; turn_id: string | null; pending_confirmations: number };
  extra: Record<string, unknown>;
};
export type LiveMessage = { id: string; type: string; position?: string; content: unknown; status?: string };
export type LiveModel = {
  provider_id: string;
  model: string;
  transport: Awaited<ReturnType<typeof captureWorkspaceRequests>>;
  probes: { role: string; status: number; matched: boolean; finishReason?: string; answer?: string }[];
};
export type LiveTool = { name: string; args: Record<string, unknown>; status: string; output?: string };
export const liveTools = (messages: LiveMessage[]): LiveTool[] =>
  messages.filter((message) => message.type === 'tool_call').map((message) => message.content as LiveTool);

/** Node-side HTTP avoids putting provider credentials into Playwright page/trace arguments. */
export async function liveRequest<T>(page: Page, method: string, endpoint: string, body?: unknown): Promise<T> {
  const port = await page.evaluate(() => (window as Window & { __backendPort?: number }).__backendPort);
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) throw new Error('Backend port unavailable');
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) {
    // Provider responses may carry credentials. Never include request/response payloads here.
    const code = result?.error?.code || result?.code || 'unknown';
    throw new Error(`${method} ${endpoint}: HTTP ${response.status}, code=${code}`);
  }
  return (result.data ?? result) as T;
}

/** Import only the explicitly selected provider from the source profile, opened read-only. */
export async function importLiveProvider(page: Page): Promise<LiveModel> {
  const name = process.env.E2E_LIVE_PROVIDER_NAME;
  const model = process.env.E2E_LIVE_MODEL;
  if (!name || !model) throw new Error('Set E2E_LIVE_PROVIDER_NAME and E2E_LIVE_MODEL explicitly');
  const source = process.env.E2E_SOURCE_DB || path.join(process.env.APPDATA!, 'AionUi/aionui/aionui-backend.db');
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM providers WHERE name = ? AND enabled = 1').get(name);
    if (!row) throw new Error('Selected enabled provider not found');
    if (!(JSON.parse(String(row.models)) as string[]).includes(model)) throw new Error('Selected model not configured');
    const user = db.prepare('SELECT encryption_secret, jwt_secret FROM users WHERE id = ?').get('system_default_user');
    const secret = process.env.AIONUI_ENCRYPTION_SECRET || user?.encryption_secret || user?.jwt_secret;
    if (!secret) throw new Error('Source profile encryption secret unavailable');
    // Matches AionCore config.rs derive_encryption_key and aionui-common crypto.rs.
    const key = createHash('sha256').update(`aionui-encryption-key:${secret}`).digest();
    const encrypted = Buffer.from(String(row.api_key_encrypted), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    const apiKey = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('utf8');
    let probes: LiveModel['probes'] = [];
    if (process.env.E2E_LIVE_PROBE === '1') {
      const endpoint = row.is_full_url
        ? String(row.base_url)
        : `${String(row.base_url).replace(/\/$/, '')}/chat/completions`;
      probes = await Promise.all(
        ['system', 'user'].map(async (role) => {
          const marker = `workspace-${randomUUID()}`;
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role,
                  content: `The verification marker is ${marker}. When asked, reply with the marker exactly.`,
                },
                {
                  role: 'user',
                  content: 'What is the verification marker? Output only the marker, without explanation.',
                },
              ],
              stream: false,
              max_tokens: 2048,
            }),
            signal: AbortSignal.timeout(90_000),
          });
          const body = await response.json();
          const answer = String(body?.choices?.[0]?.message?.content ?? '');
          return {
            role,
            status: response.status,
            matched: answer.includes(marker),
            finishReason: body?.choices?.[0]?.finish_reason,
            answer,
          };
        })
      );
      console.log(`[workspace-live] direct marker probes: ${JSON.stringify(probes)}`);
    }
    const parse = (field: string, fallback: unknown): unknown =>
      row[field] ? JSON.parse(String(row[field])) : fallback;
    const transport = await captureWorkspaceRequests(String(row.base_url));
    const created = await liveRequest<{ id: string }>(page, 'POST', '/api/providers', {
      platform: row.platform,
      name: `workspace-live-${name}`,
      base_url: transport.baseUrl,
      api_key: apiKey,
      models: [model],
      enabled: true,
      capabilities: parse('capabilities', []),
      context_limit: row.context_limit,
      model_protocols: parse('model_protocols', null),
      model_settings: parse('model_settings', {}),
      is_full_url: Boolean(row.is_full_url),
    }).catch(async (error: unknown) => {
      await transport.close();
      throw error;
    });
    console.log(`[workspace-live] provider=${name}, model=${model}`);
    return { provider_id: created.id, model, transport, probes };
  } finally {
    db.close();
  }
}

export async function createLiveChat(page: Page, projectId: string, model: LiveModel, name: string): Promise<LiveChat> {
  return liveRequest(page, 'POST', '/api/conversations', {
    type: 'aionrs',
    name,
    model: { provider_id: model.provider_id, model: model.model },
    extra: {
      workspace_project_id: projectId,
      session_mode: 'yolo',
      selected_session_mcp_servers: [],
      selected_mcp_server_ids: [],
    },
  });
}

export async function openLiveChat(page: Page, chat: LiveChat): Promise<void> {
  await page.evaluate((id) => {
    location.hash = `/conversation/${id}`;
  }, chat.id);
  await page.locator('[data-testid="sendbox-input"]').waitFor({ state: 'visible', timeout: 30_000 });
}

export async function liveMessages(page: Page, id: string): Promise<LiveMessage[]> {
  const response = await liveRequest<{ items: LiveMessage[] }>(
    page,
    'GET',
    `/api/conversations/${id}/messages?limit=100`
  );
  return response.items;
}

export async function waitLiveIdle(page: Page, id: string, timeout = 180_000): Promise<LiveChat> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const chat = await liveRequest<LiveChat>(page, 'GET', `/api/conversations/${id}`);
    if (chat.runtime?.pending_confirmations) throw new Error(`Unexpected pending approval in ${id}`);
    if (chat.runtime?.state === 'idle' && !chat.runtime.is_processing) return chat;
    await page.waitForTimeout(500);
  }
  throw new Error(`Live model turn did not become idle: ${id}`);
}

export async function liveTurn(
  page: Page,
  chat: LiveChat,
  content: string,
  info: TestInfo,
  label: string
): Promise<LiveMessage[]> {
  const previous = new Set((await liveMessages(page, chat.id)).map((message) => message.id));
  console.log(`[workspace-live] start ${label}`);
  await liveRequest(page, 'POST', `/api/conversations/${chat.id}/messages`, { content });
  let final: LiveChat;
  try {
    final = await waitLiveIdle(page, chat.id);
  } finally {
    const captured = (await liveMessages(page, chat.id)).filter((message) => !previous.has(message.id));
    fs.writeFileSync(info.outputPath(`${label}-messages.json`), JSON.stringify(captured, null, 2));
  }
  const messages = (await liveMessages(page, chat.id)).filter((message) => !previous.has(message.id));
  await info.attach(`${label}-messages`, { body: JSON.stringify(messages, null, 2), contentType: 'application/json' });
  if (final.status === 'error' || final.status === 'failed') throw new Error(`Model turn failed: ${label}`);
  const providerErrors = messages
    .filter((message) => message.type === 'tips')
    .map((message) => (message.content as { error?: { code?: string } })?.error?.code)
    .filter((code) => code?.startsWith('USER_LLM_'));
  if (providerErrors.length) throw new Error(`Model provider failed: ${label}, ${providerErrors.join(', ')}`);
  if (!messages.some((message) => message.position === 'left')) throw new Error(`No model response: ${label}`);
  console.log(`[workspace-live] finished ${label}, messages=${messages.length}`);
  return messages;
}
