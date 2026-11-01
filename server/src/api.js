// HTTP API (Live Photo v4). Route groups:
//   /auth/*            6-digit code login (guest / photographer / organiser)
//   /api/e/:token/*    guest gallery + upload (by link token, upload needs the guest code)
//   /api/shoot/*       photographer (web or the JS Tether app)
//   /api/admin/*       admin, behind Cloudflare Access
//   /api/client/*      organiser panel (client code), limited to its own event
//   /api/uploads/*     chunked, resumable uploads shared by everyone
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';
import * as auth from './auth.js';
import * as storage from './storage.js';
import { sniff, imageSizeOfFile, stripWebpMetadata } from './imageinfo.js';
import { subscribe, publish, publishPhoto, setPhotoSerializer, viewerCount } from './live.js';
import { findFaces, checkPhoto } from './moderation.js';
import { apkInfo, refreshApk, sendApk } from './apk.js';
import { zipPlan } from './zip.js';
import { Router, HttpError, fail, sendJson, readJson, readBody, clientIp, randomToken, shortToken, uuid } from './http.js';

export const router = new Router();
const r = (m, p, h) => router.add(m, p, h);

const guestIpLimit = (() => {
  const hits = new Map();
  return (ip) => {
    const t = Date.now(), arr = (hits.get(ip) || []).filter((x) => t - x < 3600e3);
    arr.push(t); hits.set(ip, arr);
    return arr.length <= config.guestUploadsPerHour;
  };
})();

// ---------------- serializers ----------------
export function photoJson(p) {
  let flags = [], fc;
  try { flags = JSON.parse(p.flags || '[]'); } catch { /* ignore */ }
  try { if (p.faces && p.faces !== '[]') fc = JSON.parse(p.faces); } catch { /* ignore */ }
  return { fc, id: p.id, seq: p.seq, w: p.width, h: p.height, src: p.source, slot: p.slot, by: p.uploader || '', t: p.created_at,
    th: p.thumbs, hidden: !!p.hidden, status: p.status, flags, name: path.posix.basename(p.rel_path) };
}
setPhotoSerializer(photoJson);

const galleryUrl = (ev) => `${config.publicUrl}/e/${ev.public_token}`;
const codeUrl = (code) => `${config.publicUrl}/c/${code}`;
const parseReq = (ev) => { try { return ev.request ? JSON.parse(ev.request) : null; } catch { return null; } };

// QR on the big screen, shown from the admin or organiser panel for settings.qrSec seconds (in memory only).
const qrUntil = new Map(); // eventId -> ms
// Big screen mode per event: 'photos' (normal) | 'black' | 'admin' | 'bg1' | 'bg2' (in memory; a restart goes back to photos)
const screenMode = new Map();
const SCREEN_MODES = ['photos', 'black', 'admin', 'bg1', 'bg2'];
// Photo pinned to the big screen: eventId -> { id, until } (until 0 = locked until Release)
const pins = new Map();
const pinState = (id) => { const p = pins.get(id); if (p && p.until && p.until < Date.now()) { pins.delete(id); return null; } return p || null; };
// Backgrounds: admin (one for every event) and organiser background 1 (per event) are files; background 2 is a guest photo.
const bgDir = () => path.join(config.dataDir, 'backgrounds');
const bgFile = (name) => path.join(bgDir(), name);
const adminBg = () => bgFile('admin');
const bg1File = (evId) => bgFile(`event-${evId}`);
function bgInfo(ev) {
  const s = db.settingsOf(ev);
  const p2 = s.bg2 ? db.getPhoto(s.bg2) : null;
  return { admin: fs.existsSync(adminBg()), bg1: fs.existsSync(bg1File(ev.id)), bg2: p2 && p2.event_id === ev.id ? p2.id : null };
}
async function saveBg(req, file) {
  const buf = await readBody(req, 15 * 1024 * 1024);
  if (!['webp', 'jpeg'].includes(sniff(buf))) fail(415, 'Use a JPEG or WebP picture');
  fs.mkdirSync(bgDir(), { recursive: true });
  fs.writeFileSync(file + '.tmp', buf);
  fs.renameSync(file + '.tmp', file);
}
function sendBg(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { fail(404, 'No background'); }
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': sniff(buf) === 'webp' ? 'image/webp' : 'image/jpeg', 'content-length': st.size, 'cache-control': 'private, no-cache', etag: `"bg-${Math.floor(st.mtimeMs)}"` });
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const qrState = (id) => { const u = qrUntil.get(id) || 0; return u > Date.now() ? u : 0; };

// ---- download-all link: made when the event ends or is closed, valid DL_DAYS, +DL_DAYS each time the admin extends ----
const DL_DAYS = 7;
const dlUrl = (ev) => `${config.publicUrl}/d/${ev.dl_token}`;
function ensureDownload(ev) {
  const st = db.status(ev);
  if (ev.dl_token || (st !== 'closed' && st !== 'ended')) return ev;
  return db.updateEvent(ev.id, { dl_token: randomToken(18), dl_until: Date.now() + DL_DAYS * 86400e3 });
}
const dlActive = (ev) => !!ev.dl_token && (ev.dl_until || 0) > Date.now();
function dlJson(ev, role) {
  if (!ev.dl_token) return null;
  if (role === 'client' && !dlActive(ev)) return { active: false, until: ev.dl_until };
  return { url: dlUrl(ev), until: ev.dl_until, active: dlActive(ev) };
}

function staffEventJson(ev, role = 'admin') {
  ev = ensureDownload(ev);
  const c = db.eventCounts(ev.id);
  return {
    id: ev.id, folder: ev.folder_name, date: ev.date, title: ev.title, organiser: ev.organiser, hideName: !!ev.hide_name,
    token: ev.public_token, url: galleryUrl(ev), status: db.status(ev), startsAt: ev.starts_at, endsAt: ev.ends_at, closedAt: ev.closed_at,
    codes: { public: ev.public_code, photographer: ev.photo_code, client: ev.client_code },
    codeUrl: codeUrl(ev.public_code), publicUpload: !!ev.public_upload_on, showcase: !!ev.showcase,
    settings: db.settingsOf(ev), request: parseReq(ev), createdAt: ev.created_at, download: dlJson(ev, role), qrUntil: qrState(ev.id), screenMode: screenMode.get(ev.id) || 'photos', pin: pinState(ev.id), bg: bgInfo(ev),
    photoCount: c.photo_count || 0, guestCount: c.guest_count || 0, reviewCount: c.review_count || 0, blockedCount: c.blocked_count || 0,
  };
}
function publicEventJson(ev) {
  return { title: ev.title, date: ev.date, organiser: ev.organiser, status: db.status(ev), endsAt: ev.ends_at, url: galleryUrl(ev) };
}

const intOrNull = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function requireStorage() { if (!storage.storageOnline()) fail(503, 'Storage offline, try again shortly', { retry: true }); }
function eventOr404(id) { const ev = db.getEvent(id); if (!ev) fail(404, 'Event not found'); return ev; }

// ---------------- code login ----------------
r('GET', '/auth/config', (req, res) => sendJson(res, 200, { whatsapp: config.whatsapp, contactUrl: config.contactUrl }));

r('POST', '/auth/code', async (req, res) => {
  const body = await readJson(req);
  const want = ['guest', 'photographer', 'client'].includes(body.want) ? body.want : undefined;
  const { token, role, session, event } = auth.loginWithCode({ code: body.code, name: body.name, want, ip: clientIp(req) });
  const next = role === 'guest' ? `/e/${event.public_token}` : role === 'photographer' ? '/shoot' : '/panel';
  const out = { role, next, event: publicEventJson(event) };
  if (role === 'photographer') Object.assign(out, { slot: session.slot, name: session.name, eventId: event.id });
  if (body.app) out.token = token; // the Android app keeps it as a bearer token
  sendJson(res, 200, out, { 'set-cookie': auth.sessionCookie(role, token, event) });
});
r('POST', '/auth/logout', async (req, res) => {
  const body = await readJson(req);
  const role = ['guest', 'photographer', 'client'].includes(body.role) ? body.role : 'guest';
  auth.logout(req, role);
  sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie(role) });
});
// Which code sessions this browser holds right now.
r('GET', '/api/me', (req, res) => {
  const out = {};
  for (const role of ['guest', 'photographer', 'client']) {
    const s = auth.sessionFor(req, role);
    if (s) out[role] = { event: publicEventJson(s.event), eventId: s.event.id, token: role === 'guest' ? s.event.public_token : undefined, name: s.session.name, slot: s.session.slot };
  }
  sendJson(res, 200, out);
});

