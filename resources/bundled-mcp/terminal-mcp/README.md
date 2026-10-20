# Woody terminal MCP

Runs with the bundled managed Node runtime, with no package installation or network request.
It needs Node.js 22 or newer for the global `WebSocket` client; bundle verification rejects an older runtime.
`AIONUI_TERMINAL_PORT` and `AIONUI_TERMINAL_TOKEN` are inherited from Woody at backend startup.
The private bridge additionally requires a temporary user grant for every operation.
Select `woody-terminal` when creating a conversation, then grant a connection/profile from
the terminal panel. Claim a new ticket within five minutes; it then binds to its first
MCP process and expires on disconnect. Restarting Woody invalidates all tickets.
Manual takeover cancels AI writes/waits and retains read access for that lease.

Native SerialPort and node-pty modules run only in Electron and are packaged separately.

Each connection retains up to 4 MiB of raw data, 8,192 detailed data events and
4,096 empty status events. Highly fragmented streams can evict older records before
the byte limit. Always inspect `lost` and `more`; export only includes retained data.
The desktop view displays a smaller recent window and does not consume MCP cursors.

Serial HEX accepts arbitrary bytes. Shell input must be valid UTF-8, including when
entered as HEX; unsupported binary input is rejected before writing. Shell output is
a linear event log with ANSI styling removed, rather than a full terminal emulator
for applications that redraw the screen.

If a cancelled write returns `writePending`, the native write was already issued
and may still complete. Inspect subsequent outgoing history before sending again.
No cancellation or manual takeover can retract bytes already passed to the device.
