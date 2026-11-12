# Patches

`7zip-bin@5.2.0.patch` is a dependency patch applied by bun from
`package.json` → `patchedDependencies`.

AionCore engine changes are not kept here. They are commits on the `woody`
branch of the fork <https://github.com/YYH930477157/AionCore>, which is the only
branch the fork has — there is no `main`. Nothing is pushed upstream. Upstream
`iOfficeAI/AionCore` is merged into `woody` from an `upstream` remote, so
`woody` always contains everything upstream has. Pushing a `vX.Y.Z-woody.N` tag
to the fork runs its Release workflow. `aioncoreRepo` and `aioncoreVersion` in
the root `package.json` pin the release that packaging downloads; change them
together.

To take a new upstream release, merge it into `woody` by hand in a fork
checkout that has the upstream remote:

```bash
git remote add upstream https://github.com/iOfficeAI/AionCore.git  # once
git fetch upstream --tags
git switch woody
git merge vX.Y.Z
git push origin woody
git push origin woody:refs/tags/vX.Y.Z-woody.1
```

Push only `-woody.N` tags. The fork releases every pushed `v*` tag, so never
use `git push --tags` or `--follow-tags` there: an upstream tag such as
`v0.2.3` would publish upstream code as the newest release.

AionCore depends on aionrs crates by fixed commit, not by tag: the `aion-*`
dependencies in `Cargo.toml` carry `rev = "<sha>"`. The engine has a fork too:
<https://github.com/YYH930477157/aionrs>, branch `woody`, which is likewise the
fork's only branch: it carries the merge of upstream `main`, and the `rev`
AionCore pins is taken from a commit on it. The engine supplies per-call usage reporting
(`OutputSink::emit_usage` with `UsageReport`) that the chat status bar reads.
When AionCore's upstream bumps aionrs, merge that upstream commit into the
aionrs `woody` branch, push it, then point AionCore's `aion-*` `rev` at the new
commit. Keep Actions disabled on the aionrs fork so its upstream release
workflows never run there. The fork needs no tags of its own, because AionCore
pins a commit rather than a tag. The engine keeps a single line: the earlier
`CallUsage` implementation was replaced by `UsageReport`, and the branch that
carried it is gone.
