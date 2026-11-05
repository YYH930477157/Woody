---
name: woody-codebase-memory
description: Use to find where something is implemented, who calls a function, what it calls, what a change affects, or how a module is organized, in a Woody project with Codebase Memory enabled.
---

# Woody Codebase Memory

The `woody-codebase-memory` tools answer structural questions from a local graph of this project's code: where a symbol is defined, who calls it, what it calls, and how folders depend on each other. One call often replaces several rounds of searching and reading files. The graph is static and reflects the last index, so treat it as evidence, not proof.

## Which tool for which question

| Question                      | Call                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Where is this implemented?    | `search_graph({"query":"words from the name or feature","limit":20})` or `search_graph({"name_pattern":"^ExactName$"})` |
| Show me the code              | `get_code_snippet({"qualified_name":"<qualified or short name>"})`                                                      |
| Who calls it?                 | `trace_path({"function_name":"Name","direction":"inbound","depth":2})`                                                  |
| What does it call?            | `trace_path({"function_name":"Name","direction":"outbound","depth":2})`                                                 |
| What is in this file?         | `get_file_outline({"file_path":"src/module/file.c"})`                                                                   |
| How is this folder organized? | `get_architecture({"path":"src/module","aspects":["structure","dependencies"]})`                                        |
| Where does this text appear?  | `search_code({"pattern":"literal text","limit":10})`                                                                    |
| What does my change affect?   | `detect_changes({"scope":"impact","depth":2})` (Git projects)                                                           |

Use real names and project-relative paths. The project is bound for you: never pass `project`, `repo_path` or another project's paths.

## Rules that keep answers right

- Call the tool that answers the question directly. Use `index_status({})` only when a result is empty or an error says the project is missing; then tell the user the index needs updating in the Architecture panel.
- Prefer `query` or `name_pattern` to `semantic_query`, whose matches are often unrelated.
- In C and C++, calls made through macros (for example RTOS wrappers such as `xQueueSend` or `xSemaphoreGive`) and through function pointers or callback tables are usually missing from the graph. Before concluding that something has no callers, run `search_code` for its name and for the macros that wrap it.
- Code you edited in this conversation is newer than the index: read those files directly.
- Run `index_repository({})` only when the user asks for it, or the index is missing and the user agrees; it rescans the whole project.
- If the tools are unavailable, say so and continue with ordinary file reading.

## Around a change

Before editing, find the entry point, trace callers and callees one or two levels, and read the exact code you will change. After editing, run the relevant tests; in a Git project `detect_changes` lists affected symbols you may have missed.
