# Patches

The files in this directory serve two different consumers.

- `7zip-bin@5.2.0.patch` is a dependency patch applied by bun from
  `package.json` → `patchedDependencies`.
- `aioncore-v0.2.2-hidden-git-discovery.patch` is an AionCore engine patch.
  AionCore is a separate repository, so it is archived here to keep the change
  beside the AionUi source that depends on it.

Apply the engine patch from the workspace root:

```bash
git -C AionCore apply ../AionUi/patches/aioncore-v0.2.2-hidden-git-discovery.patch
```

Or apply it with its commit metadata:

```bash
git -C AionCore am ../AionUi/patches/aioncore-v0.2.2-hidden-git-discovery.patch
```

It targets AionCore `v0.2.2` before the local usage-event patch, then rebuild
`aioncore` (see the workspace `AGENTS.md`).
