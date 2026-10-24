/**
 * Resolve the aioncore release (repository and version tag) to download for packaging.
 *
 * Version order:
 *   1. AIONUI_BACKEND_VERSION env (ad-hoc override, e.g. CI dispatch input)
 *   2. "aioncoreVersion" field in repo-root package.json (the pin)
 *   3. 'latest' (GitHub API releases/latest; non-reproducible fallback)
 *
 * Repository order:
 *   1. AIONUI_BACKEND_REPO env ("owner/name")
 *   2. "aioncoreRepo" field in repo-root package.json, pinned next to "aioncoreVersion"
 *   3. upstream iOfficeAI/AionCore
 *
 * Keep this file tiny and dependency-free — it's required from both
 * scripts/prepareAioncore.js and scripts/pack-web-cli.js before
 * any project-level install has necessarily completed.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'iOfficeAI/AionCore';

function readPinnedField(projectRoot, field) {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg && typeof pkg[field] === 'string' && pkg[field].trim()) {
      return pkg[field].trim();
    }
  } catch {
    // fall through
  }
  return undefined;
}

function resolveAioncoreVersion(projectRoot) {
  const envOverride = process.env.AIONUI_BACKEND_VERSION;
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }

  return readPinnedField(projectRoot, 'aioncoreVersion') || 'latest';
}

function resolveAioncoreRepo(projectRoot) {
  const envOverride = (process.env.AIONUI_BACKEND_REPO || '').trim();
  const repo = envOverride || readPinnedField(projectRoot, 'aioncoreRepo') || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid aioncore repository "${repo}"; expected "owner/name"`);
  }
  return repo;
}

module.exports = { resolveAioncoreRepo, resolveAioncoreVersion };
