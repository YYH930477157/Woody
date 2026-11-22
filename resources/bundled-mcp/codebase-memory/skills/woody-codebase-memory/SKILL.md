---
name: woody-codebase-memory
description: Use to find where something is implemented, who calls a function, what it calls, what a change affects, or how a module is organized, in a Woody project with Codebase Memory enabled. Also use to explain a feature end to end (entry points, flow, parameters and where they are stored, where its data comes from) and to write or update a feature card in .woody/features. Before changing code in a project that has .woody/architecture.md, read that file and follow its tasks, dispatch table order and Change rules.
---

# Woody Codebase Memory

The `woody-codebase-memory` tools answer structural questions from a local graph of this project's code: where a symbol is defined, who calls it, what it calls, which variables it reads and writes, and how folders depend on each other. One call often replaces several rounds of searching and reading files. The graph is static and reflects the last index, so treat it as evidence, not proof.

## Which tool for which question

| Question                                       | Call                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Where is this implemented?                     | `search_graph({"query":"words from the name or feature","limit":20})` or `search_graph({"name_pattern":"^ExactName$"})` |
| Show me the code                               | `get_code_snippet({"qualified_name":"<qualified or short name>"})`                                                      |
| Who calls it?                                  | `trace_path({"function_name":"Name","direction":"inbound","depth":2})`                                                  |
| What does it call?                             | `trace_path({"function_name":"Name","direction":"outbound","depth":2})`                                                 |
| Which globals does a function use?             | `search_graph({"name_pattern":"^Name$","relationship":"USAGE","include_connected":true})`                               |
| Who reads or writes a variable?                | `trace_path({"function_name":"VariableName","direction":"inbound","depth":1,"edge_types":["USAGE","WRITES"]})`          |
| What arguments does it pass on (addresses...)? | `trace_path({"function_name":"Name","direction":"both","depth":2,"mode":"data_flow"})`                                  |
| What is in this file?                          | `get_file_outline({"file_path":"src/module/file.c"})`                                                                   |
| How is this folder organized?                  | `get_architecture({"path":"src/module","aspects":["structure","dependencies"]})`                                        |
| Where does this text appear?                   | `search_code({"pattern":"literal text","limit":10})`                                                                    |
| What does my change affect?                    | `detect_changes({"scope":"impact","depth":2})` (Git projects)                                                           |
| Is this file or folder in the index?           | `check_index_coverage({"paths":["src/module/file.c"]})`                                                                 |

Use real names and project-relative paths. The project is bound for you: never pass `project`, `repo_path` or another project's paths. When a name is ambiguous, the result lists qualified names; repeat the call with one of them.

## Rules that keep answers right

- Call the tool that answers the question directly. Use `index_status({})` only when a result is empty or an error says the project is missing; then tell the user the index needs updating in the Architecture panel.
- Prefer `query` or `name_pattern` to `semantic_query`, whose matches are often unrelated.
- `search_graph` matches code names, so give it English words from the names. For Chinese or other words in comments and strings, use `search_code({"pattern":"..."})`, which searches the text.
- In C and C++, calls made through macros (for example RTOS wrappers such as `xQueueSend` or `xSemaphoreGive`) and through function pointers, task tables, callback tables or API tables between firmware images are usually missing from the graph. Before concluding that something has no callers or no writers, run `search_code` for its name and for the macros that wrap it, and look for the table that holds it. For a function kept in a struct field, `.woody/architecture.md` lists the table and where that field is called.
- In C, many global variables are not in the graph at all: those declared inside `#if` blocks, all arrays, and those behind a section or attribute macro (such as `__no_init` or `PRIVILEGED_DATA`). For those, and whenever a variable is not found, list its readers and writers with `search_code` for its name instead of `trace_path`.
- In a C or C++ project only C and C++ sources and headers are indexed. Read build scripts, CMake files, Makefiles, assembly, linker and config files directly.
- The indexer skips folders by name, such as `build`, `tools`, `scripts` or `thirdparty` (some only in the fast and moderate modes), and everything `.gitignore` excludes; a C or C++ project does index the sources in `obj` folders. When code you expect is missing from the graph, check its path with `check_index_coverage`. If the result is `excluded`, read those files directly, and tell the user that the Architecture panel lists skipped source folders and can add them to the index.
- Code you edited in this conversation is newer than the index: read those files directly.
- Run `index_repository({})` only when the user asks for it, or the index is missing and the user agrees; it rescans the whole project.
- If the tools are unavailable, say so and continue with ordinary file reading.

## Tracing a feature

Use this when the user asks how a feature works, for example "where are the alarm parameters stored and where does the alarm check get its data". Work in this order, and read the key code with `get_code_snippet` before stating a condition, threshold or address.

1. Look for a card first: list `.woody/features/*.md` in the project root. If one covers the feature, read it, re-check only the facts the question depends on, and answer from it.
2. Entry points: `search_graph({"query":"alarm detection","label":"Function","limit":30})`, then `search_graph({"name_pattern":"(?i)alarm","label":"Function","limit":60})` with the feature's own word. When a module is split across `<module>_*.c` files (for example `display_*.c` with `display.h` / `display_*.h` instead of a single `display.c`), include every sibling `<module>_*.c` file in that folder—even those that do not register directly in a dispatch table—and prefer `<dir>/<module>_*.c` in `.woody/experts.json`.
3. Flow: trace the periodic or top-level function outbound, two levels. Trace it inbound to learn what schedules it; if that is empty, apply the macro and table rule above.
4. Data sources: checks often read global measurement structures instead of calling getters. For each check, list the globals it uses with the USAGE query above, then trace who writes those variables.
5. Parameters: find the parameter variable and its type (names such as `Para`, `Param`, `Cfg`, `Thd`), its readers and writers, and its default value. Trace the set or save function with `mode` `data_flow`: the arguments show the storage call and address macro, for example an EEPROM write of `PARA_ADDR`. Find the macro with `search_code`. Trace the set function inbound to see who changes the parameters: protocol objects, factory commands or the UI.
6. Answer with `path:line` for every fact, and say which parts you read in the source, which come from the graph only, and which you inferred.

