# Multi-Root Workspaces

A workspace groups several folders so one Woody conversation can work across them,
such as an application and the library it uses. It needs an AionCore build with the
workspace routes, v0.2.2-woody.6 or later.

## Create or Open a Workspace

Choose **Workspaces** on the new-conversation page, then **New workspace** or
**Open workspace**. Add folders with **Add folder to project**. A folder cannot
contain, or sit inside, another folder of the same workspace.

Changes apply immediately and survive a restart, even if you never save. **Save**
writes a `.woody-workspace` file, which is what you keep or share. **Discard changes**
returns to the last saved file.

Saving stores folders inside the file's own directory as relative paths, so a project
can be moved together with its workspace file. Folders elsewhere keep absolute paths.

## Default Execution Folder

Commands run in the default execution folder unless the agent names another one. The
order of the folders does not change it. Without a default, or if the default folder
is missing, the agent has to give an explicit path: Woody never silently picks a
different folder.

In a path, the agent can refer to a folder as `@name/path/to/file`, or
`@{root-id}/path` when two folders share a name.

Folders describe context; they are not a security boundary. An agent can still reach
files outside them through an absolute path.

## Common Situations

- **Folder unavailable.** The folder moved or its drive is disconnected. Use
  **Locate folder…** to point the same entry at its new location.
- **This workspace has running tasks.** Folders cannot change during a task, so that
  a running command never loses its directory. Wait for it to finish.
- **Unsaved changes on leaving.** Choose **Save**, **Discard changes** or **Cancel**.
  Take as long as you need; the window waits for your answer.
- **This AionCore build does not support multi-root workspaces yet.** The bundled
  backend is older than this feature. Update Woody.
