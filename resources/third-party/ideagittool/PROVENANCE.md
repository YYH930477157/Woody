# IdeaGitTool source attribution

Upstream: PGshen/vs-idea-gittool (GitHub).
Imported source baseline: `8bd81d26dbb2997d021465f16fec6fc3656c3f38` (package version 0.4.2).

| Woody source                                                                          | Upstream source                                                                                                  | Adaptation                                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `common/git/graph.ts`                                                                 | `src/git/graph.ts`                                                                                               | Type imports and formatting                                                                                                              |
| `common/git/graphTypes.ts`                                                            | GraphRow/GraphEdge in `src/shared/types.ts`                                                                      | Extracted shared contracts                                                                                                               |
| `process/services/sourceControl/workbench/parsers.ts`                                 | `src/git/logStream.ts`, `src/git/repository.ts`                                                                  | Explicit contracts, host-independent parsing                                                                                             |
| `tests/unit/sourceControl/workbench/graph.test.ts`                                    | `test/graph.test.ts`                                                                                             | Vitest runner and import paths                                                                                                           |
| `common/git/merge/{mergeModel,mergeResolve,intellijDiff,lineDiff,l10n}.ts`            | Corresponding `src/shared/*.ts`                                                                                  | Source headers, type-only import, formatting; full-side acceptance corrected to preserve ignored whitespace                              |
| `tests/unit/sourceControl/workbench/merge/{mergeModel,mergeResolve,lineDiff}.test.ts` | Corresponding `test/*.test.ts`                                                                                   | Vitest runner and import paths                                                                                                           |
| `process/services/sourceControl/workbench/operations/`                                | `src/features/ops/engine.ts`, repository and stash operation semantics                                           | Typed Electron host adapters, validation, snapshot checks and shared operation coordination                                              |
| `process/services/sourceControl/workbench/operations/rewrite.ts`                      | `buildTodo`, `interactiveRebase`, `rewordCommit`, `squashCommits`, `dropCommits` in `src/features/ops/engine.ts` | Linear-only reviewed history, contiguous squash/fixup, message files, persistent recovery helpers, no autostash or automatic update-refs |

Paths in the first column are relative to `packages/desktop/src/` unless they start with `tests/`.
Original LICENSE and NOTICE accompany these sources. Woody-specific adapters and UI are maintained locally.

## Upstream declaration discrepancy

The pinned package.json and README declare Apache-2.0. However, the pinned LICENSE contains
“JETBRAINS OPEN-SOURCE BUILD TERMS”, version 1.3, rather than the Apache-2.0 license text.
This was verified against the pinned raw GitHub file on 2026-10-30. The copied LICENSE and
NOTICE are preserved verbatim; this provenance document does not resolve the discrepancy
or certify redistribution rights. Resolve the upstream declaration before publishing a
distribution containing imported source. Local implementation and verification are tracked
separately from release publication.
