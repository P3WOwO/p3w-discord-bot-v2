'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { spawnSync } = require('node:child_process');

const RELEASE_TAG = 'autobuild-2026-11-05-12-48';
const ARCHIVE = 'ffmpeg-n9.0.2-47-gb204e94e90-linux64-lgpl-9.0.tar.xz';
const CHECKSUMS_SHA256 = 'a6758b5484708dd69fd0452dc8b9fe3cb91d88a9f5fece6ce6b545412f3383a7';
const BASE_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE_TAG}/`;
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'ffmpeg');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p3w-ffmpeg-'));
const archivePath = path.join(TEMP, ARCHIVE);
const checksumsPath = path.join(TEMP, 'checksums.sha256');

function requestStream(url, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('Too many redirects downloading FFmpeg'));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const request = lib.get(url, { headers: { 'User-Agent': 'P3W-FFmpeg-Installer/1.0' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        resolve(requestStream(next, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`FFmpeg download returned HTTP ${response.statusCode} for ${url}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(120000, () => request.destroy(new Error('FFmpeg download timed out')));
    request.on('error', reject);
  });
}

async function download(url, destination) {
  const response = await requestStream(url);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(response, meter, fs.createWriteStream(destination));
  return { sha256: hash.digest('hex'), bytes };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.log(`[ffmpeg-installer] skipping static Linux binary for ${process.platform}/${process.arch}`);
    return;
  }

  const existing = path.join(VENDOR, 'bin', 'ffmpeg');
  if (fs.existsSync(existing)) {
    const version = spawnSync(existing, ['-version'], { encoding: 'utf8', timeout: 5000 });
    if (version.status === 0 && /ffmpeg version n?9\.0\.2/.test(version.stdout || '')) {
      console.log('[ffmpeg-installer] verified FFmpeg 9.0.2 already present');
      return;
    }
  }

  console.log(`[ffmpeg-installer] downloading pinned FFmpeg 9.0.2 build (${ARCHIVE})`);
  const checksums = await download(BASE_URL + 'checksums.sha256', checksumsPath);
  if (checksums.sha256 !== CHECKSUMS_SHA256) {
    throw new Error(`FFmpeg checksum manifest hash mismatch: ${checksums.sha256}`);
  }

  const archive = await download(BASE_URL + ARCHIVE, archivePath);
  const checksumLine = fs.readFileSync(checksumsPath, 'utf8')
    .split(/\r?\n/)
    .find(line => line.trim().endsWith(ARCHIVE));
  const expected = checksumLine?.trim().split(/\s+/)[0];
  if (!expected || archive.sha256 !== expected) {
    throw new Error(`FFmpeg archive SHA-256 mismatch: expected=${expected || 'missing'}, actual=${archive.sha256}`);
  }

  const extractDir = path.join(TEMP, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  run('tar', ['-xJf', archivePath, '-C', extractDir, '--strip-components=1']);

  const binary = path.join(extractDir, 'bin', 'ffmpeg');
  if (!fs.existsSync(binary)) throw new Error('FFmpeg archive does not contain bin/ffmpeg');
  const version = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 10000 });
  if (version.error || version.status !== 0 || !/ffmpeg version n?9\.0\.2/.test(version.stdout || '')) {
    throw new Error(`Downloaded FFmpeg failed version validation: ${version.error?.message || version.stdout || version.stderr}`);
  }

  fs.rmSync(path.dirname(VENDOR), { recursive: true, force: true });
  fs.renameSync(extractDir, VENDOR);
  fs.chmodSync(path.join(VENDOR, 'bin', 'ffmpeg'), 0o755);

  console.log(`[ffmpeg-installer] installed ${String(version.stdout).split('\n')[0]} (${archive.bytes} bytes, SHA-256 verified)`);
}

main()
  .catch(error => {
    console.error('[ffmpeg-installer] failed:', error?.stack || error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TEMP, { recursive: true, force: true });
  });
