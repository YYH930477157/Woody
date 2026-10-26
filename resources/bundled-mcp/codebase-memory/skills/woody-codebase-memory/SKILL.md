---
name: woody-codebase-memory
description: Use when understanding, debugging, reviewing, or meaningfully changing code in a Woody project with Codebase Memory enabled.
---

# Woody Codebase Memory

Use the project's local graph to understand architecture and change impact before a meaningful code edit. This skill guides model behavior; it is not an enforcement mechanism or proof that analysis happened.

## Project scope

The tools are bound to the current project. Its `.woody/codebase-memory.json` setting controls enablement and index mode. Never pass a different project, repository path, or configuration path, alter that setting to bypass a refusal, or use another project's index. Follow repository instructions and the user's requested scope. Do not install another server, register the upstream installer, or access unrelated projects to obtain results.

## Before editing

1. Call `index_status({})`. Confirm readiness and that the reported root matches this project. Status alone does not establish freshness: use `check_index_coverage({"paths":["src/example.ts"]})` for the actual files you will cite or edit. Substitute real project-relative paths.
2. If the index is missing, stale, or incomplete, report the limitation. Update through `index_repository({})` only when indexing this project is within the user's authorized scope. This tool follows the saved mode and can scan the bound project; do not implicitly start a whole-repository reindex just to answer a narrow question. Prefer an already authorized UI update or targeted source inspection when adequate.
3. Inspect relevant structure with `get_architecture({"path":"src","aspects":["structure","dependencies"]})`. Use the smallest relevant directory and aspects. Find the entry point using `search_graph({"query":"function or feature name","limit":20})`.
4. Follow callers and dependencies with `trace_path({"function_name":"qualified.symbol","direction":"both","depth":2})`. Read exact code with `get_code_snippet({"qualified_name":"qualified.symbol"})`; use `get_file_outline({"file_path":"src/example.ts"})` to understand neighboring declarations. Replace example names with discovered symbols.
5. State the affected flow, contracts, and tests before changing code. Graph results are static evidence: missing edges or clean coverage do not prove no impact. Resolve relevant gaps by narrowly reading current source. Do not dump the repository or unrelated files.

## After editing

Run relevant tests and `detect_changes({"scope":"impact","depth":2})`. Compare reported impact with the intended change; inspect relevant callers and tests that were missed. A Git diff can contain pre-existing work, so distinguish your changes from the user's changes. In non-Git projects, explain unavailable diff analysis and inspect changed files directly.

Check coverage and freshness for changed paths again. If an update is necessary and authorized, call `index_repository({})`, wait for completion, then repeat status and targeted coverage checks. Otherwise explicitly report stale coverage. Do not claim the graph, index, or tests are current without checking their results.

If tools are unavailable or disabled, say so and continue scoped source analysis when sufficient. Do not claim this skill guarantees that the model used the tools.
