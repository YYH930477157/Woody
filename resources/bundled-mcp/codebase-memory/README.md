# Woody Codebase Memory bundle

This directory carries the Woody project adapter, its skill, and the pinned
DeusData `codebase-memory-mcp` **v0.12.1** runtime. The current native target is
**Windows x64**. Other targets explicitly skip preparation and the feature is
unavailable there.

## Use in Woody

Open a project's **Architecture** tab, enable Codebase Memory, select an index
mode, and save. **Initialize / update index** runs the local indexer; the panel
shows its state and allows cancellation. Each project folder stores its own
configuration:

```json
{
  "version": 1,
  "enabled": true,
  "mode": "fast"
}
```

This file lives at `<project>/.woody/codebase-memory.json`. The generated database
stays in the user's local application cache, outside the source repository.
Projects without the configuration are disabled by default. Until a mode is saved,
a folder whose sources are mostly C or C++ starts in `full`, the only mode that
indexes macros; other folders start in `fast`.

After indexing succeeds, **Open visualization** launches the bundled **CBM Lens**
in your default browser. It uses a local `127.0.0.1` port and the selected project's
existing index; it does not download assets or start indexing. Repeated opens
reuse the project's service. Disabling the feature or quitting Woody closes its
Lens client. The native interface also provides its own index-management controls.
Use Woody's **Initialize / update index** to keep the panel's progress in sync.

Both `CBM_CACHE_DIR` and `CBM_RUNTIME_DIR` are bound to each project's cache directory.
The runtime directory isolates native daemons between projects. Version 0.12.1
does not implement `CBM_NO_DAEMON`; setting only that variable cannot provide isolation.

Create a new project conversation after enabling the feature. Woody attaches
the project's MCP tools and architecture skill unless you explicitly deselect
them. Existing conversation snapshots keep their original tool selection. The
skill asks the AI to inspect architecture and change impact before substantial
edits and check index freshness afterward; model compliance is not guaranteed.
This integration uses the existing Core MCP and skill APIs.

## Reproduce the native bundle

From the repository root, run:

```powershell
$env:AIONUI_CODEBASE_MEMORY_ARCHIVE = 'D:\downloads\codebase-memory-mcp-windows-amd64.zip'
node scripts/bundled-mcp/prepareCodebaseMemory.js win32 x64
```

The archive override is optional. If no verified cached bundle exists and no
override is set, the build helper downloads the fixed release URL from
`manifest.json`. It honors `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, and
`http_proxy`; for example `http://127.0.0.1:7890`. No proxy is hardcoded.
An explicitly supplied missing or mismatched archive fails the build; it never
falls back to another source. Both archive and executable SHA256 must match
the tracked manifest. Downloads and extraction happen only during build
preparation, never when an installed application starts or enables a project.

`scripts/build-with-builder.js` invokes preparation before compilation and
packaging, including `--skip-vite` and `--pack-only`. The existing electron-builder
`bundled-mcp` resource rule copies this directory recursively. The large native
binary is ignored by Git and is reproduced at:

```text
bin/win32-x64/codebase-memory-mcp.exe
```

Preparation copies only the verified executable and redistribution notices;
the upstream `install.ps1` is never copied or executed. No system-wide MCP
registration is performed. Missing required resources cause Windows x64 build
preparation to fail with a clear message.

## Runtime contract

`index.cjs` and `runtime.cjs` provide a project-bound stdio adapter. Its curated
schemas are in `tools.json`. Project enablement and index mode are saved in
`.woody/codebase-memory.json`. `skills/woody-codebase-memory/SKILL.md` is imported
as `woody-codebase-memory` for selected project sessions. Import copies the skill,
so the first project session of each app run imports it again and an older copy
in the library is replaced. The dedicated skill
directory excludes the native executable and other runtime resources, because
Core imports the skill's entire parent directory. The skill is guidance for the model, not an execution
guarantee. The adapter is responsible for enforcing project boundaries and
disabling unsupported capabilities.

