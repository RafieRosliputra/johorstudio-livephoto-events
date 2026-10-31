// JS Tether APK for signed-in photographers and admins.
// The server keeps a copy of the newest APK from the GitHub Releases of the app repo
// (public, no token needed), checked at start and every 6 hours.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const dir = () => path.join(config.dataDir, 'app');
const metaFile = () => path.join(dir(), 'apk.json');

export function apkInfo() {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(), 'utf8'));
    if (fs.existsSync(path.join(dir(), m.file))) return m;
  } catch { /* none yet */ }
  return null;
}
export const apkPath = (m) => path.join(dir(), m.file);

let busy = false;
export async function refreshApk() {
  if (!config.apkReleasesUrl || busy) return apkInfo();
  busy = true;
  try {
    const r = await fetch(config.apkReleasesUrl, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'livephoto' }, signal: AbortSignal.timeout(15000) });
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
    if (buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not an APK'); // zip "PK"
    fs.mkdirSync(dir(), { recursive: true });
    const file = pick.asset.name.replace(/[^\w.-]/g, '_');
    fs.writeFileSync(path.join(dir(), file + '.tmp'), buf);
    fs.renameSync(path.join(dir(), file + '.tmp'), path.join(dir(), file));
    const meta = { id, file, name: pick.asset.name, size: buf.length, tag: pick.rel.tag_name, title: pick.rel.name || pick.rel.tag_name,
      version: (pick.asset.name.match(/v?(\d+(?:\.\d+)+)/) || [])[1] || pick.rel.tag_name, published: pick.rel.published_at, fetchedAt: Date.now() };
    fs.writeFileSync(metaFile(), JSON.stringify(meta, null, 2));
    if (cur && cur.file !== file) fs.rmSync(path.join(dir(), cur.file), { force: true });
    console.log(`[apk] ${meta.name} (${meta.tag}) saved`);
    return meta;
  } catch (e) {
    console.error('[apk]', e.message);
    return apkInfo();
  } finally { busy = false; }
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
