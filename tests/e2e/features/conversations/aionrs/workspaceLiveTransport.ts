import http from 'node:http';
import https from 'node:https';

export type WorkspaceRequestEvidence = {
  model?: string;
  workspace: string[];
  status?: number;
  error?: string;
  elapsedMs?: number;
};

/** Forward to the configured real provider; retain only workspace metadata, never credentials. */
export async function captureWorkspaceRequests(baseUrl: string): Promise<{
  baseUrl: string;
  evidence: WorkspaceRequestEvidence[];
  close: () => Promise<void>;
}> {
  const upstream = new URL(baseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('Unsupported provider transport');
  const evidence: WorkspaceRequestEvidence[] = [];
  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    const item: WorkspaceRequestEvidence = { workspace: [] };
    evidence.push(item);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const payload = JSON.parse(body.toString('utf8')) as {
        model?: string;
        messages?: { role: string; content: unknown }[];
      };
      item.model = payload.model;
      item.workspace = (payload.messages ?? [])
        .filter((message) => message.role === 'system' && typeof message.content === 'string')
        .flatMap((message) => String(message.content).match(/<current_workspace>[\s\S]*?<\/current_workspace>/g) ?? []);
      const target = new URL(upstream.origin);
      // Preserve the route produced by the real provider adapter, including full-URL configurations.
      target.pathname = new URL(request.url!, 'http://localhost').pathname;
      target.search = new URL(request.url!, 'http://localhost').search;
      const forward = (upstream.protocol === 'https:' ? https : http).request(
        target,
        { method: request.method, headers: { ...request.headers, host: upstream.host } },
        (incoming) => {
          item.status = incoming.statusCode;
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
          incoming.on('end', () => {
            item.elapsedMs = Date.now() - started;
          });
          incoming.on('error', () => response.destroy());
        }
      );
      forward.on('error', (error: NodeJS.ErrnoException) => {
        item.error = error.code || 'transport_error';
        item.elapsedMs = Date.now() - started;
        if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Live test upstream transport failed' } }));
      });
      forward.setTimeout(90_000, () => forward.destroy(new Error('Live upstream timeout')));
      response.on('close', () => {
        if (!response.writableFinished) forward.destroy();
      });
      forward.end(body);
    } catch {
      item.error = 'capture_error';
      response.writeHead(502);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Capture server address unavailable');
  const local = new URL(baseUrl);
  local.protocol = 'http:';
  local.hostname = '127.0.0.1';
  local.port = String(address.port);
  return {
    baseUrl: local.href,
    evidence,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
