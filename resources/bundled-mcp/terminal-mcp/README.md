# Woody terminal MCP

Runs with the bundled managed Node runtime, with no package installation or network request.
It needs Node.js 22 or newer for the global `WebSocket` client; bundle verification rejects an older runtime.
`AIONUI_TERMINAL_PORT` and `AIONUI_TERMINAL_TOKEN` are inherited from Woody at backend startup.
Settings > Tools > AI serial access controls authorization across all chats using
`woody-terminal`: **Ask** (default) confirms control of a serial connection once per MCP
connection; **Automatic** allows saved serial profiles without a prompt. The preference
persists in the terminal profile document. It does not change which tools a chat has loaded.

For serial work, call `terminal_profiles`, then `terminal_open` with a `profileId`, then
`terminal_read` / `terminal_send` with the returned connection `id`. No ticket is required.
An existing open serial connection can also be accessed by `connectionId` from `terminal_list`.
Reading, or opening a port that is already open, only observes it: manual input keeps working
until the AI first sends, cancels, interrupts or closes, and one approval covers both steps.
Metadata discovery never opens or probes a device. Requests to control a port already owned
by another AI are rejected. Prompts expire after one minute and are cancelled on disconnect.
Switching modes revokes existing policy grants and cancels pending approval requests.

Manual takeover cancels AI writes/waits and blocks automatic reacquisition, including from
other MCP processes. Click **Allow AI access** in either terminal panel to allow a new
policy request without a chat ticket or reconnect. Already-issued native writes may still
complete. Authorized readers can inspect retained history after takeover or disconnect.

Shell access keeps the explicit **Hand to AI** workflow in the conversation terminal panel.
Legacy tickets remain compatible for both shell and serial: claim within five minutes;
the ticket binds to its first MCP process and expires on disconnect or Woody restart.
These explicit grants retain read access after manual takeover.

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