// ---------------- live status (landing page + johorstudio.com tab) ----------------
r('GET', '/api/live-status', (req, res) => {
  const origin = req.headers.origin;
  const headers = { 'cache-control': 'public, max-age=30' };
  if (origin && config.siteOrigins.includes(origin)) Object.assign(headers, { 'access-control-allow-origin': origin, vary: 'Origin' });
  const live = db.nowLive().map((e) => ({ id: e.id, name: e.hide_name ? 'Event in progress' : e.title, organiser: e.organiser || '', date: e.date, startsAt: e.starts_at, endsAt: e.ends_at }));
  sendJson(res, 200, { live, count: live.length }, headers);
});

// ---------------- download all (organiser link) ----------------
function dlEvent(token) {
  const ev = db.eventByDownloadToken(String(token || ''));
  if (!ev) fail(404, 'This download link is not valid');
  return ev;
}
function zipEntries(ev, part) {
  const used = new Set();
  const out = [];
  for (const p of db.zipPhotos(ev.id)) {
    const guest = p.source === 'public';
    if ((part === 'guests') !== guest) continue;
    const file = storage.photoFile(ev, p);
    let st; try { st = fs.statSync(file); } catch { continue; }
    let name = guest ? `Guests/${path.posix.basename(p.rel_path)}` : p.rel_path;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/(\.[^.]+)?$/, (m) => ` (${n})${m}`);
    used.add(name.toLowerCase());
    out.push({ name, file, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}
r('GET', '/api/d/:token', (req, res, { params }) => {
  const ev = dlEvent(params.token);
  const parts = {};
  for (const part of ['photographers', 'guests']) {
    const e = zipEntries(ev, part);
    parts[part] = { count: e.length, bytes: e.length ? zipPlan(e).size : 0 };
  }
  sendJson(res, 200, {
    event: { title: ev.title, date: ev.date, organiser: ev.organiser, url: galleryUrl(ev) },
    until: ev.dl_until, active: dlActive(ev), days: DL_DAYS, extendPrice: 'RM100', whatsapp: config.whatsapp, parts,
  });
});
r('GET', '/api/d/:token/zip/:part', (req, res, { params }) => {
  const ev = dlEvent(params.token);
  if (!dlActive(ev)) fail(410, 'This download link has expired');
  if (!['photographers', 'guests'].includes(params.part)) fail(404, 'Not found');
  requireStorage();
  const entries = zipEntries(ev, params.part);
  if (!entries.length) fail(404, 'No photos here');
  const plan = zipPlan(entries);
  const fname = `${storage.cleanTitle(ev.title) || 'Event'} - ${params.part === 'guests' ? 'Guests' : 'Photographers'}.zip`;
  res.writeHead(200, {
    'content-type': 'application/zip', 'content-length': plan.size, 'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${fname.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
  });
  if (req.method === 'HEAD') return res.end();
  plan.pipe(res);
});

// ---------------- guest gallery ----------------
function eventByToken(token) {
  const ev = db.getEventByToken(token);
  if (!ev) fail(404, 'This gallery link is not valid');
  return ev;
}
function guestState(req, ev) {
  const s = auth.sessionFor(req, 'guest', ev.id);
  const live = db.isLive(ev);
  const used = s ? s.session.uploads : 0;
  return {
    signedIn: !!s, agreed: !!s?.session.agreed, live, uploadsOpen: live && !!ev.public_upload_on,
    canUpload: !!s && live && !!ev.public_upload_on, uploadsLeft: Math.max(0, config.guestUploadsPerEvent - used),
  };
}
r('GET', '/api/e/:token', (req, res, { params }) => {
  const ev = eventByToken(params.token);
  sendJson(res, 200, {
    event: publicEventJson(ev), guest: guestState(req, ev), photos: db.galleryPhotos(ev.id, {}).map(photoJson),
    maxGuestBytes: config.maxGuestBytes, whatsapp: config.whatsapp,
  });
});
r('GET', '/api/e/:token/photos', (req, res, { params, query }) => {
  const ev = eventByToken(params.token);
  sendJson(res, 200, { photos: db.galleryPhotos(ev.id, { before: intOrNull(query.get('before')), after: intOrNull(query.get('after')) }).map(photoJson) });
});
r('GET', '/api/e/:token/stream', (req, res, { params }) => subscribe(eventByToken(params.token).id, req, res));
r('POST', '/api/e/:token/agree', (req, res, { params }) => {
  const ev = eventByToken(params.token);
  const s = auth.requireSession(req, 'guest', ev.id);
  db.setAgreed(s.session.id);
  sendJson(res, 200, { guest: guestState(req, ev) });
});
r('GET', '/p/:token/:photo/:size', (req, res, { params, query }) => {
  const ev = eventByToken(params.token);
  const p = db.getPhoto(params.photo);
  if (!p || p.event_id !== ev.id || p.hidden || p.status !== 'approved') fail(404, 'Photo not found');
  serveImage(req, res, ev, p, params.size, query.get('dl') === '1', 'public, max-age=86400');
});

// ---------------- landing page sample ----------------
r('GET', '/api/showcase', (req, res) => {
  const ev = db.showcaseEvent();
  if (!ev) return sendJson(res, 200, { event: null, photos: [] });
  sendJson(res, 200, { event: { title: ev.title, date: ev.date }, photos: db.randomPhotos(ev.id, 24).map(photoJson) });
});
r('GET', '/s/:photo/:size', (req, res, { params }) => {
  const p = db.getPhoto(params.photo);
  const ev = p && db.getEvent(p.event_id);
  if (!ev || !ev.showcase || p.hidden || p.status !== 'approved' || params.size === 'orig') fail(404, 'Not found');
  serveImage(req, res, ev, p, params.size, false, 'public, max-age=86400');
});

// ---------------- photographer ----------------
r('GET', '/api/shoot', (req, res) => {
  const { session, event } = auth.requireSession(req, 'photographer');
  sendJson(res, 200, { event: { ...publicEventJson(event), id: event.id }, name: session.name, slot: session.slot, folder: storage.sourceFolder('photographer', session.slot) });
});

// ---------------- chunked uploads ----------------
// 1) POST start -> {id, chunk}   2) PUT /api/uploads/:id?offset=N (repeat, resumable)
// 3) PUT /api/uploads/:id/thumb/480|1600 (optional)   4) POST /api/uploads/:id/complete
const cleanKey = (k) => (typeof k === 'string' && k.length > 2 && k.length <= 300 ? k : '');
function startUpload(res, ev, { source, slot, sessionId, uploader, name, size, ip, dupKey = '' }) {
  requireStorage();
  if (dupKey) {
    // Same original file (name|size|time taken) already in this event: say so instead of a second copy.
    const sent = db.sentKey(ev.id, dupKey);
    const photo = sent && db.getPhoto(sent.photo_id);
    if (photo && photo.event_id === ev.id) return sendJson(res, 200, { duplicate: true, photo: photoJson(photo) });
    // Started before (e.g. the phone lost signal): resume that upload.
    const open = db.openUploadByKey(ev.id, dupKey);
    if (open && open.session_id === sessionId && Number(size) === open.size) {
      return sendJson(res, 200, { id: open.id, chunk: config.chunkBytes, received: open.received, size: open.size, name: path.posix.basename(open.rel_path), slot: open.slot, resumed: true });
    }
  }
  size = Number(size);
  const max = source === 'public' ? config.maxGuestBytes : config.maxUploadBytes;
  if (!Number.isInteger(size) || size <= 0) fail(400, 'File size is required');
  if (size > max) fail(413, `Photo is too large (max ${Math.round(max / 1048576)} MB)`);
  const fileName = source === 'public'
    ? `guest-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${shortToken(4)}.webp`
    : storage.cleanFileName(name);
  const relPath = storage.uniqueRelPath(ev, storage.sourceFolder(source, slot), fileName);
  const up = db.createUpload({ id: randomToken(24), eventId: ev.id, sessionId, source, slot, uploader, relPath, size, clientIp: ip, dupKey });
  fs.writeFileSync(storage.partFile(ev, relPath), '');
  sendJson(res, 201, { id: up.id, chunk: config.chunkBytes, received: 0, size, name: path.posix.basename(relPath), slot });
}
r('POST', '/api/shoot/uploads', async (req, res) => {
  const { session, event } = auth.requireSession(req, 'photographer');
  const body = await readJson(req);
  startUpload(res, event, { source: 'photographer', slot: session.slot, sessionId: session.id, uploader: session.name, name: body.name, size: body.size, ip: clientIp(req), dupKey: cleanKey(body.key) });
});
// Which of these files (original name|size|time taken) are already in the event? For the app/web upload log.
r('POST', '/api/shoot/check', async (req, res) => {
  const { event } = auth.requireSession(req, 'photographer');
  const body = await readJson(req);
  const keys = (Array.isArray(body.keys) ? body.keys : []).slice(0, 1000).map(cleanKey).filter(Boolean);
  sendJson(res, 200, { sent: keys.filter((k) => db.sentKey(event.id, k)) });
});
// JS Tether APK, only for signed-in photographers (and admins below).
const apkJson = (m) => (m ? { name: m.name, version: m.version, size: m.size, tag: m.tag, published: m.published } : null);
r('GET', '/api/shoot/app', (req, res) => { auth.requireSession(req, 'photographer'); sendJson(res, 200, { apk: apkJson(apkInfo()) }); });
r('GET', '/api/shoot/app.apk', (req, res) => {
  auth.requireSession(req, 'photographer');
  const m = apkInfo(); if (!m) fail(404, 'The app is not available yet');
  sendApk(req, res, m);
});
// Old v3 app route, kept so a v3 app gets a clear message.
r('POST', '/api/events/:id/uploads', () => fail(426, 'Update JS Tether: this event uses photographer codes now'));

r('POST', '/api/e/:token/uploads', async (req, res, { params }) => {
  const ev = eventByToken(params.token);
  const s = auth.requireSession(req, 'guest', ev.id);
  if (!ev.public_upload_on) fail(403, 'Guest uploads are closed for this event');
  if (!s.session.agreed) fail(428, 'Please accept the photo notice first');
  if (s.session.uploads + db.openUploadsFor(s.session.id) >= config.guestUploadsPerEvent) fail(429, `You have reached the limit of ${config.guestUploadsPerEvent} photos for this event. Thank you!`);
  const ip = clientIp(req);
  if (!guestIpLimit(ip)) fail(429, 'Too many uploads from this network. Try again later.');
  const body = await readJson(req);
  if (!/\.webp$/i.test(String(body.name || 'photo.webp'))) fail(415, 'Only WebP photos can be uploaded');
  startUpload(res, ev, { source: 'public', slot: null, sessionId: s.session.id, uploader: auth.cleanName(body.uploader, 20), name: 'photo.webp', size: body.size, ip });
});

function uploadFor(id) {
  const up = db.getUpload(id);
  if (!up) fail(404, 'Upload not found or expired. Start again.');
  const ev = db.getEvent(up.event_id);
  if (!ev) { db.deleteUpload(id); fail(410, 'The event was deleted'); }
  return { up, ev };
}
r('GET', '/api/uploads/:id', (req, res, { params }) => {
  const { up } = uploadFor(params.id);
  sendJson(res, 200, { id: up.id, received: up.received, size: up.size });
});
r('PUT', '/api/uploads/:id', async (req, res, { params, query }) => {
  const { up, ev } = uploadFor(params.id);
  requireStorage();
  const offset = Number(query.get('offset') || 0);
  if (offset !== up.received) return sendJson(res, 409, { error: 'Wrong offset, resume from received', received: up.received });
  const buf = await readBody(req, config.chunkBytes + 1024);
  if (offset + buf.length > up.size) fail(400, 'More data than the declared size');
  if (offset === 0) {
    const type = sniff(buf);
    if (up.source === 'public' ? type !== 'webp' : !type) {
      db.deleteUpload(up.id); fs.rmSync(storage.partFile(ev, up.rel_path), { force: true });
      fail(415, up.source === 'public' ? 'Only WebP photos can be uploaded' : 'Only WebP or JPEG photos can be uploaded');
    }
  }
  const fd = fs.openSync(storage.partFile(ev, up.rel_path), 'r+');
  try { fs.writeSync(fd, buf, 0, buf.length, offset); fs.ftruncateSync(fd, offset + buf.length); } finally { fs.closeSync(fd); }
  db.setUploadReceived(up.id, offset + buf.length);
  sendJson(res, 200, { received: offset + buf.length, size: up.size });
});
r('PUT', '/api/uploads/:id/thumb/:size', async (req, res, { params }) => {
  const { up } = uploadFor(params.id);
  const bit = storage.THUMB_SIZES[params.size];
  if (!bit) fail(400, 'Size must be 480 or 1600');
  const buf = await readBody(req, 4 * 1024 * 1024);
  if (!sniff(buf)) fail(415, 'Thumbnail must be WebP or JPEG');
  const dir = path.join(config.dataDir, 'uploads', up.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, params.size), buf);
  db.addUploadThumb(up.id, bit);
  sendJson(res, 200, { ok: true });
});
r('POST', '/api/uploads/:id/complete', (req, res, { params }) => {
  const { up, ev } = uploadFor(params.id);
  requireStorage();
  if (up.received !== up.size) fail(400, `Upload incomplete (${up.received}/${up.size} bytes)`);
  const part = storage.partFile(ev, up.rel_path);
  if (up.source === 'public') stripWebpMetadata(part);
  const info = imageSizeOfFile(part);
  if (!info.width) { fs.rmSync(part, { force: true }); db.deleteUpload(up.id); fail(415, 'The file is not a readable photo'); }
  const final = path.join(storage.eventDir(ev), up.rel_path);
  fs.renameSync(part, final);
  const st = fs.statSync(final);
  const photoId = uuid();
  const tdir = path.join(config.dataDir, 'uploads', up.id);
  let thumbs = 0;
  for (const [size, bit] of Object.entries(storage.THUMB_SIZES)) {
    const t = path.join(tdir, size);
    if (fs.existsSync(t)) { fs.mkdirSync(storage.thumbDir(ev.id), { recursive: true }); fs.renameSync(t, storage.thumbFile(ev.id, photoId, size)); thumbs |= bit; }
  }
  fs.rmSync(tdir, { recursive: true, force: true });
  const guest = up.source === 'public';
  const { photo } = db.upsertPhoto({ id: photoId, eventId: ev.id, relPath: up.rel_path, source: up.source, slot: up.slot, uploader: up.uploader,
    status: guest ? 'pending' : 'approved', width: info.width, height: info.height, bytes: st.size, mtime: Math.floor(st.mtimeMs), thumbs });
  db.deleteUpload(up.id);
  if (up.dup_key) db.addSentKey(ev.id, up.dup_key, photo.id);
  if (guest && up.session_id) db.bumpUploads(up.session_id);
  publishPhoto(photo);
  if (guest) checkPhoto(photo); else findFaces(photo);
  sendJson(res, 200, { photo: photoJson(photo) });
});
r('DELETE', '/api/uploads/:id', (req, res, { params }) => {
  const { up, ev } = uploadFor(params.id);
  fs.rmSync(storage.partFile(ev, up.rel_path), { force: true });
  fs.rmSync(path.join(config.dataDir, 'uploads', up.id), { recursive: true, force: true });
  db.deleteUpload(up.id);
  sendJson(res, 200, { ok: true });
});

// ---------------- staff: admin (Cloudflare Access) and organiser (client code) ----------------
// The same event routes exist under /api/admin and /api/client; `who` decides what is allowed.
async function staffFor(req, prefix, eventId) {
  if (prefix === 'admin') { const a = await auth.requireAdmin(req); return { role: 'admin', email: a.email, ev: eventOr404(eventId) }; }
  const s = auth.requireSession(req, 'client', eventId);
  return { role: 'client', ev: s.event, session: s.session };
}
function photoOfEvent(ev, id) {
  const p = db.getPhoto(id);
  if (!p || p.event_id !== ev.id) fail(404, 'Photo not found');
  return p;
}
for (const prefix of ['admin', 'client']) {
  const P = `/api/${prefix}`;
  r('GET', `${P}/events/:id`, async (req, res, { params }) => {
    const { ev, role } = await staffFor(req, prefix, params.id);
    const out = { event: staffEventJson(ev, role), viewers: viewerCount(ev.id), role };
    if (role === 'admin') {
      out.photographers = db.listPhotographers(ev.id);
      out.devices = db.activeDevices(ev.id);
    }
    sendJson(res, 200, out);
  });
  r('GET', `${P}/events/:id/photos`, async (req, res, { params, query }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const photos = db.galleryPhotos(ev.id, { staff: true, filter: query.get('filter') || 'all', source: query.get('source') || 'all',
      before: intOrNull(query.get('before')), after: intOrNull(query.get('after')) });
    sendJson(res, 200, { photos: photos.map(photoJson) });
  });
  r('GET', `${P}/events/:id/stream`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    subscribe(ev.id, req, res, true);
  });
  // Allow (approve a flagged/blocked photo) or hide/show.
  r('PATCH', `${P}/events/:id/photos/:photo`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const p = photoOfEvent(ev, params.photo);
    const body = await readJson(req);
    if ('hidden' in body) db.setPhotoHidden(p.id, body.hidden);
    if (body.status === 'approved') db.setPhotoStatus(p.id, 'approved');
    const out = db.getPhoto(p.id);
    publishPhoto(out);
    sendJson(res, 200, { photo: photoJson(out) });
  });
  r('DELETE', `${P}/events/:id/photos/:photo`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    storage.deletePhoto(ev, photoOfEvent(ev, params.photo));
    sendJson(res, 200, { ok: true });
  });
  // Admin / organiser upload or camera: needs a nickname, no AI check (approved at once).
  r('POST', `${P}/events/:id/uploads`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    const uploader = auth.cleanName(body.uploader, 20);
    if (!uploader) fail(400, 'Type your nickname first');
    startUpload(res, ev, { source: 'other', slot: null, sessionId: null, uploader, name: body.name, size: body.size, ip: clientIp(req), dupKey: cleanKey(body.key) });
  });
  // Big screen mode: photos, black, or a background (admin / organiser 1 / organiser 2).
  r('POST', `${P}/events/:id/screen`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    const mode = SCREEN_MODES.includes(body.mode) ? body.mode : body.on === false ? 'black' : 'photos';
    const bg = bgInfo(ev);
    if ((mode === 'admin' && !bg.admin) || (mode === 'bg1' && !bg.bg1) || (mode === 'bg2' && !bg.bg2)) fail(400, 'Set that background first');
    if (mode === 'photos') screenMode.delete(ev.id); else screenMode.set(ev.id, mode);
    publish(ev.id, 'screen', { mode, v: Date.now() });
    sendJson(res, 200, { mode });
  });
  // Background pictures for the big screen.
  r('GET', `${P}/events/:id/bg/:which`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    if (params.which === 'admin') return sendBg(req, res, adminBg());
    if (params.which === 'bg1') return sendBg(req, res, bg1File(ev.id));
    if (params.which === 'bg2') { const id = bgInfo(ev).bg2; if (!id) fail(404, 'No background'); return serveImage(req, res, ev, db.getPhoto(id), 'orig', false, 'private, no-cache'); }
    fail(404, 'Not found');
  });
  r('PUT', `${P}/events/:id/bg/bg1`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    await saveBg(req, bg1File(ev.id));
    if (screenMode.get(ev.id) === 'bg1') publish(ev.id, 'screen', { mode: 'bg1', v: Date.now() });
    sendJson(res, 200, { bg: bgInfo(ev) });
  });
  r('DELETE', `${P}/events/:id/bg/bg1`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    fs.rmSync(bg1File(ev.id), { force: true });
    if (screenMode.get(ev.id) === 'bg1') { screenMode.delete(ev.id); publish(ev.id, 'screen', { mode: 'photos' }); }
    sendJson(res, 200, { bg: bgInfo(ev) });
  });
  // Background 2 = a guest photo of this event (or none).
  r('POST', `${P}/events/:id/bg/bg2`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    let id = null;
    if (body.photoId) { const p = photoOfEvent(ev, body.photoId); if (p.source !== 'public') fail(400, 'Background 2 comes from a guest photo'); id = p.id; }
    const s = { ...db.settingsOf(ev), bg2: id };
    const out = db.updateEvent(ev.id, { settings: JSON.stringify(s) });
    if (screenMode.get(ev.id) === 'bg2') { if (id) publish(ev.id, 'screen', { mode: 'bg2', v: Date.now() }); else { screenMode.delete(ev.id); publish(ev.id, 'screen', { mode: 'photos' }); } }
    sendJson(res, 200, { bg: bgInfo(out) });
  });
  // Pin a photo to the big screen: sec 10/20/30/60, or 0 = locked until released. {release: true} lets the slideshow carry on.
  r('POST', `${P}/events/:id/pin`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    if (body.release) { pins.delete(ev.id); publish(ev.id, 'pin', { pin: null }); return sendJson(res, 200, { pin: null }); }
    const p = photoOfEvent(ev, body.photoId);
    if (p.status !== 'approved') fail(400, 'Allow the photo first');
    const sec = [0, 10, 20, 30, 60].includes(Number(body.sec)) ? Number(body.sec) : 0;
    const pin = { id: p.id, until: sec ? Date.now() + sec * 1000 : 0 };
    pins.set(ev.id, pin);
    publish(ev.id, 'pin', { pin, photo: photoJson(p) });
    sendJson(res, 200, { pin });
  });
  // "Upload your photos!" message: on/off, text, every N s without new photos, shown for N s; {now: true} shows it at once.
  r('POST', `${P}/events/:id/bubble`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    const s = { ...db.settingsOf(ev) };
    const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || lo));
    if ('on' in body) s.bubbleOn = !!body.on;
    if (body.text != null) s.bubbleText = String(body.text).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || 'Upload your photos!';
    if (body.every != null) s.bubbleEvery = num(body.every, 10, 3600);
    if (body.for != null) s.bubbleFor = num(body.for, 3, 600);
    if (body.now) s.bubbleOn = true; // "Show now" also switches it on
    const out = db.updateEvent(ev.id, { settings: JSON.stringify(s) });
    publish(ev.id, 'settings', { settings: db.settingsOf(out), code: out.public_code });
    if (body.now) publish(ev.id, 'bubble', { now: true });
    sendJson(res, 200, { settings: db.settingsOf(out) });
  });
  // Show / hide the QR popup on the big screen (LED at the event).
  r('POST', `${P}/events/:id/qr`, async (req, res, { params }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    const body = await readJson(req);
    const until = body.on ? Date.now() + db.settingsOf(ev).qrSec * 1000 : 0;
    if (until) qrUntil.set(ev.id, until); else qrUntil.delete(ev.id);
    publish(ev.id, 'qr', { until, code: ev.public_code, url: codeUrl(ev.public_code) });
    sendJson(res, 200, { until });
  });
  r('GET', `${P}/events/:id/photos/:photo/img/:size`, async (req, res, { params, query }) => {
    const { ev } = await staffFor(req, prefix, params.id);
    serveImage(req, res, ev, photoOfEvent(ev, params.photo), params.size, query.get('dl') === '1', 'private, max-age=300');
  });
}

