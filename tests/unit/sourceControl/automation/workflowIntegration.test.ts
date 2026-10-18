import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWorkflowAgentService } from '@/process/services/sourceControl/workflowAgentService';
import { createCommitWorkflowService } from '@/process/services/sourceControl/commitWorkflowService';
import { createProjectBuildService } from '@/process/services/sourceControl/projectBuildService';
import { createStaticScanService } from '@/process/services/sourceControl/staticScanService';
import { createGitCommandService } from '@/process/services/sourceControl/gitCommandService';

const exec = promisify(execFile);

describe('submission workflow integration', () => {
  it('repairs through the existing chat HTTP contract, rescans and runs a real build before drafting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aion-workflow-'));
    const fields = {
      reason: 'fix null pointer',
      scope: 'a.cpp',
      solution: 'nullptr',
      impact: 'none',
      tests: 'scan and original build passed',
    };
    const prompts: string[] = [];
    let messageId = '';
    let answer = '';
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      const url = new URL(request.url!, 'http://localhost');
      if (!url.pathname.startsWith('/api/conversations/existing-chat')) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'POST' && url.pathname.endsWith('/messages')) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { content: string };
        prompts.push(body.content);
        messageId = `message-${prompts.length}`;
        if (body.content.startsWith('Fix')) {
          await writeFile(join(root, 'a.cpp'), 'nullptr');
          answer = 'Fixed a.cpp';
        } else {
          answer = JSON.stringify(fields);
        }
        response.end(JSON.stringify({ data: { turn_id: `turn-${prompts.length}`, msg_id: messageId } }));
      } else if (url.pathname.endsWith('/messages')) {
        response.end(
          JSON.stringify({
            data: {
              items: [
                { id: messageId, type: 'text', position: 'right', content: {} },
                { id: 'answer', type: 'text', position: 'left', content: { content: answer } },
              ],
              has_more_after: false,
            },
          })
        );
      } else {
        response.end(
          JSON.stringify({
            data: {
              runtime: {
                can_send_message: true,
                is_processing: false,
                turn_id: prompts.length ? `turn-${prompts.length}` : null,
              },
            },
          })
        );
      }
    });
    try {
      await exec('git', ['init', '--initial-branch=main'], { cwd: root });
      await writeFile(join(root, 'a.cpp'), 'NULL');
      await writeFile(join(root, 'other.cpp'), 'user changes');
      await mkdir(join(root, '.woody'));
      await writeFile(
        join(root, '.woody/static-scan.json'),
        JSON.stringify({
          build: { executable: process.execPath, arguments: ['-e', 'console.log("original build passed")'] },
        })
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      const agent = createWorkflowAgentService({
        request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
          const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
          });
          return ((await result.json()) as { data: T }).data;
        },
      });
      const workflow = createCommitWorkflowService(createGitCommandService());
      const states: string[] = [];
      const session = await workflow.prepare({
        repoPath: root,
        branch: 'main',
        selectedPaths: ['a.cpp'],
        scannerConfigs: [
          {
            tool: 'clang-tidy',
            scope: 'selected',
            executablePath: process.execPath,
            arguments: [
              '-e',
              'if(require("fs").readFileSync(process.argv[1],"utf8").includes("NULL")) { console.log("a.cpp:1:1: warning: use nullptr [modernize-use-nullptr]"); process.exitCode=1; }',
            ],
          },
        ],
        scan: createStaticScanService().scan,
        repair: agent.repair('existing-chat'),
        compile: createProjectBuildService().compile,
        generateMessage: (verification) =>
          agent.generateMessage(
            'existing-chat',
            root,
            ['a.cpp'],
            { reason: '', scope: '', solution: '', impact: '', tests: '' },
            JSON.stringify(verification)
          ),
        onStateChange: (state) => states.push(state),
      });
      expect(session).toMatchObject({
        state: 'confirmation',
        messageFields: fields,
        compileResult: { ok: true, stdout: 'original build passed\n' },
      });
      expect(states).toEqual(['collecting', 'scan', 'repair', 'rescan', 'compile', 'message_draft', 'confirmation']);
      expect(await readFile(join(root, 'other.cpp'), 'utf8')).toBe('user changes');
      expect((await exec('git', ['status', '--porcelain'], { cwd: root })).stdout).toContain('?? a.cpp');
      expect(prompts).toHaveLength(2);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  });
});
