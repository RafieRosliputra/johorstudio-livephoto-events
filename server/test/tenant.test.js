// White-label tenant tests: host resolution, branding injection, admin host guard, apex redirect,
// on/off switch, organiser CRUD + validation, logo upload/serving, platform brand. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'livephoto-tenant-'));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const aux = http.createServer((req, res) => {
  if (req.url === '/certs') return res.end(JSON.stringify({ keys: [jwk] }));
  res.statusCode = 404; res.end();
});
await new Promise((r) => aux.listen(0, '127.0.0.1', r));
const auxUrl = `http://127.0.0.1:${aux.address().port}`;

Object.assign(process.env, {
  DATA_DIR: path.join(tmp, 'data'), PHOTOS_DIR: path.join(tmp, 'photos'), COOKIE_SECURE: '0', PUBLIC_URL: 'https://live.johorstudio.com',
  SCAN_INTERVAL: '3600', ACCESS_AUD: 'aud-livephoto', ACCESS_TEAM_DOMAIN: 'johorstudio.cloudflareaccess.com',
  ACCESS_CERTS_URL: `${auxUrl}/certs`, ADMIN_EMAILS: 'rafierosliputra@gmail.com',
  MODERATOR_URL: '', TENANT_ZONE: 'ccam.my', ADMIN_HOST: 'live.johorstudio.com', APEX_MODE: 'redirect',
});

const { handler } = await import('../src/server.js');
const db = await import('../src/db.js');
const storage = await import('../src/storage.js');
const tenant = await import('../src/tenant.js');

