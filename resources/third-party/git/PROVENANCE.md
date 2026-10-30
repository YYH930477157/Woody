# Bundled Git provenance

Product: Git for Windows MinGit, 64-bit

- Release: `v2.56.0.windows.4`
- Git commit: `581291682ad5a238c08c93d1f5bd4518382a3230`
- Release page: https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4
- Asset: `MinGit-2.56.0.4-64-bit.zip`
- Asset SHA-256: `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`
- Imported: 2026-10-30

The archive was downloaded from the official `git-for-windows/git` GitHub release,
checked against the SHA-256 digest published by the GitHub release API, and expanded
without modifying its executable files. `LICENSE.txt` is the license file included
in the upstream archive.

Woody resolves this runtime only as the final fallback after an explicitly configured
Git executable and system Git. The bundled `git.exe` is launched directly without a
shell and with terminal prompting disabled. The bundle includes Git's HTTPS transport,
OpenSSH, and Git Credential Manager. A missing external signing program affects only
operations configured to use that program.

Build verification on 2026-10-30:

- `git --version` returned `git version 2.56.0.windows.4`.
- Git Credential Manager returned `2.9.1+6760f0ef069c994aa2bb1d703fb374986ee82a3e`.
- OpenSSH returned `OpenSSH_10.6p1`.
- HTTPS `git ls-remote` against `git-for-windows/git` returned the pinned branch heads.
- A temporary repository executed a repository `pre-commit` hook through the bundled shell
  and created the expected commit.
