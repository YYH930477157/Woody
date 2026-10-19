import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '../../../packages/desktop/src/common/adapter/httpBridge';
import { deliverTerminalGrant } from '../../../packages/desktop/src/process/bridge/terminal/terminalGrantDelivery';

vi.mock('../../../packages/desktop/src/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));

describe('conversation terminal grants', () => {
  beforeEach(() => vi.mocked(httpRequest).mockReset());
  it('does not deliver a ticket to a conversation without the selected MCP snapshot', async () => {
    vi.mocked(httpRequest).mockResolvedValue({ extra: { mcp_servers: ['aionui-todo'] } });
    await expect(deliverTerminalGrant('chat', 'secret', 'zh-CN')).rejects.toThrow('terminal.mcpNotSelected');
    expect(httpRequest).toHaveBeenCalledTimes(1);
  });
  it('delivers only to the user-selected conversation with a terminal snapshot', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce({ extra: { mcp_servers: ['woody-terminal'] } })
      .mockResolvedValueOnce({});
    await deliverTerminalGrant('selected-chat', 'private-ticket', 'zh-CN');
    expect(vi.mocked(httpRequest).mock.calls[1]).toEqual([
      'POST',
      '/api/conversations/selected-chat/messages',
      { content: expect.stringContaining('private-ticket') },
      { sensitiveBody: true },
    ]);
  });
  it('propagates rejection so the caller can revoke an undelivered capability', async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce({ extra: { session_mcp_servers: [{ name: 'woody-terminal' }] } })
      .mockRejectedValueOnce(new Error('busy'));
    await expect(deliverTerminalGrant('chat', 'secret', 'en-US')).rejects.toThrow('busy');
  });
});