## Feature cards

A feature card records one traced feature, so later conversations start from it instead of tracing again. Write or update a card when the user asks for one, or offer to after tracing a feature. Cards live in `.woody/features/<feature>.md` in the project root; use lowercase ASCII words joined by `-` for the file name, for example `alarm.md` or `load-profile.md`. Write the card in the user's language with these sections, in this order:

1. Title and summary: what the feature does, in two or three sentences.
2. Basis: the date, the Git commit (`git rev-parse --short HEAD`, or "no Git"), and the folders traced.
3. Entry and scheduling: entry functions and what calls them.
4. Flow: the call chain from the entry to each step, with `path:line`.
5. Parameters: type, variable, default value, storage (memory kind, address macro and where it is defined, checksum or backup copy), and the load and save functions.
6. Who changes the parameters: protocol objects, commands or UI, with `path:line`.
7. Data sources: the variables and getters each step reads, and who writes them.
8. Outputs: states, events, records or flags the feature sets.
9. Build switches: the macros that enable or disable parts of it.
10. Gaps: what the tools could not follow (function pointers, macros, tables between images) and how it was resolved, or that it is unresolved.
11. Corrections from the user: anything the user added or corrected. Keep this section unchanged when you update the card, and prefer it over your own findings when they disagree.

Mark each fact as read in the source, from the graph, or inferred. When a card is used again, compare its commit with the current one; if files it cites changed, re-check those facts and update the card and its basis line.

A module expert's card (`.woody/features/<expert id>.md`) starts with a part between `woody:generated` markers that Woody rewrites after every index: the expert's files and their index state, where the module is scheduled, the calls into and out of it, its globals and who writes them, its address macros, its build switches, and an index check. Never edit that part, and keep your sections after it. Use it as the starting point of a trace, not as the answer: its calls come from the index, and its globals and their users from a text search of the source. Before relying on the index for that module, work through its index check: read partly parsed ranges and unparsed files in the source, re-read files changed after the index, and use `search_code` for globals and functions missing from the graph.

## Architecture file

Woody writes `.woody/architecture.md` from the index and keeps it up to date after every index. It lists the RTOS tasks and what they wait on, the dispatch tables each task runs (in order, with `#if` conditions and comments), the functions held in struct fields (both C99 `.field = fn` and positional initializers) and where those fields are called through a pointer, inter-image API vector tables (`Boot` / `APP1` / `APP2` pointer macros and entry structs), large data and X-Macro tables (with line ranges even when a file failed to parse), the order constraints from comments, and which tables or tasks each module registers in. Its last section, the Change rules, is written by the team.

Read it before you change code, and follow it:

1. The team's Change rules come first. They win over the generated part and over your own judgment.
2. When you change an existing module, keep that module's own style, even where it differs from the others; the file lists modules that differ.
3. When you add periodic work or a new module, register it the way most modules do: the module matrix shows which tables (initialisation, periodic, idle, power-down and so on) a module usually provides a function for. Put each entry where it belongs in the table's order, keep every order constraint, copy the `#if` condition of related entries, and say why you chose that position.
4. Never edit between the `woody:generated` markers; Woody rewrites that part. If you learn a rule the team should keep, suggest adding it to the Change rules.
5. Entries marked as not in the index are real code in a skipped folder or behind `#if`: read their files directly.

## Adapting when architecture changes

Firmware projects evolve: monolithic `.c` files split into `<module>_*.c`, folders move, modules shift from cooperative dispatch tables to standalone RTOS tasks or struct vtables, or new inter-image / X-Macro tables appear. Adapt in this order whenever the generated brief, `.woody/architecture.md`, or the source disagrees with an older card or `.woody/experts.json`:

1. Trust the source and the latest `woody:generated` sections over prose in `.woody/features/*.md` or `.woody/business.md`. Woody marks a card stale automatically when owned files change, an expert path stops matching, unowned sibling files appear in the same module, or the module's scheduling entries shift.
2. Check the `Index check` and `Files and index state` lines of the card first: if paths match no indexed file or unowned files are flagged in the same module, inspect those candidate files and suggest updating `.woody/experts.json` with resilient patterns (`<dir>/<module>_*.c`, `<dir>/<module>*.h`, or `<dir>/`) rather than brittle single-file names.
3. Follow whichever scheduling mechanism the module now uses in `.woody/architecture.md`—dispatch tables, standalone RTOS tasks, struct function-pointer tables, or inter-image API tables—and rewrite the outdated sections of the feature card (while keeping `Corrections from the user` intact).

## Around a change

Before editing, find the entry point, trace callers and callees one or two levels, and read the exact code you will change. In a project with `.woody/architecture.md`, read it first. After editing, run the relevant tests; `detect_changes` maps Git diffs to affected symbols, and in workspaces without Git automatically falls back to reporting files modified, deleted or added since the last index along with their external callers. If the change touches a feature that has a card, update the card.