function jwt(email, { aud = 'aud-livephoto', exp = Math.floor(Date.now() / 1000) + 3600 } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({ email, aud: [aud], iss: 'https://johorstudio.cloudflareaccess.com', exp });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const AUTH = { 'cf-access-jwt-assertion': jwt('rafierosliputra@gmail.com') };

let server, port;
before(async () => {
  db.openDb();
  storage.ensureStorage();
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.closeAllConnections(); server.close(); aux.close(); db.closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** Request with an explicit Host header (fetch/undici will not let us set Host). */
function call(method, pathname, { host = 'live.johorstudio.com', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const admin = (method, pathname, opts = {}) => call(method, pathname, { ...opts, headers: { ...AUTH, ...(opts.headers || {}) } });
const asJson = (method, pathname, body, host = 'live.johorstudio.com') =>
  admin(method, pathname, { host, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function createOrg(over = {}) {
  const r = await asJson('POST', '/api/admin/organizers', { name: 'Passion Sound & Event', slug: 'passion', ...over });
  assert.equal(r.status, 201, r.text);
  return r.json.organizer;
}
async function goLive(id) {
  const r = await asJson('POST', `/api/admin/organizers/${id}/status`, { status: 'live' });
  assert.equal(r.status, 200, r.text);
  return r.json.organizer;
}

// ---------------- host resolution (pure) ----------------
test('resolveHost maps platform / apex / tenant / other hosts', () => {
  assert.equal(tenant.resolveHost('live.johorstudio.com').kind, 'platform');
  assert.equal(tenant.resolveHost('live.johorstudio.com').admin, true);
  assert.equal(tenant.resolveHost('johorstudio.com').kind, 'platform');
  assert.equal(tenant.resolveHost('ccam.my').kind, 'apex');
  assert.equal(tenant.resolveHost('www.ccam.my').kind, 'apex');
  assert.equal(tenant.resolveHost('passion.ccam.my').kind, 'unknown');   // not created yet
  assert.equal(tenant.resolveHost('localhost').kind, 'platform');        // local dev stays usable
  assert.equal(tenant.resolveHost('127.0.0.1').kind, 'platform');
});

test('colour helpers derive a usable dark/light/soft palette', () => {
  const b = tenant.deriveBrand({ colorPrimary: '#c8102e' });
  assert.match(b.colorPrimaryDark, /^#[0-9a-f]{6}$/i);
  assert.match(b.colorPrimaryLight, /^#[0-9a-f]{6}$/i);
  assert.match(b.colorPrimarySoft, /^#[0-9a-f]{6}$/i);
  assert.notEqual(b.colorPrimaryDark, b.colorPrimary);
  assert.equal(b.font, 'Archivo');
});

// ---------------- platform host unchanged ----------------
test('platform host keeps the original page and title', async () => {
  const r = await call('GET', '/', { host: 'live.johorstudio.com' });
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>JohorStudio\.com Live/);
  assert.ok(!r.text.includes('window.__BRAND'), 'no brand injection without a saved brand');
});

// ---------------- organiser CRUD ----------------
test('organizer CRUD + validation', async () => {
  const org = await createOrg();
  assert.equal(org.status, 'draft');
  assert.equal(org.url, 'https://passion.ccam.my');

  // duplicate slug
  let r = await asJson('POST', '/api/admin/organizers', { name: 'Other', slug: 'passion' });
  assert.equal(r.status, 409);
  // reserved slug
  r = await asJson('POST', '/api/admin/organizers', { name: 'Other', slug: 'admin' });
  assert.equal(r.status, 409);
  // bad slug
  r = await asJson('POST', '/api/admin/organizers', { name: 'Other', slug: 'Bad Slug!' });
  assert.equal(r.status, 400);
  // no name
  r = await asJson('POST', '/api/admin/organizers', { slug: 'x-corp' });
  assert.equal(r.status, 400);
  // domain inside the tenant zone is refused (slug is the way)
  r = await asJson('PUT', `/api/admin/organizers/${org.id}`, { domain: 'foo.ccam.my' });
  assert.equal(r.status, 400);

  const list = await admin('GET', '/api/admin/organizers');
  assert.equal(list.json.organizers.length, 1);
  assert.equal(list.json.zone, 'ccam.my');
});

test('draft subdomain is not served yet (503 status page)', async () => {
  const r = await call('GET', '/', { host: 'passion.ccam.my' });
  assert.equal(r.status, 503);
  assert.match(r.text, /not available/i);
  // API on a draft/off host is 503 too
  const api = await call('GET', '/api/brand', { host: 'passion.ccam.my' });
  assert.equal(api.status, 503);
});

test('live tenant gets branded HTML: title, css vars, window.__BRAND, data-tenant', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers[0];
  await asJson('PUT', `/api/admin/organizers/${org.id}`, {
    brand: { name: 'Passion Sound & Event', colorPrimary: '#c8102e', colorAccent: '#ffb100', website: 'https://passion-sound-event.com', logo: '/brand/passion/logo.png',
      whatsapp: '60127212813', contactUrl: 'https://passion-sound-event.com/contact-us/' },
  });
  await goLive(org.id);
  const r = await call('GET', '/', { host: 'passion.ccam.my' });
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Passion Sound &amp; Event Live|<title>Passion Sound & Event Live/);
  assert.match(r.text, /--teal:#c8102e/);
  assert.match(r.text, /--tally:#ffb100/);
  assert.match(r.text, /window\.__BRAND=/);
  assert.match(r.text, /data-tenant="passion"/);
  assert.match(r.text, /"disclaimer":"Servis disediakan oleh JohorStudio\.com"/);
  // brand.js is loaded last and must exist
  assert.match(r.text, /src="\/js\/brand\.js"/);
  const js = await call('GET', '/js/brand.js', { host: 'passion.ccam.my' });
  assert.equal(js.status, 200);
});

test('HTML is rendered per host and revalidated (Vary: Host, no shared cache)', async () => {
  const a = await call('GET', '/', { host: 'live.johorstudio.com' });
  const b = await call('GET', '/', { host: 'passion.ccam.my' });
  assert.equal(a.headers.vary, 'Host');
  assert.equal(b.headers.vary, 'Host');
  assert.equal(a.headers['cache-control'], 'no-cache');
  assert.equal(b.headers['cache-control'], 'no-cache');
  assert.ok(!a.text.includes('data-tenant'), 'platform page has no tenant marker');
});

test('/api/brand returns the host brand', async () => {
  const r = await call('GET', '/api/brand', { host: 'passion.ccam.my' });
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Passion Sound & Event');
  assert.equal(r.json.kind, 'tenant');
  assert.equal(r.json.zone, 'ccam.my');
  assert.equal(r.json.colors.primary, '#c8102e');
  const p = await call('GET', '/api/brand', { host: 'live.johorstudio.com' });
  assert.equal(p.json.name, 'JohorStudio.com');
});

test('admin paths are blocked on tenant hosts', async () => {
  const page = await call('GET', '/admin', { host: 'passion.ccam.my' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, 'https://live.johorstudio.com/admin');
  const org = await call('GET', '/organizers', { host: 'passion.ccam.my' });
  assert.equal(org.status, 302);
  assert.equal(org.headers.location, 'https://live.johorstudio.com/admin/organizers');
  // the EVENT ORGANIZER page lives under /admin so Cloudflare Access covers it
  const orgPage = await call('GET', '/admin/organizers', { host: 'passion.ccam.my' });
  assert.equal(orgPage.status, 302);
  assert.equal(orgPage.headers.location, 'https://live.johorstudio.com/admin/organizers');
  // raw admin file names are never served (Cloudflare Access only covers /admin)
  const raw = await call('GET', '/admin.html', { host: 'live.johorstudio.com' });
  assert.equal(raw.status, 302);
  assert.equal(raw.headers.location, '/admin');
  // even with a valid Access JWT, the API is refused on a tenant host
  const api = await admin('GET', '/api/admin/organizers', { host: 'passion.ccam.my' });
  assert.equal(api.status, 403);
});

test('ccam.my apex redirects to live.johorstudio.com, preserving the path', async () => {
  const r = await call('GET', '/e/abcdef1234', { host: 'ccam.my' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://live.johorstudio.com/e/abcdef1234');
  // API calls are not redirected
  const api = await call('GET', '/api/brand', { host: 'ccam.my' });
  assert.equal(api.status, 200);
  assert.equal(api.json.kind, 'apex');
});

test('unknown subdomain shows a 404 page, static assets still load', async () => {
  const r = await call('GET', '/', { host: 'nobody.ccam.my' });
  assert.equal(r.status, 404);
  assert.match(r.text, /does not exist/i);
  const css = await call('GET', '/css/site.css', { host: 'nobody.ccam.my' });
  assert.equal(css.status, 200);
});

test('switch a tenant off: pages 503, admin still sees it', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers[0];
  const off = await asJson('POST', `/api/admin/organizers/${org.id}/status`, { status: 'off' });
  assert.equal(off.status, 200);
  assert.equal(off.json.organizer.status, 'off');
  const page = await call('GET', '/', { host: 'passion.ccam.my' });
  assert.equal(page.status, 503);
  const list = await admin('GET', '/api/admin/organizers');
  assert.equal(list.json.organizers[0].status, 'off');
  await goLive(org.id);
});

// ---------------- logo upload / serving ----------------
test('logo upload is stored, served on /brand/<slug>/<file>, and removable', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers[0];
  let r = await admin('POST', `/api/admin/organizers/${org.id}/logo`, { body: PNG, headers: { 'x-kind': 'logo', 'content-type': 'application/octet-stream' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.organizer.brand.logo, /^\/brand\/passion\/logo\.png$/);

  const img = await call('GET', '/brand/passion/logo.png', { host: 'passion.ccam.my' });
  assert.equal(img.status, 200);
  assert.match(String(img.headers['content-type']), /image\/png/);

  // path traversal is refused (the app answers with its 404 page, never the database file)
  const bad = await call('GET', '/brand/passion/../../livephoto.db', { host: 'passion.ccam.my' });
  assert.ok(!String(bad.headers['content-type']).includes('octet-stream'));
  assert.ok(!bad.text.startsWith('SQLite format'));
  assert.match(bad.text, /Not found/i);
  const badName = await call('GET', '/brand/passion/evil.html', { host: 'passion.ccam.my' });
  assert.equal(badName.status, 404);
  assert.match(badName.text, /Page not found/i);

  // bad upload
  r = await admin('POST', `/api/admin/organizers/${org.id}/logo`, { body: Buffer.from('not an image'), headers: { 'x-kind': 'logo' } });
  assert.equal(r.status, 415);

  r = await admin('DELETE', `/api/admin/organizers/${org.id}/logo/logo`);
  assert.equal(r.status, 200);
  assert.equal(r.json.organizer.brand.logo, '');
});

test('custom domain joins the tenant to the same brand', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers[0];
  const r = await asJson('PUT', `/api/admin/organizers/${org.id}`, { domain: 'live.passion-sound-event.com' });
  assert.equal(r.status, 200, r.text);
  const page = await call('GET', '/', { host: 'live.passion-sound-event.com' });
  assert.equal(page.status, 200);
  assert.match(page.text, /data-tenant="passion"/);
  const brand = await call('GET', '/api/brand', { host: 'live.passion-sound-event.com' });
  assert.equal(brand.json.name, 'Passion Sound & Event');
  // second organiser cannot take the same domain
  const other = await asJson('POST', '/api/admin/organizers', { name: 'Other Co', slug: 'other-co' });
  const clash = await asJson('PUT', `/api/admin/organizers/${other.json.organizer.id}`, { domain: 'live.passion-sound-event.com' });
  assert.equal(clash.status, 409);
});

// ---------------- platform brand ----------------
test('platform brand is editable and applies to live.johorstudio.com', async () => {
  const r = await asJson('PUT', '/api/admin/brand/platform', { brand: { name: 'JohorStudio Live', colorPrimary: '#0b5cff' } });
  assert.equal(r.status, 200, r.text);
  const page = await call('GET', '/', { host: 'live.johorstudio.com' });
  assert.match(page.text, /<title>JohorStudio Live Live/);
  assert.match(page.text, /--teal:#0b5cff/);
  const got = await admin('GET', '/api/admin/brand/platform');
  assert.equal(got.json.brand.name, 'JohorStudio Live');
  // leave the platform brand at its default for other tests
  await asJson('PUT', '/api/admin/brand/platform', { brand: { name: '', colorPrimary: '' } });
});

// ---------------- brand import ----------------
test('brand import refuses non-https and private hosts', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers[0];
  let r = await asJson('POST', `/api/admin/organizers/${org.id}/import`, { url: 'http://passion-sound-event.com' });
  assert.equal(r.status, 400);
  r = await asJson('POST', `/api/admin/organizers/${org.id}/import`, { url: 'https://127.0.0.1/' });
  assert.equal(r.status, 400);
  r = await asJson('POST', `/api/admin/organizers/${org.id}/import`, {});
  assert.equal(r.status, 400);
});

test('colour extraction picks saturated brand colours out of a stylesheet', async () => {
  const bi = await import('../src/brandimport.js');
  const rows = bi.coloursIn(':root{--a:#c8102e;--b:#c8102e} .x{color:#333;background:#f5f7f7} .y{border-color:rgb(200,16,46)}');
  const s = bi.suggestColours(rows);
  assert.equal(s.primary, '#c8102e');
  assert.ok(rows.some((r) => r.hex === '#f5f7f7'));
});

test('tenant contact details replace the platform WhatsApp/contact', async () => {
  const cfg = await call('GET', '/auth/config', { host: 'passion.ccam.my' });
  assert.equal(cfg.json.whatsapp, '60127212813');
  assert.equal(cfg.json.contactUrl, 'https://passion-sound-event.com/contact-us/');
  const platformCfg = await call('GET', '/auth/config', { host: 'live.johorstudio.com' });
  assert.notEqual(platformCfg.json.whatsapp, '60127212813');
});

test('tenant hero images replace the platform mosaic photos', async () => {
  const platform = await call('GET', '/data/hero.json', { host: 'live.johorstudio.com' });
  assert.equal(platform.status, 200);
  assert.ok(platform.json.photos.length > 0);
  assert.ok(String(platform.json.photos[0].sm).includes('johorstudio.com'), 'platform mosaic uses JohorStudio photos');

  const org = (await admin('GET', '/api/admin/organizers')).json.organizers.find((o) => o.slug === 'passion');
  const hero = ['https://passion-sound-event.com/wp-content/uploads/2021/04/ho12.jpg',
    'https://passion-sound-event.com/wp-content/uploads/2021/06/GROUP-PHOTO-PASSION-02-scaled.jpg'];
  const r = await asJson('PUT', `/api/admin/organizers/${org.id}`, { brand: { heroImages: hero.join('\n'), website: 'https://passion-sound-event.com/' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.organizer.brand.heroImages.split(','), hero);

  const tenant = await call('GET', '/data/hero.json', { host: 'passion.ccam.my' });
  assert.equal(tenant.status, 200);
  assert.equal(tenant.json.photos.length, 2);
  assert.equal(tenant.json.photos[0].sm, hero[0]);
  assert.equal(tenant.json.photos[0].title, 'Passion Sound & Event');
  // the platform page is untouched
  const platformAgain = await call('GET', '/data/hero.json', { host: 'live.johorstudio.com' });
  assert.ok(String(platformAgain.json.photos[0].sm).includes('johorstudio.com'));
});

test('heroImages only accepts up to 5 https/local image URLs', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers.find((o) => o.slug === 'passion');
  const r = await asJson('PUT', `/api/admin/organizers/${org.id}`, {
    brand: { heroImages: ['https://a.test/1.jpg', 'javascript:alert(1)', 'https://a.test/2.jpg', 'https://a.test/3.jpg',
      'https://a.test/4.jpg', 'https://a.test/5.jpg', 'https://a.test/6.jpg'].join(',') },
  });
  assert.equal(r.status, 200, r.text);
  const list = r.json.organizer.brand.heroImages.split(',');
  assert.equal(list.length, 5);
  assert.ok(!list.some((u) => u.startsWith('javascript:')));
  assert.equal(list[0], 'https://a.test/1.jpg');
});

// ---------------- event ownership scoping ----------------
test('an event only shows on its owner tenant host', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers.find((o) => o.slug === 'passion');
  // platform event (JohorStudio itself)
  const platform = await asJson('POST', '/api/admin/events', { date: '20261110', title: 'Platform Event', organiser: 'JohorStudio' });
  assert.equal(platform.status, 201, platform.text);
  // tenant event
  const owned = await asJson('POST', '/api/admin/events', { date: '20261110', title: 'Passion Gala', organiser: 'Passion', organizerId: org.id });
  assert.equal(owned.status, 201, owned.text);
  assert.equal(owned.json.event.organizerId, org.id);
  // unknown organiser is refused
  const bad = await asJson('POST', '/api/admin/events', { date: '20261110', title: 'Nope', organizerId: 'does-not-exist' });
  assert.equal(bad.status, 400);

  const pTok = platform.json.event.token, oTok = owned.json.event.token;
  // both events live (so the 6-digit code login is allowed on the right host)
  db.updateEvent(platform.json.event.id, { starts_at: Date.now(), ends_at: Date.now() + 3600e3 });
  db.updateEvent(owned.json.event.id, { starts_at: Date.now(), ends_at: Date.now() + 3600e3 });
  // guest gallery: platform sees both, the tenant only its own
  assert.equal((await call('GET', `/api/e/${pTok}`, { host: 'live.johorstudio.com' })).status, 200);
  assert.equal((await call('GET', `/api/e/${pTok}`, { host: 'passion.ccam.my' })).status, 404);
  assert.equal((await call('GET', `/api/e/${oTok}`, { host: 'passion.ccam.my' })).status, 200);
  assert.equal((await call('GET', `/api/e/${oTok}`, { host: 'live.johorstudio.com' })).status, 200);
  // the QR code of another tenant's event cannot be used on this host
  const code = platform.json.event.codes.public;
  const wrongHost = await call('POST', '/auth/code', { host: 'passion.ccam.my', body: JSON.stringify({ code, want: 'guest' }), headers: { 'content-type': 'application/json' } });
  assert.equal(wrongHost.status, 401);
  const rightHost = await call('POST', '/auth/code', { host: 'live.johorstudio.com', body: JSON.stringify({ code, want: 'guest' }), headers: { 'content-type': 'application/json' } });
  assert.equal(rightHost.status, 200);
  // live status on the tenant host does not mention platform events
  const liveTenant = await call('GET', '/api/live-status', { host: 'passion.ccam.my' });
  const livePlatform = await call('GET', '/api/live-status', { host: 'live.johorstudio.com' });
  assert.deepEqual(liveTenant.json.live.map((e) => e.name), ['Passion Gala']);
  assert.ok(livePlatform.json.live.length >= 2);
  // an organiser can move an event between hosts
  const moved = await asJson('PATCH', `/api/admin/events/${platform.json.event.id}`, { organizerId: org.id });
  assert.equal(moved.json.event.organizerId, org.id);
  assert.equal((await call('GET', `/api/e/${pTok}`, { host: 'passion.ccam.my' })).status, 200);
});

// ---------------- delete ----------------
test('delete organiser removes the subdomain', async () => {
  const org = (await admin('GET', '/api/admin/organizers')).json.organizers.find((o) => o.slug === 'passion');
  const r = await admin('DELETE', `/api/admin/organizers/${org.id}`);
  assert.equal(r.status, 200);
  assert.ok(!(await admin('GET', '/api/admin/organizers')).json.organizers.some((o) => o.slug === 'passion'));
  const page = await call('GET', '/', { host: 'passion.ccam.my' });
  assert.equal(page.status, 404);
});
