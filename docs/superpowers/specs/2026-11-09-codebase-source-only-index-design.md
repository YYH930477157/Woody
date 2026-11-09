# Codebase Memory Source-Only Indexing

## Problem

The bundled codebase-memory indexer currently scans untracked files in Git
repositories and can retain test files as graph nodes. Query-time filters hide
some test edges, but `search_graph` can still return those nodes. This makes
the index contain files that are not product source code.

## Goals

- In a Git repository, index only Git-tracked files that pass the existing
  source-language and directory filters.
- Exclude test directories, test-named files, build output, generated files,
  scripts, vendor content, and temporary directories during initialization.
- Keep tracked-but-modified and tracked-but-staged source files indexable.
- Leave no permanent changes in the user's `.gitignore`, `.git/info/exclude`,
  or `.cbmignore`.
- In a non-Git project, preserve indexing and use the same source-only
  directory and filename filters without Git tracking enforcement.

## Non-goals

- Changing the native codebase-memory executable.
- Removing tests or generated files from the user's working tree.
- Changing query-time `include_tests` semantics for an already-built index.
- Adding a new user-facing configuration panel in this change.

## Behavior

For a Git project, the adapter establishes a temporary filter before starting
the native `index_repository` process:

1. Append a uniquely marked `*` rule to `.git/info/exclude`. Git's ignore
   machinery then hides untracked files while leaving tracked files visible.
2. Append uniquely marked rules to `.cbmignore` for test and non-product
   directories and test filename conventions. These rules also exclude files
   that are tracked by Git.
3. Start the native indexer with the existing project root and mode.
4. Restore both files byte-for-byte after the native operation settles,
   regardless of success, failure, cancellation, or startup error.

For a non-Git project, step 1 is skipped. The `.cbmignore` overlay still
provides the source-only filter, and the native indexer's existing extension
filter remains authoritative for supported languages.

The default overlay excludes these directory classes:

- Tests: `test`, `tests`, `__tests__`, `fixtures`, `testdata`, `test_data`,
  `e2e`, `integration`
- Build and generated content: `build`, `dist`, `obj`, `tmp`, `temp`, `out`,
  `target`, `generated`, `gen`
- Tooling and dependencies: `scripts`, `tools`, `vendor`, `vendored`,
  `third_party`, `thirdparty`

It excludes common test filename forms such as `*_test.*`, `test_*.*`,
`*.test.*`, `*.spec.*`, language-specific `_test` suffixes, and
`conftest.py`.

## Safety and recovery

The overlay manager records the original bytes and the exact marker bytes it
added. Cleanup removes only its own marker block when the file still contains
the expected overlay. If an external process changes an ignore file while the
index is running, cleanup preserves the external content and records a
warning instead of overwriting it.

If the adapter cannot safely establish or restore the overlay, it fails before
publishing a successful index and reports which file needs attention. A stale
overlay left by a terminated process is detected and removed during the next
index attempt only when its marker and ownership token match the adapter's
format.

The existing per-project index lock remains the serialization boundary for
Woody-owned index operations.

## Status and diagnostics

The current index status shape remains compatible. Native coverage output
continues to report excluded directories and files. The adapter adds a short
diagnostic line to the index log indicating whether Git tracking enforcement
was active and whether the source-only overlay was restored.

## Testing

- Unit tests cover:
  - Git repository detection and fallback for non-Git folders.
  - Marker creation and byte-for-byte restoration.
  - Preservation of unrelated user edits made during indexing.
  - Git-tracked modified files remaining eligible.
  - Overlay rule generation for test and intermediate paths.
- An integration-style runtime test uses a temporary Git repository and a
  fake native command to verify that untracked files are hidden while tracked
  files remain visible.
- The bundled native probe is repeated manually against a temporary Git
  repository to confirm that `src/untracked.c` and `tests/untracked_test.c`
  are absent while `src/tracked.c` remains searchable.
