const https = require('node:https');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');

/** Download a build asset over HTTPS, honoring the same proxy variables as hub preparation. */
async function downloadArchive(url, destination, env = process.env) {
  const proxy = env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy;
  const agent = proxy ? new (require('https-proxy-agent').HttpsProxyAgent)(proxy) : undefined;
  async function follow(currentUrl, remaining = 5) {
    if (new URL(currentUrl).protocol !== 'https:') throw new Error('Codebase Memory download requires HTTPS.');
    const response = await new Promise((resolve, reject) => {
      const request = https.get(currentUrl, { agent, headers: { 'User-Agent': 'Woody-build' } }, resolve);
      request.setTimeout(120000, () => request.destroy(new Error('Codebase Memory download timed out.')));
      request.on('error', reject);
    });
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      if (!remaining) throw new Error('Codebase Memory download exceeded the redirect limit.');
      return follow(new URL(response.headers.location, currentUrl).href, remaining - 1);
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new Error(
        `Codebase Memory download failed: HTTP ${response.statusCode}. Use AIONUI_CODEBASE_MEMORY_ARCHIVE for an offline build.`
      );
    }
    await pipeline(response, fs.createWriteStream(destination));
  }
  try {
    await follow(url);
  } finally {
    agent?.destroy();
  }
}

module.exports = { downloadArchive };
