/**
 * CLI wrapper for prepare-aioncore.
 *
 * Reads environment variables and invokes the shared module.
 *
 * Version resolution order:
 *  1. AIONUI_BACKEND_RUN_ID env (download from AionCore Manual Build artifact)
 *  2. AIONUI_BACKEND_VERSION env (for ad-hoc release overrides)
 *  3. "aioncoreVersion" field in repo-root package.json (the pin)
 *  4. 'latest' (fallback; not recommended for reproducible builds)
 *
 * Releases and run ids come from "aioncoreRepo" in repo-root package.json.
 *
 * Environment variables:
 *  - AIONUI_BACKEND_RUN_ID: Manual Build workflow run id in that repository
 *  - AIONUI_BACKEND_VERSION: override the pinned version
 *  - AIONUI_BACKEND_REPO: override the pinned repository ("owner/name")
 *  - AIONUI_BACKEND_ARCH: target architecture (default: process.arch)
 *  - GH_TOKEN / GITHUB_TOKEN: GitHub API token (for rate limiting)
 *
 * `--if-stale` (development startup) keeps an already prepared bundle that matches the pin and only warns when a
 * refresh fails, so `bun run start` still launches with the previous backend.
 */

const path = require('path');
const { ensurePreparedAioncore, prepareAioncore } = require('../packages/shared-scripts/src/prepare-aioncore.js');
const { resolveAioncoreRepo, resolveAioncoreVersion } = require('./resolveAioncoreVersion.js');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.platform;
// Support cross-compilation: AIONUI_BACKEND_ARCH > npm_config_target_arch > process.arch
const arch = process.env.AIONUI_BACKEND_ARCH || process.env.npm_config_target_arch || process.arch;
const version = resolveAioncoreVersion(projectRoot);
const repo = resolveAioncoreRepo(projectRoot);
const ifStale = process.argv.includes('--if-stale');

if (ifStale) {
  if (process.env.AIONUI_BACKEND_BIN) {
    console.log('AIONUI_BACKEND_BIN is set; skipping the bundled aioncore check.');
  } else {
    try {
      const result = ensurePreparedAioncore({ projectRoot, platform, arch, version, repo });
      if (!result.prepared) console.log(`Bundled aioncore matches ${repo}@${version}.`);
    } catch (error) {
      console.warn(`⚠️ Could not update bundled aioncore to ${repo}@${version}: ${error.message}`);
    }
  }
} else {
  try {
    prepareAioncore({ projectRoot, platform, arch, version, repo });
  } catch (error) {
    console.error('❌ prepareAioncore failed:', error.message);
    process.exit(1);
  }
}

module.exports = function () {
  try {
    return prepareAioncore({ projectRoot, platform, arch, version, repo });
  } catch (error) {
    console.error('❌ prepareAioncore failed:', error.message);
    throw error;
  }
};
