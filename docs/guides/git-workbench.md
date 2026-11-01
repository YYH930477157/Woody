# Git Workbench

**Git history** in the Changes panel opens the workbench for the selected repository.
Commit checks are described in [Git Static Scan Workflow](git-static-scan-workflow.md).

## Which Git Runs

Woody uses, in order: the path set in settings, the Git on your system, then the Git
bundled in Windows packages. A configured path that fails is reported rather than
replaced. Git 2.25 or newer is required, and older system Git falls back to the
bundled copy, so an offline Windows machine needs no upgrade. Editing history needs
Git 2.40.

## Tabs

- **Git history** browses commits, branches and file history. An old version of a file
  opens in its own read-only tab, so it cannot replace the file you are editing.
- **Repository operations** covers branches, tags, remotes, stashes and worktrees.
  Fetch, pull and push show their progress and can be cancelled. Pull only
  fast-forwards.
- **Resolve conflicts** resolves conflicts and continues or aborts a merge or rebase.
  Saving keeps the file's line endings outside the lines you resolved.
- **Shelves and patches** sets changes aside as a patch you can apply later.
- **Local history** records file versions outside Git, including files Git ignores but
  not `node_modules`. It keeps watching while a project is open, and it skips files
  that have not changed.

**Changelists** are in the Changes panel. They group files for your own organization
and do not change what gets committed: checked files stay checked whichever list you
are viewing.

## Rewriting History

Reword, squash, fixup and drop need a clean working tree and a linear range. They run
on a private copy of Git's state, and the real HEAD only moves once the rewrite
succeeds. If a rewrite fails or runs past 30 minutes, Git restores your files and the
repository stays usable.

If continuing a paused rebase is interrupted, the files return to that pause, and you
can continue or abort again.

If the app or the computer stops during a rewrite, Woody cannot tell whether files
changed afterwards, so it pauses Git operations for that repository and shows
**Restore repository** under **Repository operations**. It asks first, because edits
made to those files since then are lost.

## When an Operation Stops

Woody explains stops it understands, with the next step: uncommitted changes in the
way, conflicts, another Git process, or a remote address it cannot use. For anything
else it shows Git's own output.

Remote addresses may use `https`, `ssh`, `git`, or local paths, including SSH config
aliases such as `github-work:org/repo.git` and Azure DevOps addresses. An address
holding a password or token is refused for fetch, pull and push. You can still change
or remove that remote here.
