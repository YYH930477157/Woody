# Woody CMake MCP

Dependency-free stdio adapter to the desktop build service. No network downloads
or separately installed Node packages are needed. Woody publishes a loopback
port and private token to its managed MCP subprocesses at startup.

Select `woody-cmake` when creating a conversation. Open the build panel for the
project, configure the installed tools, and enable AI access. All conversations
with this MCP can use enabled projects until access is disabled or Woody exits.
Disabling access blocks further calls; cancel an existing build separately.

Tools: `cmake_projects`, `cmake_inspect`, `cmake_start`, `cmake_read`,
`cmake_cancel`. Starts return job IDs; inspect the job before retrying after a
connection timeout. GUI and AI share jobs, logs and project locks.

`check` reports each installed tool's executable path and version even when the
variant configuration cannot be read. It does not configure the project or test
32-bit linking. `configure` and `build` retain the actual compiler/link probes.
Project inspection includes configuration diagnostics and the effective reader.
The desktop's saved reader and encoding settings also apply to MCP calls.
Automatic reading can retry access/decoding failures through installed PowerShell
7; this does not rewrite source files or grant encryption-system permissions.

The same MCP exposes `gdb_projects/start/status/stop/pause/continue/next/step/finish`,
`gdb_breakpointAdd/breakpointRemove`, and `gdb_evaluate/memory/stack/locals`.
Enable the separate AI debugging switch in the Debug tab. All conversations with
this MCP share the authorized debugger. Disabling access blocks future calls;
stop an existing debug session separately. Debugging locks the selected project
against builds and configuration changes. One GDB process is allowed globally.

GDB launches only the executable/arguments saved in the panel. It reads business
registers represented by variables or memory in the virtual meter process;
CMake itself does not provide register access. Debug symbols and actual source
names are required. Values are read only while stopped. There is no attach,
arbitrary debugger console, function calling, variable writing or physical device
access. Output is bounded to 65,536 characters; memory reads to 256 bytes.
GDB is detected beside GCC/on PATH or set manually; it is not bundled/downloaded.
