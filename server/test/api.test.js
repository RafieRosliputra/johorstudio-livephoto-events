// End-to-end API test (v4): Access admin, event codes, live window, guest + photographer uploads,
// AI moderation (mock moderator), organiser panel, live status, scanner. Run: cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-'));

// --- fake Cloudflare Access (certs) + fake AI moderator ---
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
let modCalls = 0, modVerdict = () => ({ verdict: 'ok', labels: [] });
const aux = http.createServer(async (req, res) => {
  if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === '/releases') return res.end(JSON.stringify([{ tag_name: 'jstether-v4.0', name: 'JS Tether 4.0', assets: [{ id: 7, name: 'JSTether-v4.0.apk', updated_at: 'x', browser_download_url: `${auxUrl}/apk` }] }]));
  if (req.url === '/apk') return res.end(Buffer.concat([Buffer.from('PK'), Buffer.alloc(3000)]));
  if (req.url === '/check') {
    let b = ''; for await (const c of req) b += c;
    modCalls++;
    return res.end(JSON.stringify(modVerdict(JSON.parse(b))));
  }
  if (req.url === '/faces') { for await (const _ of req); return res.end(JSON.stringify({ faces: [[0.4, 0.2, 0.5, 0.35]] })); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => aux.listen(0, '127.0.0.1', r));
const auxUrl = `http://127.0.0.1:${aux.address().port}`;

Object.assign(process.env, {
  DATA_DIR: path.join(tmp, 'data'), PHOTOS_DIR: path.join(tmp, 'photos'), COOKIE_SECURE: '0', PUBLIC_URL: 'http://localhost',
  SCAN_INTERVAL: '3600', ACCESS_AUD: 'aud-livephoto', ACCESS_TEAM_DOMAIN: 'johorstudio.cloudflareaccess.com',
  ACCESS_CERTS_URL: `${auxUrl}/certs`, ADMIN_EMAILS: 'rafierosliputra@gmail.com,johorstudio@gmail.com',
  MODERATOR_URL: auxUrl, GUEST_UPLOADS_PER_EVENT: '3', APK_RELEASES_URL: `${auxUrl}/releases`,
});
const { handler } = await import('../src/server.js');
const db = await import('../src/db.js');
const storage = await import('../src/storage.js');

function jwt(email, { aud = 'aud-livephoto', exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({ email, aud: [aud], iss: 'https://johorstudio.cloudflareaccess.com', exp });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const ADMIN = { 'cf-access-jwt-assertion': jwt('rafierosliputra@gmail.com') };

let base, server;
before(async () => {
  db.openDb();
  storage.ensureStorage();
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); aux.close(); db.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Cookie jar per "device"
function device(ip) {
  const jar = {};
  return async function call(method, url, { body, raw, headers = {} } = {}) {
    const h = { 'x-forwarded-for': ip, ...headers };
    const ck = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (ck) h.cookie = ck;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + url, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };
}
const admin = device('10.0.0.1');
const A = (m, u, o = {}) => admin(m, u, { ...o, headers: { ...ADMIN, ...(o.headers || {}) } });

function fakeWebp(w, h, pad = 0) {
  const vp8x = Buffer.alloc(18); vp8x.write('VP8X', 0); vp8x.writeUInt32LE(10, 4); vp8x[8] = 0x08;
  vp8x.writeUIntLE(w - 1, 12, 3); vp8x.writeUIntLE(h - 1, 15, 3);
  const exif = Buffer.alloc(14); exif.write('EXIF', 0); exif.writeUInt32LE(6, 4); exif.write('GPS!!!', 8);
  const data = Buffer.alloc(8 + pad); data.write('VP8L', 0); data.writeUInt32LE(pad, 4);
  const body = Buffer.concat([Buffer.from('WEBP'), vp8x, exif, data]);
  const head = Buffer.alloc(8); head.write('RIFF', 0); head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}
async function upload(call, startUrl, file, startBody = {}) {
  const s = await call('POST', startUrl, { body: { name: 'IMG_1.webp', size: file.length, ...startBody } });
  if (s.status !== 201) return s;
  await call('PUT', `/api/uploads/${s.body.id}?offset=0`, { raw: file });
  return call('POST', `/api/uploads/${s.body.id}/complete`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ev, codes;
const guest = device('10.0.0.2'), photog = device('10.0.0.3'), client = device('10.0.0.4'), stranger = device('10.0.0.5');

test('admin API needs a valid Cloudflare Access login', async () => {
  assert.equal((await admin('GET', '/api/admin/me')).status, 401);
  assert.equal((await admin('GET', '/api/admin/me', { headers: { 'cf-access-jwt-assertion': jwt('someone@gmail.com') } })).status, 403);
  assert.equal((await admin('GET', '/api/admin/me', { headers: { 'cf-access-jwt-assertion': jwt('rafierosliputra@gmail.com', { aud: 'other' }) } })).status, 401);
  assert.equal((await admin('GET', '/api/admin/me', { headers: { 'cf-access-jwt-assertion': jwt('rafierosliputra@gmail.com', { exp: 1 }) } })).status, 401);
  const forged = jwt('johorstudio@gmail.com').replace(/\.[^.]+$/, '.AAAA');
  assert.equal((await admin('GET', '/api/admin/me', { headers: { 'cf-access-jwt-assertion': forged } })).status, 401);
  const ok = await A('GET', '/api/admin/me');
  assert.equal(ok.status, 200); assert.equal(ok.body.email, 'rafierosliputra@gmail.com');
});

test('admin creates an event with three different codes; not live yet', async () => {
  const r = await A('POST', '/api/admin/events', { body: { date: '20261101', title: 'Annual Dinner ABC', organiser: 'ABC Sdn Bhd' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ev = r.body.event; codes = ev.codes;
  assert.equal(ev.status, 'draft');
  assert.equal(new Set(Object.values(codes)).size, 3);
  assert.ok(Object.values(codes).every((c) => /^\d{6}$/.test(c)));
  const g = await guest('POST', '/auth/code', { body: { code: codes.public } });
  assert.equal(g.status, 403); // not live
  assert.equal((await stranger('GET', '/api/live-status')).body.count, 0);
});

test('activate: new codes, live status, wrong-code limit with tries left', async () => {
  const r = await A('POST', `/api/admin/events/${ev.id}/activate`, { body: {} });
  assert.equal(r.body.event.status, 'live');
  assert.notEqual(r.body.event.codes.public, codes.public);
  codes = r.body.event.codes;
  assert.ok(r.body.event.endsAt - r.body.event.startsAt === 8 * 3600e3);
  const ls = await stranger('GET', '/api/live-status', { headers: { origin: 'https://johorstudio.com' } });
  assert.equal(ls.body.count, 1); assert.equal(ls.body.live[0].name, 'Annual Dinner ABC');
  assert.equal(ls.headers.get('access-control-allow-origin'), 'https://johorstudio.com');
  await A('PATCH', `/api/admin/events/${ev.id}`, { body: { hideName: true } });
  assert.equal((await stranger('GET', '/api/live-status')).body.live[0].name, 'Event in progress');
  const bad = String((Number(codes.public) + 1) % 1e6).padStart(6, '0');
  const w1 = await stranger('POST', '/auth/code', { body: { code: bad === codes.photographer || bad === codes.client ? '000001' : bad } });
  assert.equal(w1.status, 401); assert.equal(w1.body.triesLeft, 2); assert.match(w1.body.error, /2 tries left/);
  await stranger('POST', '/auth/code', { body: { code: '999999' } });
  const w3 = await stranger('POST', '/auth/code', { body: { code: '999998' } });
  assert.equal(w3.status, 429);
  assert.equal((await stranger('POST', '/auth/code', { body: { code: codes.public } })).status, 429); // locked even with the right code
});

test('guest: code -> gallery, must accept notice, upload goes to AI, limit 3', async () => {
  const pc = await guest('POST', '/auth/code', { body: { code: codes.photographer, want: 'guest' } });
  assert.equal(pc.status, 400); assert.match(pc.body.error, /photographer code/);
  const r = await guest('POST', '/auth/code', { body: { code: codes.public, want: 'guest' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.next, `/e/${ev.token}`);
  const g = await guest('GET', `/api/e/${ev.token}`);
  assert.equal(g.body.guest.canUpload, true); assert.equal(g.body.guest.agreed, false);
  assert.equal((await upload(guest, `/api/e/${ev.token}/uploads`, fakeWebp(3000, 4000))).status, 428);
  await guest('POST', `/api/e/${ev.token}/agree`);
  modVerdict = () => ({ verdict: 'ok', labels: [] });
  const up = await upload(guest, `/api/e/${ev.token}/uploads`, fakeWebp(3000, 4000), { uploader: 'Siti' });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.photo.status, 'pending');
  await wait(200);
  const after1 = await guest('GET', `/api/e/${ev.token}`);
  assert.equal(after1.body.photos.length, 1); assert.equal(after1.body.photos[0].by, 'Siti');
  // flagged by the AI: not public, waits for review
  modVerdict = () => ({ verdict: 'flag', labels: ['document'] });
  await upload(guest, `/api/e/${ev.token}/uploads`, fakeWebp(1000, 1400));
  await wait(200);
  // blocked (NSFW)
  modVerdict = () => ({ verdict: 'block', labels: ['nsfw'] });
  await upload(guest, `/api/e/${ev.token}/uploads`, fakeWebp(1000, 1400));
  await wait(200);
  assert.equal((await guest('GET', `/api/e/${ev.token}`)).body.photos.length, 1);
  const lim = await upload(guest, `/api/e/${ev.token}/uploads`, fakeWebp(1000, 1000));
  assert.equal(lim.status, 429); assert.match(lim.body.error, /limit of 3/);
  assert.equal(modCalls, 3);
});

test('photographer: code + name -> Photographer N, upload is approved without AI', async () => {
  assert.equal((await photog('POST', '/auth/code', { body: { code: codes.photographer } })).status, 400); // name needed
  const r = await photog('POST', '/auth/code', { body: { code: codes.photographer, name: 'Aiman', app: true } });
  assert.equal(r.status, 200); assert.equal(r.body.slot, 1); assert.ok(r.body.token);
  const second = device('10.0.0.9');
  assert.equal((await second('POST', '/auth/code', { body: { code: codes.photographer, name: 'Rafi' } })).body.slot, 2);
  assert.equal((await second('POST', '/auth/code', { body: { code: codes.photographer, name: 'aiman' } })).body.slot, 1); // same name, same slot
  // the app uses the bearer token
  const bearer = device('10.0.0.10');
  const me = await bearer('GET', '/api/shoot', { headers: { authorization: `Bearer ${r.body.token}` } });
  assert.equal(me.body.slot, 1); assert.equal(me.body.folder, 'Photographer 1');
  const before = modCalls;
  const up = await upload(photog, '/api/shoot/uploads', fakeWebp(6000, 4000, 5000), { name: 'DSC01234.webp' });
  assert.equal(up.status, 200); assert.equal(up.body.photo.status, 'approved'); assert.equal(up.body.photo.by, 'Aiman');
  assert.equal(modCalls, before);
  assert.ok(fs.existsSync(path.join(process.env.PHOTOS_DIR, 'EVENTS', ev.folder, 'Photographer 1', 'DSC01234.webp')));
  // faces found by the moderator come with the photo (big screen zooms towards them)
  await wait(150);
  const withFaces = (await A('GET', `/api/admin/events/${ev.id}/photos`)).body.photos.find((p) => p.id === up.body.photo.id);
  assert.deepEqual(withFaces.fc, [[0.4, 0.2, 0.5, 0.35]]);
  // same original file again (name|size|time taken): not stored twice; resumed when cut off halfway
  const key = 'DSC01235.JPG|8123456|1761955200000';
  const first = await upload(photog, '/api/shoot/uploads', fakeWebp(6000, 4000, 5000), { name: 'DSC01235.webp', key });
  assert.equal(first.status, 200);
  const again = await photog('POST', '/api/shoot/uploads', { body: { name: 'DSC01235.webp', size: 5100, key } });
  assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.photo.id, first.body.photo.id);
  const chk = await photog('POST', '/api/shoot/check', { body: { keys: [key, 'OTHER.JPG|1|2'] } });
  assert.deepEqual(chk.body.sent, [key]);
  const half = fakeWebp(6000, 4000, 9000), key2 = 'DSC01236.JPG|9000000|1761955300000';
  const st = await photog('POST', '/api/shoot/uploads', { body: { name: 'DSC01236.webp', size: half.length, key: key2 } });
  await photog('PUT', `/api/uploads/${st.body.id}?offset=0`, { raw: half.subarray(0, 4000) });
  const re = await photog('POST', '/api/shoot/uploads', { body: { name: 'DSC01236.webp', size: half.length, key: key2 } });
  assert.equal(re.body.id, st.body.id); assert.equal(re.body.received, 4000); assert.equal(re.body.resumed, true);
  await photog('PUT', `/api/uploads/${st.body.id}?offset=4000`, { raw: half.subarray(4000) });
  assert.equal((await photog('POST', `/api/uploads/${st.body.id}/complete`)).status, 200);
  // admin moves Aiman to slot 3; his session follows
  await A('POST', `/api/admin/events/${ev.id}/slots`, { body: { from: 1, to: 3 } });
  assert.equal((await photog('GET', '/api/shoot')).body.slot, 3);
});

test('APK download only after login (photographer / admin)', async () => {
  assert.equal((await stranger('GET', '/api/shoot/app.apk')).status, 401);
  assert.equal((await admin('GET', '/api/admin/app.apk')).status, 401);
  const r = await A('POST', '/api/admin/app/refresh');
  assert.equal(r.body.apk.version, '4.0');
  const a = await A('GET', '/api/admin/app.apk');
  assert.equal(a.status, 200); assert.equal(a.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal((await photog('GET', '/api/shoot/app')).body.apk.name, 'JSTether-v4.0.apk');
  const p = await photog('GET', '/api/shoot/app.apk');
  assert.equal(p.status, 200); assert.equal(p.body.length, 3002);
});

test('organiser panel: review queue, allow / remove, request to close', async () => {
  assert.equal((await client('GET', `/api/client/events/${ev.id}`)).status, 401);
  const r = await client('POST', '/auth/code', { body: { code: codes.client } });
  assert.equal(r.status, 200); assert.equal(r.body.next, '/panel');
  const review = await client('GET', `/api/client/events/${ev.id}/photos?filter=review`);
  assert.equal(review.body.photos.length, 1); assert.deepEqual(review.body.photos[0].flags, ['document']);
  const blocked = await client('GET', `/api/client/events/${ev.id}/photos?filter=blocked`);
  assert.equal(blocked.body.photos.length, 1);
  await client('PATCH', `/api/client/events/${ev.id}/photos/${review.body.photos[0].id}`, { body: { status: 'approved' } });
  assert.equal((await guest('GET', `/api/e/${ev.token}`)).body.photos.length, 5);
  assert.equal((await client('DELETE', `/api/client/events/${ev.id}/photos/${blocked.body.photos[0].id}`)).status, 200);
  // organiser cannot use admin routes or change settings
  assert.equal((await client('POST', `/api/admin/events/${ev.id}/close`)).status, 401);
  const rq = await client('POST', `/api/client/events/${ev.id}/request`, { body: { type: 'close' } });
  assert.equal(rq.body.event.request.type, 'close');
  assert.equal((await A('GET', `/api/admin/events/${ev.id}`)).body.event.request.type, 'close');
});

test('admin / organiser upload with a nickname, no AI check; big screen on / off', async () => {
  const before = modCalls;
  assert.equal((await client('POST', `/api/client/events/${ev.id}/uploads`, { body: { name: 'x.webp', size: 10 } })).status, 400); // nickname needed
  const up = await upload(client, `/api/client/events/${ev.id}/uploads`, fakeWebp(4000, 3000, 2000), { name: 'cam.webp', uploader: 'Kak Long' });
  assert.equal(up.status, 200); assert.equal(up.body.photo.status, 'approved'); assert.equal(up.body.photo.by, 'Kak Long');
  assert.equal(modCalls, before);
  assert.ok(fs.existsSync(path.join(process.env.PHOTOS_DIR, 'EVENTS', ev.folder, 'Organiser uploads', 'cam.webp')));
  assert.equal((await A('POST', `/api/admin/events/${ev.id}/screen`, { body: { mode: 'black' } })).body.mode, 'black');
  assert.equal((await client('GET', `/api/client/events/${ev.id}`)).body.event.screenMode, 'black');
  // backgrounds: admin (all events), organiser 1 (upload), organiser 2 (a guest photo)
  assert.equal((await client('POST', `/api/client/events/${ev.id}/screen`, { body: { mode: 'admin' } })).status, 400); // not set yet
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
  assert.equal((await A('PUT', '/api/admin/background', { raw: jpg })).status, 200);
  assert.equal((await client('PUT', '/api/admin/background', { raw: jpg })).status, 401); // organiser cannot change it
  assert.equal((await client('PUT', `/api/client/events/${ev.id}/bg/bg1`, { raw: jpg })).body.bg.bg1, true);
  const guestPhoto = (await A('GET', `/api/admin/events/${ev.id}/photos`)).body.photos.find((p) => p.src === 'public' && p.status === 'approved');
  const photogPhoto = (await A('GET', `/api/admin/events/${ev.id}/photos`)).body.photos.find((p) => p.src === 'photographer');
  assert.equal((await client('POST', `/api/client/events/${ev.id}/bg/bg2`, { body: { photoId: photogPhoto.id } })).status, 400);
  assert.equal((await client('POST', `/api/client/events/${ev.id}/bg/bg2`, { body: { photoId: guestPhoto.id } })).body.bg.bg2, guestPhoto.id);
  for (const m of ['admin', 'bg1', 'bg2']) assert.equal((await client('POST', `/api/client/events/${ev.id}/screen`, { body: { mode: m } })).body.mode, m);
  assert.equal((await client('GET', `/api/client/events/${ev.id}/bg/bg1`)).status, 200);
  assert.equal((await stranger('GET', `/api/client/events/${ev.id}/bg/bg1`)).status, 401);
  await client('POST', `/api/client/events/${ev.id}/screen`, { body: { mode: 'photos' } });
  // "Upload your photos!" message: organiser changes text and timing, hides it, "Show now" turns it back on
  const b1 = await client('POST', `/api/client/events/${ev.id}/bubble`, { body: { text: 'Share your <b>best</b> shot!', every: 60, for: 10, on: false } });
  assert.equal(b1.body.settings.bubbleText, 'Share your bbest/b shot!'); assert.equal(b1.body.settings.bubbleEvery, 60);
  assert.equal(b1.body.settings.bubbleFor, 10); assert.equal(b1.body.settings.bubbleOn, false);
  assert.equal((await A('POST', `/api/admin/events/${ev.id}/bubble`, { body: { now: true } })).body.settings.bubbleOn, true);
  assert.equal((await stranger('POST', `/api/client/events/${ev.id}/bubble`, { body: { now: true } })).status, 401);
  // pin a photo: timed or locked, then released
  const pin = await client('POST', `/api/client/events/${ev.id}/pin`, { body: { photoId: photogPhoto.id, sec: 10 } });
  assert.ok(pin.body.pin.until > Date.now());
  const lock = await A('POST', `/api/admin/events/${ev.id}/pin`, { body: { photoId: photogPhoto.id, sec: 0 } });
  assert.equal(lock.body.pin.until, 0);
  assert.equal((await A('GET', `/api/admin/events/${ev.id}`)).body.event.pin.id, photogPhoto.id);
  await client('POST', `/api/client/events/${ev.id}/pin`, { body: { release: true } });
  assert.equal((await A('GET', `/api/admin/events/${ev.id}`)).body.event.pin, null);
});

test('settings, extend, close: guests and photographers logged out, guest code changes, gallery stays', async () => {
  const s = await A('PATCH', `/api/admin/events/${ev.id}`, { body: { settings: { newSec: 4, loopSec: 6, loopSource: 'public', idleMin: 2, qrSec: 45 } } });
  const st = s.body.event.settings;
  assert.deepEqual([st.newSec, st.loopSec, st.loopSource, st.qrSec], [4, 6, 'public', 45]);
  // QR on the big screen: organiser or admin shows it for qrSec seconds, then hides it
  const qr = await client('POST', `/api/client/events/${ev.id}/qr`, { body: { on: true } });
  assert.equal(qr.status, 200); assert.ok(qr.body.until > Date.now() + 40e3 && qr.body.until <= Date.now() + 45e3);
  assert.equal((await A('GET', `/api/admin/events/${ev.id}`)).body.event.qrUntil, qr.body.until);
  assert.equal((await A('POST', `/api/admin/events/${ev.id}/qr`, { body: { on: false } })).body.until, 0);
  assert.equal((await stranger('POST', `/api/client/events/${ev.id}/qr`, { body: { on: true } })).status, 401);
  const manual = await A('PATCH', `/api/admin/events/${ev.id}`, { body: { codes: { public: codes.client } } });
  assert.equal(manual.status, 409);
  const before = (await A('GET', `/api/admin/events/${ev.id}`)).body.event;
  const ex = await A('POST', `/api/admin/events/${ev.id}/extend`, { body: { hours: 2 } });
  assert.equal(ex.body.event.endsAt, before.endsAt + 2 * 3600e3);
  const c = await A('POST', `/api/admin/events/${ev.id}/close`);
  assert.equal(c.body.event.status, 'closed'); assert.equal(c.body.event.request, null);
  assert.notEqual(c.body.event.codes.public, codes.public);
  assert.equal((await photog('GET', '/api/shoot')).status, 401);
  const g = await guest('GET', `/api/e/${ev.token}`);
  assert.equal(g.status, 200); assert.equal(g.body.guest.canUpload, false); assert.equal(g.body.photos.length, 6);
  assert.equal((await client('GET', `/api/client/events/${ev.id}`)).status, 200); // organiser keeps access 7 days
  assert.equal((await stranger('GET', '/api/live-status')).body.count, 0);
});

test('download-all link: made at close, two ZIPs, 7 days, admin adds 7 more', async () => {
  const e = (await A('GET', `/api/admin/events/${ev.id}`)).body.event;
  assert.ok(e.download.active); assert.match(e.download.url, /\/d\/[A-Za-z0-9_-]{24}$/);
  assert.ok(e.download.until > Date.now() + 6.9 * 86400e3);
  assert.ok((await client('GET', `/api/client/events/${ev.id}`)).body.event.download.url);
  const token = e.download.url.split('/d/')[1];
  const info = (await stranger('GET', `/api/d/${token}`)).body;
  assert.equal(info.event.title, ev.title); assert.ok(info.active);
  assert.ok(info.parts.photographers.count > 0); assert.ok(info.parts.guests.count > 0);
  const zip = await stranger('GET', `/api/d/${token}/zip/photographers`);
  assert.equal(zip.status, 200); assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(Number(zip.headers.get('content-length')), zip.body.length);
  assert.equal(zip.body.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.body.readUInt32LE(zip.body.length - 22), 0x06054b50);
  assert.equal(zip.body.readUInt16LE(zip.body.length - 12), info.parts.photographers.count);
  const g = await stranger('GET', `/api/d/${token}/zip/guests`);
  assert.ok(g.body.includes(Buffer.from('Guests/')));
  assert.equal((await stranger('GET', '/api/d/nope-nope-nope')).status, 404);
  assert.equal((await stranger('GET', `/d/${token}`)).status, 200); // landing page
  // expired: no download; admin adds 7 days (after payment)
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(process.env.DATA_DIR, 'livephoto.db'));
  raw.prepare('UPDATE events SET dl_until=? WHERE id=?').run(Date.now() - 1000, ev.id); raw.close();
  assert.equal((await stranger('GET', `/api/d/${token}/zip/photographers`)).status, 410);
  assert.equal((await stranger('GET', `/api/d/${token}`)).body.active, false);
  assert.equal((await client('GET', `/api/client/events/${ev.id}`)).body.event.download.url, undefined);
  assert.equal((await client('POST', `/api/admin/events/${ev.id}/download`, { body: { action: 'extend' } })).status, 401);
  const ext = await A('POST', `/api/admin/events/${ev.id}/download`, { body: { action: 'extend' } });
  assert.ok(ext.body.event.download.until > Date.now() + 6.9 * 86400e3);
  assert.equal((await stranger('GET', `/api/d/${token}/zip/photographers`)).status, 200);
});

test('scanner adopts SMB folders with their codes', async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(process.env.PHOTOS_DIR, 'EVENTS', ev.folder, '.livephoto.json'), 'utf8'));
  assert.equal(meta.photographers.length, 2);
  fs.mkdirSync(path.join(process.env.PHOTOS_DIR, 'EVENTS', '20261225 Hari Keluarga'));
  storage.scanAll();
  const list = (await A('GET', '/api/admin/events')).body.events;
  assert.equal(list.length, 2);
  assert.ok(list.every((e) => e.codes.public && e.codes.client));
});

test('pages are served', async () => {
  for (const p of ['/', '/c/123456', '/admin', '/panel', '/shoot', `/show/${ev.id}`, `/e/${ev.token}`]) {
    assert.equal((await stranger('GET', p)).status, 200, p);
  }
});
