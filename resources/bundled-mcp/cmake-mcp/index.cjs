'use strict';

const readline = require('node:readline');
const port = Number(process.env.AIONUI_CMAKE_PORT);
const token = process.env.AIONUI_CMAKE_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || typeof fetch !== 'function') {
  console.error('Woody CMake service unavailable. Restart Woody with its managed Node runtime.');
  process.exit(1);
}
const string = { type: 'string' };
function tool(action, description, properties, required = []) {
  return {
    name: `cmake_${action}`,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  };
}
const tools = [
  tool(
    'projects',
    'List projects enabled for AI in the Woody build panel. Access lasts until disabled or Woody exits.',
    {}
  ),
  tool(
    'inspect',
    'Read project variants, saved tool paths, selected build directory and latest job. Does not build.',
    { projectPath: string },
    ['projectPath']
  ),
  tool(
    'start',
    'Start one check/configure/build/test/run job using the shared desktop service. Check only reports installed tool paths and versions, works with unreadable variants, ignores variant selections, and does not prove 32-bit compilation support. Configure and build validate compiler linking; build configures first. Run uses only the executable and arguments saved in the panel; this is not register inspection. Read returned job ID until terminal status. Do not repeat a timed-out start without inspecting latestJob.',
    {
      projectPath: string,
      operation: { type: 'string', enum: ['check', 'configure', 'build', 'test', 'run'] },
      selection: {
        type: 'object',
        additionalProperties: string,
        description: 'Variant dimension names and choice IDs returned by inspect.',
      },
    },
    ['projectPath', 'operation']
  ),
  tool(
    'read',
    'Read shared job status and incremental output. Pass returned cursor on subsequent reads; truncated means older output was discarded. Build success alone does not prove simulation correctness.',
    { jobId: string, cursor: { type: 'integer', minimum: 0 } },
    ['jobId']
  ),
  tool(
    'cancel',
    'Cancel a shared job and stop its process tree. Already written build files remain.',
    { jobId: string },
    ['jobId']
  ),
];
const debugContext = {
  projectPath: string,
  sessionId: {
    type: 'string',
    description: 'Current session ID returned by gdb_start/status. Never reuse an old session ID.',
  },
};
function debugTool(operation, description, properties = {}, required = [], session = true) {
  const entry = tool(operation, description, { ...(session ? debugContext : {}), ...properties }, [
    ...(session ? ['projectPath', 'sessionId'] : []),
    ...required,
  ]);
  entry.name = `gdb_${operation}`;
  return entry;
}
tools.push(
  debugTool(
    'projects',
    'List projects with separate AI debugging access enabled in the Woody Debug tab. Build permission alone does not authorize debugging.',
    {},
    [],
    false
  ),
  debugTool(
    'start',
    'Launch the saved executable and arguments under GDB and stop at main. Uses the selected saved CMake variant; build it with debug symbols first. Returns starting state: poll gdb_status until stopped or failed. One debugger globally, shared with the UI; no automatic rebuild. Inspect status before retrying after timeout.',
    { projectPath: string },
    ['projectPath'],
    false
  ),
  debugTool(
    'status',
    'Read shared debugger state, stop reason, source frame, breakpoints and bounded output without launching a process. Inspect only while stopped. Values describe this simulated process, not a physical meter.',
    { projectPath: string },
    ['projectPath'],
    false
  ),
  ...[
    ['stop', 'Terminate the owned debugger and virtual meter process tree, releasing the build lock.'],
    ['pause', 'Interrupt the running virtual meter. Poll status until stopped before reading values.'],
    ['continue', 'Resume the paused virtual meter until its next breakpoint or exit.'],
    ['next', 'Step over one source line while stopped. Poll status for the next stop.'],
    ['step', 'Step into one source line while stopped. Poll status for the next stop.'],
    ['finish', 'Step out of the current function while stopped. Poll status for the next stop.'],
    ['stack', 'Read up to 20 stack frames at the current stop.'],
    ['locals', 'Read up to 100 current-frame local variables at the current stop.'],
  ].map(([operation, description]) => debugTool(operation, description)),
  debugTool(
    'breakpointAdd',
    'Add a breakpoint while stopped. Use an actual symbol or source file:line from the project; never invent symbols.',
    { location: string },
    ['location']
  ),
  debugTool('breakpointRemove', 'Remove a breakpoint created in this shared session.', { number: string }, ['number']),
  debugTool(
    'evaluate',
    'Read a business/simulated register represented by a C/C++ variable path at the current stop, e.g. meter.status, ptr->value, registers[3]. Names must come from actual source/symbols. Calls, assignments, operators and CPU register expressions are not accepted; inferior function calls are disabled.',
    { expression: string },
    ['expression']
  ),
  debugTool(
    'memory',
    'Read 1..256 bytes from a known hexadecimal address in the stopped virtual meter process. The result is raw bytes; apply the actual project layout and endianness. Does not read physical hardware.',
    {
      address: { type: 'string', pattern: '^0x[0-9a-fA-F]{1,16}$' },
      count: { type: 'integer', minimum: 1, maximum: 256 },
    },
    ['address', 'count']
  )
);
const names = new Set(tools.map((entry) => entry.name));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let active = 0;
input.on('line', (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || message.id === undefined) return;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    try {
      if (line.length > 65536) throw new Error('Request too large');
      if (message.method === 'initialize') {
        reply({
          protocolVersion: message.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'woody-cmake', version: '1.1.0' },
        });
      } else if (message.method === 'ping') reply({});
      else if (message.method === 'tools/list') reply({ tools });
      else if (message.method === 'tools/call') {
        if (!names.has(message.params?.name)) throw new Error('Unknown CMake tool');
        if (active >= 8) throw new Error('Too many pending CMake requests');
        active++;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/cmake`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(
              message.params.name.startsWith('gdb_')
                ? message.params.name === 'gdb_projects'
                  ? { action: 'debugProjects' }
                  : {
                      action: 'debug',
                      request: { ...message.params.arguments, operation: message.params.name.slice('gdb_'.length) },
                    }
                : { ...message.params.arguments, action: message.params.name.slice('cmake_'.length) }
            ),
            signal: AbortSignal.timeout(30000),
          });
          const body = await response.json();
          if (!response.ok || body.error) throw new Error(body.error || `CMake service HTTP ${response.status}`);
          reply({ content: [{ type: 'text', text: JSON.stringify(body.result) }] });
        } finally {
          active--;
        }
      } else {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) +
            '\n'
        );
      }
    } catch (error) {
      reply({ isError: true, content: [{ type: 'text', text: error.message || String(error) }] });
    }
  })();
});
