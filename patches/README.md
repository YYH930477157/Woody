# Patches

`7zip-bin@5.2.0.patch` is a dependency patch applied by bun from
`package.json` → `patchedDependencies`.

AionCore engine changes are not kept here. They are commits on the `woody`
branch of the fork <https://github.com/YYH930477157/AionCore>, which starts
from an upstream release tag. Nothing is pushed upstream, and the fork's
`main` branch is not used. Pushing a `vX.Y.Z-woody.N` tag to the fork runs its
Release workflow. `aioncoreRepo` and `aioncoreVersion` in the root
`package.json` pin the release that packaging downloads; change them together.

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

Not on `woody` yet: the usage-event engine change behind the chat status bar
(aionrs `emit_usage` and AionCore `AgentStreamEvent::Usage`). It also needs a
fork of aionrs, because AionCore depends on aionrs by git tag.
