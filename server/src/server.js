// JS Live Photo server: API + website + live updates. Node 24, no npm packages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as db from './db.js';
import * as tenant from './tenant.js';
import { router } from './api.js';
import { store as requestStore } from './request.js';
import { HttpError, sendJson } from './http.js';
import { startScanner, stopScanner } from './storage.js';
import { startModeration, stopModeration } from './moderation.js';
import { startApkSync, stopApkSync } from './apk.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain',
};
// Clean URLs for the pages.
const PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/c\/\d{6}\/?$/, 'index.html'],        // QR on the big screen: code filled in
  [/^\/join\/\d{6}\/?$/, 'join.html'],      // photographer link: opens the JS Tether app with the code
  [/^\/admin\/?$/, 'admin.html'],
  [/^\/panel\/?$/, 'admin.html'],              // organiser panel (client code), same page, fewer powers
  [/^\/admin\/organizers\/?$/, 'organizers.html'],   // admin: white-label event organisers (ccam.my tenants), behind Cloudflare Access
  [/^\/shoot\/?$/, 'shoot.html'],
  [/^\/show\/[0-9a-f-]{36}\/?$/, 'show.html'],
  [/^\/e\/[a-z0-9]{6,16}\/?$/, 'gallery.html'],
  [/^\/d\/[A-Za-z0-9_-]{10,40}\/?$/, 'download.html'],          // download-all link for the organiser
];

// Brand logo files: /brand/<slug>/<file> from BRANDS_DIR (uploaded in the admin UI, never in git).
const BRAND_ASSET_RE = /^\/brand\/([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9._-]{0,80})$/;
const BRAND_FILE_RE = /^(logo|logo-dark|favicon)(-\d+)?\.(png|jpe?g|webp|svg|ico|gif)$/;

