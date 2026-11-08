'use strict';

// Install a pinned official yt-dlp standalone build. The binary includes the EJS
// challenge scripts; Node from the Render runtime is selected by music.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const VERSION = process.env.YT_DLP_VERSION || '2026.10.26';
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'node_modules', '.cache', 'p3w-yt-dlp');
const BINARY_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const BINARY_PATH = path.join(VENDOR, BINARY_NAME);

const assets = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'win32-x64': 'yt-dlp.exe',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
};

function requestStream(url, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('Too many redirects downloading yt-dlp'));
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(url, {
      headers: { 'User-Agent': 'P3W-yt-dlp-installer/1.0' },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(requestStream(new URL(response.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`yt-dlp download returned HTTP ${response.statusCode}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(180000, () => request.destroy(new Error('yt-dlp download timed out')));
    request.on('error', reject);
  });
}

function getVersion(binaryPath) {
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

async function main() {
  if (process.env.YT_DLP_PATH) {
    console.log('[yt-dlp-installer] using YT_DLP_PATH; bundled download skipped');
    return;
  }

  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) {
    console.log(`[yt-dlp-installer] no bundled binary for ${process.platform}/${process.arch}; set YT_DLP_PATH to use a system install`);
    return;
  }

  fs.mkdirSync(VENDOR, { recursive: true });
  if (getVersion(BINARY_PATH) === VERSION) {
    console.log(`[yt-dlp-installer] verified yt-dlp ${VERSION} already installed`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w-yt-dlp-install-'));
  const tempPath = path.join(tempDir, BINARY_NAME);
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${asset}`;
  try {
    console.log(`[yt-dlp-installer] downloading official yt-dlp ${VERSION} for ${process.platform}/${process.arch}`);
    const response = await requestStream(url);
    await pipeline(response, fs.createWriteStream(tempPath));
    if (process.platform !== 'win32') fs.chmodSync(tempPath, 0o755);
    const actualVersion = getVersion(tempPath);
    if (actualVersion !== VERSION) {
      throw new Error(`Downloaded yt-dlp version mismatch: expected ${VERSION}, got ${actualVersion || 'unavailable'}`);
    }

    const stagedPath = path.join(VENDOR, BINARY_NAME + '.new');
    fs.copyFileSync(tempPath, stagedPath);
    if (process.platform !== 'win32') fs.chmodSync(stagedPath, 0o755);
    fs.rmSync(BINARY_PATH, { force: true });
    fs.renameSync(stagedPath, BINARY_PATH);
    console.log(`[yt-dlp-installer] installed yt-dlp ${actualVersion}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('[yt-dlp-installer] failed:', error?.stack || error);
  process.exitCode = 1;
});