// Organiser asks the admin to start (with a time) or close the event.
r('POST', '/api/client/events/:id/request', async (req, res, { params }) => {
  const { ev } = await staffFor(req, 'client', params.id);
  const body = await readJson(req);
  if (!['activate', 'close'].includes(body.type)) fail(400, 'Unknown request');
  const startsAt = body.type === 'activate' ? (intOrNull(body.startsAt) || Date.now()) : null;
  db.updateEvent(ev.id, { request: JSON.stringify({ type: body.type, startsAt, at: Date.now() }) });
  sendJson(res, 200, { event: staffEventJson(db.getEvent(ev.id), 'client') });
});
r('GET', '/api/client/me', (req, res) => {
  const s = auth.requireSession(req, 'client');
  sendJson(res, 200, { event: staffEventJson(s.event, 'client') });
});

// ---------------- admin only ----------------
const A = (method, p, h) => r(method, `/api/admin${p}`, async (req, res, ctx) => { const admin = await auth.requireAdmin(req); return h(req, res, ctx, admin); });
// Admin background: one picture for the big screen of every event.
A('GET', '/background', (req, res) => sendBg(req, res, adminBg()));
A('PUT', '/background', async (req, res) => { await saveBg(req, adminBg()); sendJson(res, 200, { ok: true }); });
A('DELETE', '/background', (req, res) => { fs.rmSync(adminBg(), { force: true }); sendJson(res, 200, { ok: true }); });
A('GET', '/background/info', (req, res) => sendJson(res, 200, { admin: fs.existsSync(adminBg()) }));