The indexer prefixes every qualified name with the project name, so the name is
short: the folder name in lowercase ASCII plus 8 hex characters of the path hash
(`code-affc6c50`). The cache directory keeps the full-hash name `woody-<sha256>`,
so the saved status survives. An index stored under the old full-hash name is
reported as not indexed and deleted after the next successful index.

Every native command starts through PowerShell 7 when `pwsh.exe` is on `PATH` or
in `%ProgramFiles%\PowerShell\7`, because encrypted disks can restrict plain file
content to listed programs. Without PowerShell 7 the command runs directly and the
panel says so. After an index, sample source files are read through PowerShell and
compared with a direct read. If they differ and the graph holds none of the symbols
in the plain text, the index fails with reason `unreadable` instead of reporting
success. Whether a program started by PowerShell also receives plain content depends
on the encryption product. No decrypted copy of the source is ever written to disk.

Before an index starts, a few source files are read the same two ways. When
PowerShell reads text and this process reads different, unreadable bytes, the run
is refused within a second (`precheckRefused`), instead of letting the indexer
spend minutes on ciphertext and crash. Identical bytes never count as encryption,
however they decode; GBK and UTF-16 sources are text. The probe reads with Woody or
`node`, not with the indexer, so it cannot tell whether `codebase-memory-mcp.exe`
itself is on the encryption whitelist. The panel's Index anyway skips it once; when
that index proves the indexer read symbols only PowerShell could see, the status
keeps `indexerReadsPlain` and later runs, including MCP calls, skip the probe until
an index reads ciphertext again. A failed run is published only after its
diagnostics report is written, so a status never shows `failed` without its reason.

The indexer skips folders by name (`obj`, `tmp` and `dist` in every mode; `build`,
`tools`, `scripts`, `thirdparty` and more in fast and moderate), matching the exact,
case-sensitive name, as well as everything `.gitignore` excludes. After each successful
index, `check_index_coverage` with scope `.` lists every skipped folder (the index
summary stops after five). Woody keeps the ones that have an offered name and hold
source files, counted by file name only, in `skippedSources`. The panel's Include in
index appends `!/<folder>/` to the project's `.cbmignore` as bytes, so the file keeps
its encoding and line endings, and indexes again. A `.cbmignore` rule cannot override
`.gitignore`; such a folder stays listed as `requested`. When Woody cannot read
`.cbmignore` as text, for example because it is encrypted for Woody, the folder is
marked `manual` and the panel shows the line to add by hand.

The panel's architecture file button writes `.woody/architecture.md` without a model
(`architecture.cjs`, headings from `architecture-labels.json` in the panel's language).
One `query_graph` call reads every function with its file and lines; `query_graph` is
used only inside Woody and is not offered to the model. Woody then reads the source
itself and finds the FreeRTOS tasks (`xTaskCreate`, `xTaskCreateStatic`,
`osThreadNew`), what they wait on and call, and every array of functions a loop
calls one by one, up to three calls deep from each task and from the product's `main`.
Each table is listed in order with its `#if` conditions and comments. Entries whose
function is not in the index keep their place and are marked. A module matrix shows
which tables each module registers in, and which modules differ from most. Once the
file exists, every successful index updates it. Only the part between the
`woody:generated` markers is rewritten, so the team's Change rules section is kept.
A file Woody cannot read as UTF-8, or one without the markers, is never overwritten.
The skill's description tells the model to read the file before changing code.

## Provenance and redistribution

- Upstream repository: `https://github.com/DeusData/codebase-memory-mcp`
- Version, release URL, supported target, and archive/executable hashes:
  `manifest.json`.
- Upstream license: MIT, copyright (c) 2025 DeusData, verbatim in `LICENSE`.
- Upstream binary dependencies and verbatim license/notice texts:
  `THIRD_PARTY_NOTICES.md`, copied unmodified from the same verified release ZIP.
- Woody adapter and build integration are local additions. The native executable
  is the unmodified upstream release asset, not a local rebuild.

When upgrading, review the upstream tool schema and adapter policy together,
update both pinned hashes, retain the complete new notices, and repeat bundle
and offline runtime verification. Do not replace the asset with an unverified
executable or run the upstream installer.