function serveBrandAsset(req, res, slug, file) {
  if (!BRAND_FILE_RE.test(file)) return false;
  const filePath = path.resolve(config.brandsDir, slug, file);
  if (!filePath.startsWith(path.resolve(config.brandsDir) + path.sep)) return false;
  let st;
  try { st = fs.statSync(filePath); } catch { return false; }
  if (!st.isFile()) return false;
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers = {
    'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'public, max-age=300',
    etag,
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(filePath).pipe(res);
  return true;
}

/** The Umami tag only on public pages (not admin, panel or the big screen). */
function umamiAllowed(base) { return ['index.html', 'gallery.html', 'shoot.html', 'download.html', '404.html'].includes(base); }

function renderHtml(file, tenantInfo) {
  const base = path.basename(file);
  let html = fs.readFileSync(file, 'utf8');
  html = tenant.injectHtml(html, tenantInfo);
  if (config.umamiId && umamiAllowed(base)) {
    const domain = tenantInfo.host || config.adminHost;
    const tag = `<script defer src="${config.umamiSrc}" data-website-id="${config.umamiId}" data-domains="${domain}"></script>\n</head>`;
    if (html.includes('</head>')) html = html.replace('</head>', tag);
  }
  return html;
}

function serveStatic(req, res, pathname, tenantInfo) {
  let rel = null;
  for (const [re, file] of PAGES) if (re.test(pathname)) { rel = file; break; }
  if (!rel) rel = pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(file);
  if (ext === '.html') {
    const body = Buffer.from(renderHtml(file, tenantInfo));
    res.writeHead(200, {
      'content-type': TYPES['.html'], 'content-length': body.length, 'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', vary: 'Host',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  // Pages, CSS and JS: revalidate every time (cheap 304 via ETag) so a deploy shows at once.
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return true; }
  res.writeHead(200, {
    etag,
    'content-type': TYPES[ext] || 'application/octet-stream',
    'content-length': st.size,
    // versioned assets (vendor/wasm) can be cached long; everything else is checked on each load.
    'cache-control': rel.startsWith('vendor/') ? 'public, max-age=604800' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    vary: 'Host',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

function sendPage(res, { status, html }, method) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    'content-type': TYPES['.html'], 'content-length': body.length, 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

/** A switched-off client subdomain (admin toggled it off) or an unknown <x>.ccam.my. */
function blockTenant(req, res, tenantInfo) {
  const isApi = req.url.startsWith('/api/') || req.url.startsWith('/auth/');
  if (tenantInfo.kind === 'off') {
    if (isApi) return sendJson(res, 503, { error: 'This gallery is not available right now' });
    const page = tenant.statusPage(tenantInfo, { title: 'Not available', message: 'This gallery is not available right now. Please contact your event organiser.', status: 503 });
    return sendPage(res, page, req.method);
  }
  if (isApi) return sendJson(res, 404, { error: 'Not found' });
  const page = tenant.statusPage(tenantInfo, { title: 'Not found', message: 'This site does not exist. Check the link or contact your event organiser.', status: 404 });
  return sendPage(res, page, req.method);
}

function handle(req, res, url, tenantInfo) {
  const done = (e) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = e instanceof HttpError ? e.status : e.status || 500;
    if (status >= 500 && !(e instanceof HttpError)) console.error('[error]', req.method, url.pathname, e);
    sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? 'Server error' : e.message, ...(e.extra || {}) });
  };
  try {
    // Host-level guards: /admin and /api/admin only on the admin host; ccam.my apex redirect.
    const g = tenant.guard(tenantInfo, url.pathname, req.method, url.search);
    if (g) {
      if (g.action === 'redirect') { res.writeHead(302, { location: g.location, 'cache-control': 'no-store' }); return res.end(); }
      return sendJson(res, g.status, { error: g.error });
    }
    // Tenant landing photo mosaic: the page loads /data/hero.json, so answer with the brand's own photos.
    if (url.pathname === '/data/hero.json' && (req.method === 'GET' || req.method === 'HEAD')
      && tenantInfo.kind === 'tenant' && tenantInfo.brand.heroImages) {
      const name = tenantInfo.brand.name || 'Event photos';
      const photos = tenant.heroImageList(tenantInfo.brand).map((src) => ({ title: name, album: tenantInfo.brand.website || '/', sm: src, md: src, w: 1600, h: 1067 }));
      return sendJson(res, 200, { note: 'Hero photos for this client brand', photos }, { 'cache-control': 'no-cache', vary: 'Host' });
    }
    // Brand logos are served even when the tenant is switched off (the status page uses them).
    const brandAsset = BRAND_ASSET_RE.exec(url.pathname);
    if (brandAsset && (req.method === 'GET' || req.method === 'HEAD') && serveBrandAsset(req, res, brandAsset[1], brandAsset[2])) return;
    if (tenantInfo.kind === 'off' || tenantInfo.kind === 'unknown') {
      // Static assets still load so the status page looks right; pages and API are blocked.
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');
      const assetOk = /^\/(css|js|vendor)\//.test(url.pathname) || url.pathname === '/favicon.svg';
      if (!isApi && !tenant.isPagePath(url.pathname) && assetOk && (req.method === 'GET' || req.method === 'HEAD')
        && serveStatic(req, res, url.pathname, tenantInfo)) return;
      return blockTenant(req, res, tenantInfo);
    }
    const m = router.match(req.method, url.pathname);
    if (m) {
      const out = m.handler(req, res, { params: m.params, query: url.searchParams, tenant: tenantInfo });
      if (out && typeof out.catch === 'function') out.catch(done);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, url.pathname, tenantInfo)) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return sendJson(res, 404, { error: 'Not found' });
    const notFound = path.join(PUBLIC_DIR, '404.html');
    if (fs.existsSync(notFound)) {
      const body = Buffer.from(renderHtml(notFound, tenantInfo));
      res.writeHead(404, {
        'content-type': TYPES['.html'], 'content-length': body.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', vary: 'Host',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(404).end('Not found');
  } catch (e) { done(e); }
}

export function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  let tenantInfo;
  try { tenantInfo = tenant.tenantFor(req); } catch (e) { tenantInfo = { ...tenant.resolveHost(''), brand: tenant.DEFAULT_BRAND, baseUrl: config.publicUrl }; }
  req.tenant = tenantInfo;
  requestStore.run({ req, tenant: tenantInfo }, () => handle(req, res, url, tenantInfo));
}

export function start() {
  db.openDb();
  try { fs.mkdirSync(config.brandsDir, { recursive: true }); } catch { /* read-only data dir is fine */ }
  startScanner();
  startModeration();
  startApkSync();
  const server = http.createServer(handler);
  server.requestTimeout = 0;           // long SSE streams and slow 4G chunk uploads
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.listen(config.port, config.host, () => console.log(`JS Live Photo on http://${config.host}:${config.port} (photos: ${config.photosDir}, tenant zone: ${config.tenantZone})`));
  const stop = () => { stopScanner(); stopModeration(); stopApkSync(); server.close(); db.closeDb(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
