import { describe, expect, it, vi } from 'vitest';
import { createWorkflowAgentService, parseCommitDraft } from '@/process/services/sourceControl/workflowAgentService';

const fields = { reason: 'fix', scope: 'driver', solution: 'nullptr', impact: 'none', tests: 'scan and build' };
const runtime = (processing = false, turnId: string | null = null) => ({
  runtime: { is_processing: processing, can_send_message: !processing, turn_id: turnId },
});
type Request = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const backend = (answer = JSON.stringify(fields)) => {
  let sent = false;
  const request = vi.fn(async (method: string, path: string): Promise<unknown> => {
    if (method === 'POST' && path.endsWith('/messages')) {
      sent = true;
      return { turn_id: 'workflow-turn', msg_id: 'request-message' };
    }
    if (path.includes('/messages?'))
      return {
        items: [
          { id: 'old-answer', type: 'text', content: { content: 'old unrelated answer' }, position: 'left' },
          { id: 'request-message', type: 'text', position: 'right', content: {} },
          { id: 'new-answer', type: 'text', content: { content: answer }, position: 'left' },
        ],
        has_more_after: false,
      };
    return runtime(false, sent ? 'workflow-turn' : null);
  });
  return request;
};

describe('existing conversation workflow agent', () => {
  it('generates a draft in the same conversation, using only the response to its own message', async () => {
    const request = backend();
    const service = createWorkflowAgentService({ request: request as Request, capture: async () => new Map() });
    expect(await service.generateMessage('current-chat', 'D:/repo', ['a.cpp'], fields, 'build passed')).toEqual(fields);
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/api/conversations/current-chat/messages',
      expect.objectContaining({
        content: expect.stringContaining('build passed'),
      })
    );
  });
  it('blocks before sending when no current conversation is available', async () => {
    const request = backend();
    const service = createWorkflowAgentService({ request: request as Request });
    await expect(
      service.repair(undefined)({ repoPath: 'repo', selectedPaths: ['a.cpp'], diagnostics: [], attempt: 1 })
    ).rejects.toMatchObject({ reasonCode: 'conversationRequired' });
    expect(request).not.toHaveBeenCalled();
  });
  it('does not inject a workflow message into a busy conversation', async () => {
    const request = vi.fn(async () => runtime(true, 'user-turn'));
    const service = createWorkflowAgentService({ request: request as Request });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'conversationBusy',
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it('cancels its own turn and blocks if a repair modifies an unselected file', async () => {
    const request = backend();
    const capture = vi
      .fn()
      .mockResolvedValueOnce(new Map([['other.cpp', 'user version']]))
      .mockResolvedValue(new Map([['other.cpp', 'agent version']]));
    const service = createWorkflowAgentService({ request: request as Request, capture });
    await expect(
      service.repair('chat')({ repoPath: 'repo', selectedPaths: ['a.cpp'], diagnostics: [], attempt: 1 })
    ).rejects.toMatchObject({ reasonCode: 'repairOutsideSelection' });
    expect(request).toHaveBeenCalledWith('POST', '/api/conversations/chat/cancel', { turn_id: 'workflow-turn' });
  });
  it('allows selected file repairs then waits for the accepted turn to finish', async () => {
    const request = backend('fixed');
    const capture = vi
      .fn()
      .mockResolvedValueOnce(new Map([['a.cpp', 'before']]))
      .mockResolvedValue(new Map([['a.cpp', 'after']]));
    const service = createWorkflowAgentService({ request: request as Request, capture });
    await expect(
      service.repair('chat')({ repoPath: 'repo', selectedPaths: ['a.cpp'], diagnostics: [], attempt: 1 })
    ).resolves.toEqual({ changedPaths: ['a.cpp'] });
  });
  it('rejects a draft turn that edits files, even selected ones', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(new Map([['a.cpp', 'changed']]));
    const service = createWorkflowAgentService({ request: backend() as Request, capture });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'repairOutsideSelection',
    });
  });
  it('blocks a subsequent user turn rather than treating it as workflow completion', async () => {
    const request = backend();
    request
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce({ turn_id: 'workflow-turn', msg_id: 'request-message' })
      .mockResolvedValueOnce(runtime(true, 'other-turn'));
    const service = createWorkflowAgentService({ request: request as Request, capture: async () => new Map() });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'conversationBusy',
    });
  });
  it('times out and cancels without allowing a commit', async () => {
    const request = backend();
    const service = createWorkflowAgentService({
      request: request as Request,
      capture: async () => new Map(),
      timeoutMs: 0,
    });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'agentFailed',
    });
    expect(request).toHaveBeenCalledWith('POST', '/api/conversations/chat/cancel', { turn_id: 'workflow-turn' });
  });
  it('rejects missing or empty fields rather than filling in invented values', () => {
    expect(() => parseCommitDraft('{"reason":"fix"}')).toThrow();
    expect(() => parseCommitDraft(JSON.stringify({ ...fields, tests: '' }))).toThrow();
    expect(parseCommitDraft('```json\n' + JSON.stringify(fields) + '\n```')).toEqual(fields);
  });
  it('waits for its own active turn and then reads the final response', async () => {
    const request = backend();
    request
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce({ turn_id: 'workflow-turn', msg_id: 'request-message' })
      .mockResolvedValueOnce(runtime(true, 'workflow-turn'));
    const wait = vi.fn(async (): Promise<void> => {});
    const service = createWorkflowAgentService({ request: request as Request, capture: async () => new Map(), wait });
    expect(await service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).toEqual(fields);
    expect(wait).toHaveBeenCalledWith(1000);
  });
  it('reads paginated response messages without including earlier conversation content', async () => {
    const request = backend();
    request
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce({ turn_id: 'workflow-turn', msg_id: 'request-message' })
      .mockResolvedValueOnce(runtime(false, 'workflow-turn'))
      .mockResolvedValueOnce({
        items: [{ id: 'request-message', type: 'text', position: 'right', content: {} }],
        newest_cursor: 'next-cursor',
        has_more_after: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 'answer', type: 'text', position: 'left', content: { content: JSON.stringify(fields) } }],
        has_more_after: false,
      });
    const service = createWorkflowAgentService({ request: request as Request, capture: async () => new Map() });
    expect(await service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).toEqual(fields);
    expect(request).toHaveBeenCalledWith('GET', expect.stringContaining('after=next-cursor'), undefined);
  });
  it('blocks backend errors instead of allowing an empty repair result', async () => {
    const request = vi.fn(async (): Promise<never> => {
      throw new Error('offline');
    });
    const service = createWorkflowAgentService({ request });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'agentFailed',
    });
  });
  it('blocks a message stream with a server-reported error', async () => {
    const request = backend();
    request
      .mockResolvedValueOnce(runtime())
      .mockResolvedValueOnce({ turn_id: 'workflow-turn', msg_id: 'request-message' })
      .mockResolvedValueOnce(runtime(false, 'workflow-turn'))
      .mockResolvedValueOnce({
        items: [
          { id: 'request-message', type: 'text', position: 'right', content: {} },
          { id: 'error', type: 'tips', position: 'center', status: 'error', content: { content: 'provider failed' } },
        ],
        has_more_after: false,
      });
    const service = createWorkflowAgentService({ request: request as Request, capture: async () => new Map() });
    await expect(service.generateMessage('chat', 'repo', ['a.cpp'], fields, '')).rejects.toMatchObject({
      reasonCode: 'agentFailed',
      message: 'provider failed',
    });
  });
});
