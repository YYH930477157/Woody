# GDB Workbench

The CMake workbench has Build and Debug tabs. Opening Debug only reads the shared session status. GDB starts after the user selects Start debugging or an authorized AI requests a start.

## Local setup

Install a compatible GDB locally. Set the GDB executable in Debug, or leave it empty for local discovery. Use a Debug build with symbols and select the executable and arguments in the saved CMake configuration. Arguments use one line per argument. The Save toolbar button saves these settings without starting a debugger, ready for a later manual or AI start. Start debugging also saves the current configuration first; a save failure prevents launch.

The debugger launches the selected executable from its CMake build directory. It does not attach to existing processes. Only one GDB session can run in the application. Builds and debugging cannot run concurrently for the same project. Configuration and build controls remain disabled while that project's debugger is active.

## Session controls

The toolbar offers start, stop, pause, continue, step over, step into, and step out. Control availability follows the shared session state: starting, running, paused, stopping, exited, or failed. The UI and authorized AI operate on the same session. Every control request includes its session ID so an old panel cannot control a replacement session.

While paused, add breakpoints using a symbol or `file:line`, remove existing breakpoints, and refresh the call stack and local variables. Watches accept variable names, member access, and numeric array indices. Function calls, assignments, arbitrary debugger console commands, memory writes, and attach are unavailable.

Memory reads require a hexadecimal address such as `0x00401000` and a count from 1 to 256 bytes. Watches, stack, locals, and memory refresh manually while paused. Readings become unavailable when execution changes revision or session, including when it resumes; they must be refreshed after the next pause. Debug output is separate from build output and retains a bounded recent tail of at most 65,536 characters.

## AI access

AI debug access is a separate per-project switch from build access. It is disabled by default and lasts only for the current application lifetime. Enabling it authorizes the same limited operations available in the Debug tab. Project configuration stores the GDB executable path; AI access is not written to project configuration.

Save the debug configuration, enable AI debug access, then create a new chat and select `woody-cmake` in its MCP selector. Existing chats keep their original MCP selection. The access switch grants access to all MCP chats using this tool for the project, rather than to one chat. Turning the switch off revokes AI access but does not stop an existing debug session; use Stop debugging separately.

## Validation

Focused renderer tests cover save-before-start, failed saves, shared-session build locking, stale watch invalidation, and late replies after a project switch. The local ignored `docs/superpowers/qa/check-gdb-ui.cjs` fixture renders the actual panel at desktop and mobile widths and checks the inspection controls and horizontal overflow. It uses explicit simulated replies; real GDB process validation belongs to the service tests and local smoke checks.
