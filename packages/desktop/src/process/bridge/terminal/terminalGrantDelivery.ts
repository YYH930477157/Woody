import { httpRequest } from '@/common/adapter/httpBridge';

/** Check the immutable conversation MCP snapshot before sending a temporary capability. */
export async function deliverTerminalGrant(conversationId: string, ticket: string, language: string): Promise<void> {
  const conversation = await httpRequest<{
    type?: string;
    extra?: { session_mcp_servers?: Array<{ name?: string }>; mcp_servers?: Array<{ name?: string } | string> };
  }>('GET', `/api/conversations/${encodeURIComponent(conversationId)}`);
  const servers = [...(conversation?.extra?.session_mcp_servers || []), ...(conversation?.extra?.mcp_servers || [])];
  if (
    !servers.some((server) =>
      typeof server === 'string' ? server === 'woody-terminal' : server.name === 'woody-terminal'
    )
  ) {
    throw new Error('terminal.mcpNotSelected');
  }
  const prompt = language.startsWith('zh')
    ? `我已授权你使用终端连接。请通过 woody-terminal 的 terminal_claim 工具领取临时票据 ${ticket}，查看连接后等待我的调试指令。不要主动发送设备报文或执行命令；手工接管后停止写入。`
    : `I granted access to a terminal connection. Claim temporary ticket ${ticket} using woody-terminal's terminal_claim tool, inspect the connection, then wait for my debugging instructions. Do not send device data or execute commands on your own; stop writes on manual takeover.`;
  await httpRequest(
    'POST',
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { content: prompt },
    { sensitiveBody: true }
  );
}