A('GET', '/me', (req, res, ctx, admin) => sendJson(res, 200, { email: admin.email, storageOnline: storage.storageOnline(), publicUrl: config.publicUrl, maxLive: config.maxLiveEvents }));
A('GET', '/events', (req, res) => {
  const list = db.listEvents().map((e) => ({ ...staffEventJson(e), photoCount: e.photo_count, guestCount: e.guest_count, reviewCount: e.review_count }));
  sendJson(res, 200, { events: list, liveCount: db.nowLive().length });
});
A('POST', '/events', async (req, res) => {
  const body = await readJson(req);
  const ev = storage.createEvent({ date: String(body.date || ''), title: body.title, organiser: body.organiser || '' });
  sendJson(res, 201, { event: staffEventJson(ev) });
});

function setCode(ev, field, value) {
  const code = String(value || '').replace(/\D/g, '');
  if (code.length !== 6) fail(400, 'Codes must be 6 digits');
  if (db.codeTaken(code, ev.id) || [ev.public_code, ev.photo_code, ev.client_code].filter((c, i) => ['public_code', 'photo_code', 'client_code'][i] !== field).includes(code)) {
    fail(409, 'That code is already used by an event. Choose another.');
  }
  return code;
}
A('PATCH', '/events/:id', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  const f = {};
  if ('organiser' in body) f.organiser = storage.cleanTitle(body.organiser);
  if ('hideName' in body) f.hide_name = body.hideName ? 1 : 0;
  if ('publicUpload' in body) f.public_upload_on = body.publicUpload ? 1 : 0;
  if ('showcase' in body) f.showcase = body.showcase ? 1 : 0;
  if (body.newLink) f.public_token = shortToken();
  if (body.codes) {
    if (body.codes.public) f.public_code = setCode(ev, 'public_code', body.codes.public);
    if (body.codes.photographer) f.photo_code = setCode(ev, 'photo_code', body.codes.photographer);
    if (body.codes.client) f.client_code = setCode(ev, 'client_code', body.codes.client);
  }
  if (body.randomCode) {
    const field = { public: 'public_code', photographer: 'photo_code', client: 'client_code' }[body.randomCode];
    if (!field) fail(400, 'Unknown code');
    f[field] = db.newCode(ev.id, [ev.public_code, ev.photo_code, ev.client_code]);
  }
  if (body.settings) {
    const s = { ...db.settingsOf(ev) };
    const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v)));
    if (body.settings.newSec != null) s.newSec = num(body.settings.newSec, 1, 30);
    if (body.settings.loopSec != null) s.loopSec = num(body.settings.loopSec, 1, 60);
    if (body.settings.idleMin != null) s.idleMin = num(body.settings.idleMin, 1, 60);
    if (body.settings.qrSec != null) s.qrSec = num(body.settings.qrSec, 5, 600);
    if (['all', 'public', 'photographer'].includes(body.settings.loopSource)) s.loopSource = body.settings.loopSource;
    f.settings = JSON.stringify(s);
  }
  const out = db.updateEvent(ev.id, f);
  try { storage.writeMeta(out); } catch { /* storage offline: DB still updated */ }
  if (body.newLink) publish(ev.id, 'gone', {});
  if (f.public_code || f.photo_code) {
    // A changed guest/photographer code logs out devices that used the old one.
    if (f.public_code) db.revokeEventSessions(ev.id, ['guest']);
    if (f.photo_code) db.revokeEventSessions(ev.id, ['photographer']);
  }
  if (f.settings || f.public_code) publish(ev.id, 'settings', { settings: db.settingsOf(out), code: out.public_code });
  sendJson(res, 200, { event: staffEventJson(out) });
});

