# Git Static Scan Workflow

This workflow is maintained in `YYH930477157/Aionui2`. It uses the current
conversation and the files selected in the Changes panel.

## Submission Flow

1. Select the files to include. When the active AI turn finishes successfully,
   the dialog can generate a five-field commit message draft automatically.
   The **Generate commit message** action also starts this step manually.
2. Review and edit the message. Select **clang-tidy**, **PC-lint**, and/or
   **Compile verification**, then choose **Run checks**. All three may be
   unchecked; the button then reads **Continue to commit**.
3. **AI repair** is a separate option, effective only for selected scanners.
   When enabled, diagnostics are sent as a repair request in the same conversation,
   with at most two attempts and a rescan after each. When disabled, diagnostics
   block confirmation so you can resolve them manually or change the options.
4. Actual file contents, including preexisting dirty files, are compared during
   each AI task. Changes outside the selection, staging, and Git HEAD or branch
   changes block submission. Local modifications are preserved for inspection.
   Ignored build artifacts are excluded from the content comparison.
5. If selected, compilation builds the original project after scanning completes.
   Compilation can also run alone. Unselected checks do not run.
6. Explicitly confirm the commit and push. Files, HEAD, and branch must still
   match the prepared snapshot, including when every check was skipped.
   Skipping checks is not a successful scan or build. Review the commit message's
   test steps to reflect what you actually verified.

## Per-Repository Check Selection

The commit dialog loads its choices from `<repository-root>/.woody/static-scan.json`.
Each Git repository or worktree has its own file, including nested repositories
inside one workspace. Choices are saved when you click **Run checks** or
**Continue to commit**, before the Git snapshot is captured:

```json
{
  "commitChecks": {
    "scanners": ["clang-tidy", "pc-lint"],
    "compile": true,
    "autoRepair": false
  },
  "clangTidy": {
    "scope": "selected",
    "arguments": [],
    "compileCommandsPath": "build"
  },
  "pcLint": {
    "scope": "selected",
    "arguments": ["project.lnt"]
  }
}
```

Use `"scanners": []` to skip both scanners. Set `"compile": false` as well to
skip all checks. `autoRepair` is retained but has no effect without scans.
When `commitChecks` is absent, the dialog selects scanners whose project settings
exist and enables compilation and AI repair, preserving the earlier defaults.
When present, all three fields are required: `scanners` is an array containing
zero, one or both supported names without duplicates; the other fields are booleans.

clang-tidy and PC-lint perform C/C++ static analysis using their configured rules
and arguments. They do not imply a separate security scan or test suite.
Compilation uses the IAR/CMake discovery or explicit command described below;
the automatic build does not run unit tests.

Configure scanner executables in the machine settings (`static-scan-tools.json`
under user data), or supply a project scanner's `executablePath` override.
Selecting an unconfigured scanner reports an error instead of silently skipping it.
Saving choices preserves existing build commands, scanner arguments and other JSON
fields, and does not copy machine paths into the project file. Unreadable or invalid
project JSON and failed saves are reported; checks do not start on those errors.
Repair the file and reopen the dialog to reload it.

Changing choices after checks finish invalidates the previous confirmation. Closing
without continuing does not save changed choices. The config file remains an ordinary
Git change: select it explicitly if you want to commit and share these preferences.

## Commit Message Template

The generated draft follows this fixed five-line format. The values can be
edited before scanning, but the final commit message keeps these labels and
order:

```text
【修改原因】:【BUG[x]|REQ[x]|OPT】说明修改原因
【修改范围】:【协议栈|驱动|计量|费率|继电器|负控|升级|时钟|显示|结算|曲线|需量|预付费|电网质量|事件|状态字|P2P|PLC|MBUS|生产协议|文档|工具|打印|$...】
【修改方案】: 简要说明修改方案
【影响评估】:【EEPROM|DATAFLASH|LEGAL|兼容性|效率|其他|无影响】具体影响内容
【测试步骤】: 简要说明自测试步骤及结果
```

`BUG[x]` and `REQ[x]` use `x` when there is no PMS number. The scope must be
one functional module, never a file name or file list; a custom module must
start with `$`. If there is no impact, the impact field is exactly `【无影响】`.
The AI returns the text after each colon. If a model response or manual edit
includes an outer label again, the workflow removes the duplicate and
normalizes the required category before commit.

If repair attempts are exhausted, fix the diagnostics manually and start the
scan again. Build failures retain diagnostics, command output, and local
modifications in the dialog. A failed push retains the local commit for retry.
The dialog can be closed while AI is working so that permission requests can be
handled in the conversation.

## Project Build Configuration

The `build` object in `.woody/static-scan.json` takes priority over discovery.
Commands are executed directly with an argument array, without a shell:

```json
{
  "build": {
    "executable": "cmake",
    "arguments": ["--build", "build", "--config", "Debug"],
    "cwd": ".",
    "timeoutMs": 600000
  }
}
```

For shell commands, configure the shell executable and its argument array
explicitly. Relative paths are resolved from the repository root.

Select a detected build system and project explicitly when needed:

```json
{
  "build": {
    "system": "iar",
    "project": "firmware/iar/application.ewp",
    "configuration": "Debug"
  }
}
```

```json
{
  "build": {
    "system": "cmake",
    "project": ".",
    "buildDirectory": "build",
    "configuration": "Debug"
  }
}
```

Without an explicit command, discovery searches the repository root and up to
six directory levels, excluding `.git`, `.woody`, `node_modules`, `vendor`,
`out`, `dist`, `target`, and `build`. Symlink directories are not traversed.

- IAR: detect `.ewp` files and invoke `IarBuild <project> -build <configuration>`.
  The default configuration is `*` (all configurations).
- CMake: detect `CMakeLists.txt`; a root project owns its nested subprojects.
  Run `cmake -S <project> -B <buildDirectory>`, followed by
  `cmake --build <buildDirectory>` and optional `--config <configuration>`.
- Multiple systems or multiple candidate projects require an explicit choice.
  Missing configuration/tools, timeouts, and command failures block submission.

The default timeout is ten minutes per build command. Project paths and build
directories must stay inside the repository. Scanner configuration (`clangTidy`
and `pcLint`) remains in the same JSON file; machine tool paths remain in the
existing machine settings. Commit workflows always restrict scans to selected
paths, even if a standalone scanner configuration uses repository scope.
