// JS Tether APK for signed-in photographers and admins.
// The server keeps a copy of the newest APK from the GitHub Releases of the app repo
// (public, no token needed), checked at start and every 6 hours.
// The admin decides where this APK comes from (dataDir/app/apk-source.json):
//   default = env/config.apkReleasesUrl (GitHub Releases), unchanged behaviour
//   url     = a GitHub releases API URL, a GitHub repo URL, or a direct https .apk URL
//   upload  = a file uploaded by the admin (never overwritten by auto-sync)
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dir = () => path.join(config.dataDir, 'app');
const metaFile = () => path.join(dir(), 'apk.json');
const sourceFile = () => path.join(dir(), 'apk-source.json');
const MODES = ['default', 'url', 'upload'];

const sanitize = (name) => String(name || '').replace(/[^\w.-]/g, '_') || 'app.apk';

export function getSource() {
  try {
    const s = JSON.parse(fs.readFileSync(sourceFile(), 'utf8'));
    if (MODES.includes(s.mode)) return { mode: s.mode, url: s.url || undefined, updatedAt: s.updatedAt || null };
  } catch { /* none yet */ }
  return { mode: 'default' };
}

export function setSource(obj) {
  const mode = MODES.includes(obj?.mode) ? obj.mode : 'default';
  const s = { mode, url: mode === 'url' ? String(obj.url || '') : undefined, updatedAt: Date.now() };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(sourceFile(), JSON.stringify(s, null, 2));
  return s;
}

// GitHub repo URL -> its releases API URL; anything else passes through unchanged.
export function releasesApiUrl(u) {
  const m = String(u || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/);
  return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=10` : String(u || '');
}

export function apkInfo() {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    if (fs.existsSync(path.join(dir(), m.file))) return m;
  } catch { /* none yet */ }
  return null;
}
export const apkPath = (m) => path.join(dir(), m.file);

const validApk = (buf) => !!buf && buf.length >= 1000 && buf[0] === 0x50 && buf[1] === 0x4b; // zip "PK"

// Atomic write + old file cleanup + meta. Reads cur BEFORE writing the new meta so cleanup works.
function saveApk(buf, file, fields) {
  fs.mkdirSync(dir(), { recursive: true });
  const cur = apkInfo();
  fs.writeFileSync(path.join(dir(), file + '.tmp'), buf);
  fs.renameSync(path.join(dir(), file + '.tmp'), path.join(dir(), file));
  const meta = { ...fields, file, size: buf.length, fetchedAt: Date.now() };
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2));
  if (cur && cur.file !== file) fs.rmSync(path.join(dir(), cur.file), { force: true });
  console.log(`[apk] ${meta.name}${meta.tag ? ` (${meta.tag})` : ''} saved`);
  return meta;
}

async function refreshFromReleases(apiUrl, source = 'default') {
  const r = await fetch(apiUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'livephoto' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`releases ${r.status}`);
  const releases = await r.json();
  let pick = null;
  for (const rel of releases) {
    if (rel.draft) continue;
    const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
    if (asset) { pick = { rel, asset }; break; }
  }
  if (!pick) return apkInfo();
  const cur = apkInfo();
  const id = `${pick.rel.tag_name}:${pick.asset.id}:${pick.asset.updated_at || ''}`;
  if (cur && cur.id === id) return cur;
  const dl = await fetch(pick.asset.browser_download_url, { signal: AbortSignal.timeout(120000) });
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  if (!validApk(buf)) throw new Error('not an APK');
  const file = sanitize(pick.asset.name);
  return saveApk(buf, file, { id, name: pick.asset.name, tag: pick.rel.tag_name, title: pick.rel.name || pick.rel.tag_name,
    version: (pick.asset.name.match(/v?(\d+(?:\.\d+)+)/) || [])[1] || pick.rel.tag_name, published: pick.rel.published_at, source });
}

async function refreshFromDirectApk(u) {
  const id = `direct:${u}`;
  const cur = apkInfo();
  if (cur && cur.id === id) return cur; // direct URL: download once
  const r = await fetch(u, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!validApk(buf)) throw new Error('not an APK');
  let name = 'app.apk';
  try { name = path.posix.basename(new URL(u).pathname) || 'app.apk'; } catch { /* keep */ }
  const file = sanitize(name);
  return saveApk(buf, file, { id, name, tag: null, title: name,
    version: (name.match(/v?(\d+(?:\.\d+)+)/) || [])[1] || 'custom', published: null, source: 'url' });
}

async function refreshFromUrl(u) {
  if (/\.apk(?:[?#].*)?$/i.test(u)) return refreshFromDirectApk(u);
  return refreshFromReleases(releasesApiUrl(u), 'url');
}

let busy = false;
export async function refreshApk() {
  if (busy) return apkInfo();
  const src = getSource();
  if (src.mode === 'upload') return apkInfo(); // manual upload: sync must never overwrite it
  if (src.mode === 'default' && !config.apkReleasesUrl) return apkInfo();
  busy = true;
  try {
    const meta = src.mode === 'default' ? await refreshFromReleases(config.apkReleasesUrl) : await refreshFromUrl(src.url);
    return meta || apkInfo();
  } catch (e) {
    console.error('[apk]', e.message);
    return apkInfo();
  } finally { busy = false; }
}

// Admin manual upload: validate and store as the active APK (mode becomes 'upload').
export function saveUploadedApk(buf, filename) {
  if (!validApk(buf)) throw new Error('not an APK');
  const name = sanitize(filename);
  fs.mkdirSync(dir(), { recursive: true });
  const cur = apkInfo();
  fs.writeFileSync(path.join(dir(), name + '.tmp'), buf);
  fs.renameSync(path.join(dir(), name + '.tmp'), path.join(dir(), name));
  const meta = { id: `upload:${Date.now()}`, file: name, name, tag: null, title: name,
    version: (name.match(/v?(\d+(?:\.\d+)+)/) || [])[1] || 'upload', published: null, source: 'upload', fetchedAt: Date.now() };
  fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2));
  if (cur && cur.file !== name) fs.rmSync(path.join(dir(), cur.file), { force: true });
  setSource({ mode: 'upload' });
  console.log(`[apk] uploaded ${meta.name}`);
  return meta;
}

let timer;
export function startApkSync() {
  refreshApk();
  timer = setInterval(refreshApk, 6 * 3600e3);
  timer.unref();
}
export const stopApkSync = () => clearInterval(timer);

export function sendApk(req, res, m) {
  const st = fs.statSync(apkPath(m));
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive', 'content-length': st.size,
    'content-disposition': `attachment; filename="${m.name}"`, 'cache-control': 'private, no-store',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(apkPath(m)).pipe(res);
}