// Start the live window: new guest + photographer codes (unless keepCodes), 8 h from startsAt.
A('POST', '/events/:id/activate', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  const startsAt = intOrNull(body.startsAt) || Date.now();
  const hours = Math.min(24, Math.max(1, Number(body.hours) || config.liveHours));
  const f = { starts_at: startsAt, ends_at: startsAt + hours * 3600e3, closed_at: null, request: null };
  if (!body.keepCodes) {
    f.public_code = db.newCode(ev.id, [ev.public_code, ev.photo_code, ev.client_code]);
    f.photo_code = db.newCode(ev.id, [ev.public_code, ev.photo_code, ev.client_code, f.public_code]);
  }
  db.revokeEventSessions(ev.id, ['guest', 'photographer']);
  const out = db.updateEvent(ev.id, f);
  try { storage.writeMeta(out); } catch { /* ignore */ }
  const live = db.nowLive().length;
  publish(ev.id, 'settings', { settings: db.settingsOf(out), code: out.public_code });
  sendJson(res, 200, { event: staffEventJson(out), warning: live > config.maxLiveEvents ? `${live} events are live at the same time (recommended max ${config.maxLiveEvents}).` : null });
});
A('POST', '/events/:id/extend', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  if (!db.isLive(ev) && db.status(ev) !== 'scheduled') fail(400, 'The event is not live');
  const hours = [1, 2].includes(Number(body.hours)) ? Number(body.hours) : 1;
  sendJson(res, 200, { event: staffEventJson(db.updateEvent(ev.id, { ends_at: ev.ends_at + hours * 3600e3 })) });
});
// Close now: guests and photographers are logged out and the guest code changes.
A('POST', '/events/:id/close', (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const t = Date.now();
  db.revokeEventSessions(ev.id, ['guest', 'photographer']);
  const out = db.updateEvent(ev.id, { closed_at: t, ends_at: Math.min(ev.ends_at || t, t), request: null,
    public_code: db.newCode(ev.id, [ev.public_code, ev.photo_code, ev.client_code]) });
  try { storage.writeMeta(out); } catch { /* ignore */ }
  publish(ev.id, 'closed', {});
  sendJson(res, 200, { event: staffEventJson(out) });
});
// Download link: {action: 'extend'} adds 7 days (after payment), 'create' makes one now, 'new' replaces the link.
A('POST', '/events/:id/download', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  const t = Date.now();
  let f;
  if (body.action === 'extend') {
    if (!ev.dl_token) fail(400, 'There is no download link yet');
    f = { dl_until: Math.max(t, ev.dl_until || 0) + DL_DAYS * 86400e3 };
  } else if (body.action === 'create' || body.action === 'new') {
    f = { dl_token: randomToken(18), dl_until: body.action === 'new' && ev.dl_until > t ? ev.dl_until : t + DL_DAYS * 86400e3 };
  } else fail(400, 'Unknown action');
  sendJson(res, 200, { event: staffEventJson(db.updateEvent(ev.id, f)) });
});
A('POST', '/events/:id/request', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  db.updateEvent(ev.id, { request: null });
  sendJson(res, 200, { event: staffEventJson(db.getEvent(ev.id)) });
});
A('DELETE', '/events/:id', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  if (String(body.confirm || '').trim() !== ev.folder_name) fail(400, 'Type the event name exactly to confirm');
  storage.deleteEvent(ev);
  sendJson(res, 200, { ok: true });
});
A('POST', '/events/:id/rescan', (req, res, { params }) => {
  const ev = eventOr404(params.id);
  requireStorage();
  sendJson(res, 200, { added: storage.scanEventPhotos(ev).length });
});
A('POST', '/events/:id/slots', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const body = await readJson(req);
  const from = Number(body.from), to = Number(body.to);
  if (!(from >= 1 && to >= 1 && to <= 999)) fail(400, 'Slot numbers must be 1 or more');
  if (!db.moveSlot(ev.id, from, to)) fail(404, 'No photographer in that slot');
  try { storage.writeMeta(ev); } catch { /* ignore */ }
  sendJson(res, 200, { photographers: db.listPhotographers(ev.id), devices: db.activeDevices(ev.id) });
});
A('DELETE', '/events/:id/devices/:sid', (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const s = db.getSession(Number(params.sid));
  if (!s || s.event_id !== ev.id) fail(404, 'Device not found');
  db.revokeSessionId(s.id);
  sendJson(res, 200, { devices: db.activeDevices(ev.id) });
});
A('GET', '/events/:id/missing-thumbs', (req, res, { params }) => {
  sendJson(res, 200, { photos: db.missingThumbs(eventOr404(params.id).id).map(photoJson) });
});
A('PUT', '/events/:id/photos/:photo/thumb/:size', async (req, res, { params }) => {
  const ev = eventOr404(params.id);
  const p = photoOfEvent(ev, params.photo);
  const bit = storage.THUMB_SIZES[params.size];
  if (!bit) fail(400, 'Size must be 480 or 1600');
  const buf = await readBody(req, 4 * 1024 * 1024);
  if (!sniff(buf)) fail(415, 'Thumbnail must be WebP or JPEG');
  fs.mkdirSync(storage.thumbDir(ev.id), { recursive: true });
  fs.writeFileSync(storage.thumbFile(ev.id, p.id, params.size), buf);
  db.addPhotoThumb(p.id, bit);
  sendJson(res, 200, { ok: true });
});
A('GET', '/app', (req, res) => sendJson(res, 200, { apk: apkJson(apkInfo()) }));
A('POST', '/app/refresh', async (req, res) => sendJson(res, 200, { apk: apkJson(await refreshApk()) }));
A('GET', '/app.apk', (req, res) => { const m = apkInfo(); if (!m) fail(404, 'The app is not available yet'); sendApk(req, res, m); });
A('GET', '/status', (req, res) => sendJson(res, 200, { storageOnline: storage.storageOnline(), photosDir: config.photosDir, moderator: config.moderatorUrl || null, scan: storage.scanAll() }));

// ---------------- image serving ----------------
function contentTypeOf(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); return sniff(b) === 'jpeg' ? 'image/jpeg' : 'image/webp'; }
  finally { fs.closeSync(fd); }
}
function serveImage(req, res, ev, p, size, download, cacheControl) {
  let file;
  if (size === '480' || size === '1600') {
    const t = storage.thumbFile(ev.id, p.id, size);
    if (fs.existsSync(t)) file = t;
    else if (size === '480' && fs.existsSync(storage.thumbFile(ev.id, p.id, '1600'))) file = storage.thumbFile(ev.id, p.id, '1600');
  } else if (size !== 'orig') fail(400, 'Bad size');
  if (!file) file = storage.photoFile(ev, p);
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'Photo file missing'); }
  const headers = { 'content-type': contentTypeOf(file), 'content-length': st.size, 'cache-control': cacheControl, etag: `"${p.id}-${size}-${Math.floor(st.mtimeMs)}"` };
  if (req.headers['if-none-match'] === headers.etag) { res.writeHead(304, headers); return res.end(); }
  if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(path.posix.basename(p.rel_path))}"`;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
