# Woody CMake workbench

Woody uses the installed Windows CMake/CTest and MinGW tools. It does not download
or bundle a compiler. Open a project conversation and select the build icon next
to the terminal icon in the conversation header.

## Project setup

The conversation workspace must contain `CMakeLists.txt`. Woody reads
`cmake-variants.yaml` or `.yml` at the project root or in `.vscode` (one file only).
Supported choice fields are `short`, `long`, `buildType`, scalar `settings`, and
string `env`; dimensions have `default`, `choices`, and optional labels. Unknown
fields, unknown selections and conflicting settings produce explicit errors.
Without a variants file, Debug and Release are provided. CMake presets and VS Code
kits/settings are not imported.

If a branch switch removes saved variants, the panel shows a warning and the
current defaults for those selections. Review and save the choices before an AI
build; inspection itself never overwrites your saved settings.

The virtual meter's buildType, meterType and CustomBuildType choices come from
its YAML. Woody does not invent macro names. `USE_WINDOWS_OS`, `DEBUG_MODE`,
`-m32`, and firmware-specific options remain the project's responsibility.

## Installed tools

Leave executable paths empty for PATH detection, or enter absolute paths to
`cmake.exe`, `ctest.exe`, `gcc.exe`, `g++.exe`, and `mingw32-make.exe`. CTest is
also searched beside CMake; G++ and make are searched beside GCC. Paths containing
spaces are supported. No shell command strings are used.

Check tools verifies CMake >= 3.5, tool availability, and a real C/C++ compilation
and link probe as appropriate for the project. With the default 32-bit option,
probes use `-m32` and their PE headers must be x86. The probe is never executed.
A 64-bit GCC installation may lack the required 32-bit runtime libraries.

Configure uses the `MinGW Makefiles` generator and sets
`CMAKE_EXPORT_COMPILE_COMMANDS=ON`. Build configures first. Outputs are isolated in
`build/woody/<configuration-hash>/`; selections, effective settings and toolchain
identity affect the hash. The exact directory is shown in the panel and AI tool
results. `compile_commands.json` remains there; point clangd at that directory.
Woody does not copy it over a project-owned file.

CTest runs in the selected configured directory. Build the UnitTest variant
first. Zero discovered tests is an error, and failed tests retain their output.
Builds use a single active-operation lock per project, shared by all panels and
AI calls. Cancel terminates the process tree; already generated files remain.
Logs are bounded and older output may be discarded.

Settings are saved per canonical project under the Woody user data directory
(`%APPDATA%/AionUi/cmake/projects`), outside the source tree. The panel saves
current edits before starting an action. Settings cannot be changed through MCP.

## AI access

Select `woody-cmake` for a new conversation and enable AI access for the project
in the build panel. Enabling the MCP in Settings alone does not attach it to an
existing conversation. All selected MCP sessions can access enabled projects;
the toggle is project-scoped, not an exclusive grant to the current chat.
Access resets when Woody exits. Disabling access blocks subsequent AI calls;
cancel a running job separately if it should stop.

The AI uses `cmake_projects`, `cmake_inspect`, `cmake_start`, `cmake_read`, and
`cmake_cancel`. Start returns a job ID promptly. Read reports running/succeeded/
failed/cancelled and incremental logs. After a timeout, inspect the latest job
before retrying a start. GUI and AI always see the same job.

## Running the virtual meter

Set the executable path relative to the displayed build directory, for example
`bin/meter.exe`. Supply one argument per line. Run captures stdout/stderr until
exit, cancellation or timeout. Only a Windows executable inside that configured
build directory can run. With 32-bit verification enabled, it must be x86.
This runner has no interactive stdin, window automation or register decoder.

CMake and CTest do not read meter business registers. The workbench's Debug tab
uses installed GDB to read values, status bits and configuration represented by
variables or memory in the virtual meter process; see `gdb-workbench.md`.
CLI or serial/TCP access is an alternative when the virtual meter exposes those
interfaces. A successful build or an exit code of zero does not establish meter
accuracy or register correctness.

## Validation boundary

Automated tests use temporary projects and controlled process fixtures, including
real process-tree cancellation. The actual offline firmware, its variants file,
32-bit MinGW runtime and business-register interface must be tested on the target
computer. No firmware-specific register address or protocol is assumed here.
