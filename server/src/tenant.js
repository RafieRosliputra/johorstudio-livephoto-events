// White-label tenants (ccam.my): resolve the request host to a brand.
//
// Hosts:
//   live.johorstudio.com (ADMIN_HOST)  - admin UI + Cloudflare Access, master JohorStudio brand
//   johorstudio.com, www.johorstudio.com - platform hosts, same brand
//   ccam.my, www.ccam.my               - apex; APEX_MODE=redirect (default) or 'app' (brand:apex)
//   <slug>.ccam.my                     - event-organiser tenant, brand from the `organizers` table
//   <any other domain>                 - a registered tenant custom domain (organizers.domain)
//
// The brand is applied by injecting CSS variables + window.__BRAND into <head> (server-side) and by
// public/js/brand.js (text, logo, footer disclaimer) in the browser. Nothing is templated in the HTML
// files: they stay the plain JohorStudio pages.
import { config } from './config.js';
import * as db from './db.js';

export const DEFAULT_BRAND = {
  name: 'JohorStudio.com',
  shortName: '',
  tagline: '',
  logo: '',
  logoDark: '',
  favicon: '',
  colorPrimary: '',
  colorPrimaryDark: '',
  colorPrimaryLight: '',
  colorPrimarySoft: '',
  colorGraphite: '',
  colorInk: '',
  colorPaper: '',
  colorMist: '',
  colorSteel: '',
  colorLine: '',
  colorAccent: '',
  font: '',
  fontUrl: '',
  website: '',
  whatsapp: '',
  contactUrl: '',
  heroHeadline: '',
  heroSub: '',
  disclaimer: '',
  hidePlatformLinks: false,
  custom: false,
  updatedAt: 0,
};

const BRAND_KEYS = Object.keys(DEFAULT_BRAND);

// Brand values are written into HTML/CSS (and one day come from a third-party website), so every
// field is validated here: colours must be #rrggbb, fonts a plain name, URLs https or a local path.
const HEX_RE = /^#[0-9a-f]{6}$/i;
const FONT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const TEXT_RE = /[<>\u0000-\u001f\u007f]/g;
const LOCAL_PATH_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const HTTPS_RE = /^https:\/\/[^\s"'<>]{1,600}$/i;
const GOOGLE_FONTS_RE = /^https:\/\/fonts\.(googleapis|gstatic)\.com\/[^\s"'<>]{1,600}$/i;
const COLOUR_KEYS = new Set(['colorPrimary', 'colorPrimaryDark', 'colorPrimaryLight', 'colorPrimarySoft',
  'colorGraphite', 'colorInk', 'colorPaper', 'colorMist', 'colorSteel', 'colorLine', 'colorAccent']);
const URL_KEYS = new Set(['logo', 'logoDark', 'favicon']);
const TEXT_KEYS = new Set(['name', 'shortName', 'tagline', 'heroHeadline', 'heroSub', 'disclaimer', 'website', 'contactUrl']);

const cleanText = (v) => String(v ?? '').replace(TEXT_RE, '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** Keep only known brand fields, validated. Unknown keys are dropped. */
export function cleanBrand(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of BRAND_KEYS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (k === 'hidePlatformLinks') { out[k] = v === true || v === 'true'; continue; }
    const s = String(v ?? '').trim();
    if (COLOUR_KEYS.has(k)) { out[k] = HEX_RE.test(s) ? s.toLowerCase() : ''; continue; }
    if (k === 'font') { out[k] = FONT_RE.test(s) ? s : ''; continue; }
    if (k === 'fontUrl') { out[k] = GOOGLE_FONTS_RE.test(s) ? s : ''; continue; }
    if (URL_KEYS.has(k)) { out[k] = (LOCAL_PATH_RE.test(s) || HTTPS_RE.test(s)) ? s.slice(0, 700) : ''; continue; }
    if (k === 'whatsapp') { out[k] = s.replace(/\D/g, '').slice(0, 15); continue; }
    if (TEXT_KEYS.has(k)) {
      const t = cleanText(s);
      // Website/contact fields must be https (or empty); plain text fields are just text.
      out[k] = (k === 'website' || k === 'contactUrl') ? (HTTPS_RE.test(t) ? t : '') : t;
      continue;
    }
    out[k] = cleanText(s);
  }
  return out;
}

export function mergeBrand(base, over) {
  const out = { ...DEFAULT_BRAND, ...base };
  for (const [k, v] of Object.entries(over || {})) if (v !== '' && v !== undefined && v !== null) out[k] = v;
  out.custom = !!(base?.custom || over?.custom || out.custom);
  return deriveBrand(out);
}

// ---------- colour helpers ----------
function clamp(n, a = 0, b = 100) { return Math.min(b, Math.max(a, n)); }
export function isHex(v) { return /^#[0-9a-f]{6}$/i.test(String(v || '')); }
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
export function rgbToHex([r, g, b]) {
  const f = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}
export function hslToHex([h, s, l]) {
  h = ((h % 360) + 360) % 360; s = clamp(s) / 100; l = clamp(l) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return rgbToHex(rgb.map((v) => (v + m) * 255));
}
export function darken(hex, by = 14) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToHex([h, s, clamp(l - by, 3, 97)]);
}
export function lighten(hex, by = 14) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToHex([h, s, clamp(l + by, 3, 97)]);
}
export const mix = (hex, other = '#ffffff', t = 0.88) => {
  const a = hexToRgb(hex), b = hexToRgb(other);
  return rgbToHex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t));
};
// Readable text colour on a background (WCAG-ish: use the paper or ink of the brand).
export function onColor(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#1d2528' : '#ffffff';
}

/** Fill derived brand colours/fonts when the admin only picked a primary colour. */
export function deriveBrand(b) {
  const out = { ...DEFAULT_BRAND, ...b };
  if (isHex(out.colorPrimary)) {
    const p = out.colorPrimary;
    if (!isHex(out.colorPrimaryDark)) out.colorPrimaryDark = darken(p, 12);
    if (!isHex(out.colorPrimaryLight)) out.colorPrimaryLight = lighten(p, 22);
    if (!isHex(out.colorPrimarySoft)) out.colorPrimarySoft = mix(p, '#ffffff', 0.86);
  }
  if (!out.font) out.font = 'Archivo';
  return out;
}

// ---------- hosts ----------
export function hostOf(req) {
  const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  let h = raw.split(',')[0].trim();
  if (h.startsWith('[')) { const i = h.indexOf(']'); h = i > 0 ? h.slice(1, i) : h; } // [::1]:8095
  else { h = h.replace(/:\d+$/, ''); }
  return h.replace(/\.$/, '');
}

const subdomainRe = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isAdminHost(host) { return host === config.adminHost; }
export function isPlatformHost(host) {
  return host === config.adminHost || config.platformHosts.includes(host);
}
export function isZoneApex(host) { return host === config.tenantZone || host === `www.${config.tenantZone}`; }

/** Host -> tenant descriptor. Never throws: unknown hosts fall back to the platform brand. */
export function resolveHost(host) {
  const h = String(host || '').toLowerCase();
  const base = { host: h, kind: 'platform', slug: '', organizer: null, brand: platformBrand() };
  if (isPlatformHost(h)) return { ...base, admin: h === config.adminHost };
  if (isZoneApex(h)) return { ...base, kind: 'apex', brand: apexBrand() };
  // <slug>.ccam.my (one label only; nested subdomains are not tenants)
  if (h.endsWith(`.${config.tenantZone}`)) {
    const sub = h.slice(0, -(config.tenantZone.length + 1));
    if (subdomainRe.test(sub)) {
      const org = dbLookup(() => db.organizerBySlug(sub)) || dbLookup(() => db.organizerByDomain(h));
      return tenantFromOrg(org, h, sub);
    }
  }
  const custom = dbLookup(() => db.organizerByDomain(h));
  if (custom) return tenantFromOrg(custom, h, custom.slug);
  // Any other host (localhost, 127.0.0.1, a bare IP, an unregistered domain) = platform brand.
  return { ...base, admin: false };
}

/** db lookups must never take the server down if the DB is not open yet. */
function dbLookup(fn) { try { return fn(); } catch { return undefined; } }

function tenantFromOrg(org, host, slug) {
  if (!org) return { host, kind: 'unknown', slug, organizer: null, admin: false, brand: platformBrand() };
  const parsed = parseBrandJson(org.brand);
  const brand = mergeBrand(DEFAULT_BRAND, parsed);
  const live = org.status === 'live';
  return {
    host, kind: live ? 'tenant' : 'off', slug: org.slug || slug, organizer: org,
    admin: false, brand, baseUrl: `https://${host}`,
  };
}

function parseBrandJson(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { return {}; }
}

/** Brand of the admin/platform host (editable in the admin UI, stored in meta key `brand:platform`). */
export function platformBrand() {
  let saved = null;
  try { saved = db.getMeta('brand:platform'); } catch { /* db not open yet */ }
  const parsed = parseBrandJson(saved);
  const has = !!saved && Object.values(parsed).some((v) => v !== '' && v != null);
  return mergeBrand(DEFAULT_BRAND, { ...parsed, custom: has });
}

/** Brand of the ccam.my apex (only used when APEX_MODE=app). */
export function apexBrand() {
  let saved = null;
  try { saved = db.getMeta('brand:apex'); } catch { /* db not open yet */ }
  const parsed = parseBrandJson(saved);
  const has = !!saved && Object.values(parsed).some((v) => v !== '' && v != null);
  const def = { ...DEFAULT_BRAND, name: 'CCAM', shortName: 'CCAM', website: `https://${config.tenantZone}`, custom: has };
  return mergeBrand(def, parsed);
}
/** Resolve the tenant for one request. Cheap: one or two SQLite lookups. */
export function tenantFor(req) {
  const t = resolveHost(hostOf(req));
  if (!t.baseUrl) t.baseUrl = config.publicUrl;
  return t;
}

/** Public origin to build absolute links for this request (QR codes, share links, downloads). */
export function publicBase(req) {
  const t = req?.tenant || tenantFor(req);
  if (t.kind === 'platform' || t.kind === 'apex' || t.kind === 'tenant') return t.baseUrl || config.publicUrl;
  return config.publicUrl;
}

// ---------- HTML injection ----------
const BRAND_TEXT_RE = /JohorStudio\.com/g;
export const brandText = (s, brand) => String(s || '').replace(BRAND_TEXT_RE, brand.name);

function cssFor(brand) {
  const v = {
    '--teal': brand.colorPrimary, '--teal-dark': brand.colorPrimaryDark, '--teal-light': brand.colorPrimaryLight,
    '--teal-soft': brand.colorPrimarySoft, '--graphite': brand.colorGraphite, '--ink': brand.colorInk,
    '--paper': brand.colorPaper, '--mist': brand.colorMist, '--steel': brand.colorSteel,
    '--line': brand.colorLine, '--tally': brand.colorAccent,
    '--font': brand.font ? `"${brand.font.replace(/"/g, '')}", Archivo, system-ui, -apple-system, "Segoe UI", sans-serif` : '',
  };
  const body = Object.entries(v).filter(([, val]) => val).map(([k, val]) => `${k}:${val}`).join(';');
  return body ? `:root{${body}}` : '';
}

/** What /api/brand and window.__BRAND expose to the browser. */
export function brandPayload(tenant) {
  const b = tenant.brand;
  return {
    name: b.name, shortName: b.shortName || b.name, tagline: b.tagline,
    logo: b.logo, logoDark: b.logoDark, favicon: b.favicon || b.logo,
    website: b.website, whatsapp: b.whatsapp, contactUrl: b.contactUrl,
    heroHeadline: b.heroHeadline, heroSub: b.heroSub,
    disclaimer: b.disclaimer || config.tenantDisclaimer,
    hidePlatformLinks: !!b.hidePlatformLinks,
    colors: {
      primary: b.colorPrimary, primaryDark: b.colorPrimaryDark, primaryLight: b.colorPrimaryLight,
      primarySoft: b.colorPrimarySoft, graphite: b.colorGraphite, ink: b.colorInk, paper: b.colorPaper,
      mist: b.colorMist, steel: b.colorSteel, line: b.colorLine, accent: b.colorAccent,
    },
    font: b.font, fontUrl: b.fontUrl,
    host: tenant.host, kind: tenant.kind, slug: tenant.slug,
    isPlatform: tenant.kind === 'platform' && !b.custom,
  };
}

/**
 * Inject the tenant brand into a page's <head>. Plain JohorStudio pages are returned untouched
 * (fast path), so the main site keeps byte-identical HTML unless a brand was saved.
 */
export function injectHtml(html, tenant) {
  const b = tenant.brand;
  const needs = tenant.kind === 'tenant' || tenant.kind === 'off' || b.custom;
  if (!needs) return html;
  const css = cssFor(b);
  const payload = brandPayload(tenant);
  const parts = [];
  if (css) parts.push(`<style id="ccam-theme">${css}</style>`);
  if (b.fontUrl) {
    parts.push(`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`);
    parts.push(`<link rel="stylesheet" href="${escapeAttr(b.fontUrl)}">`);
  }
  const icon = b.favicon || b.logo;
  if (icon) parts.push(`<link rel="icon" href="${escapeAttr(icon)}">`);
  parts.push(`<script>window.__BRAND=${JSON.stringify(payload).replace(/</g, '\\u003c')};</script>`);
  parts.push('<script src="/js/brand.js" defer></script>');
  const block = parts.join('\n');
  let out = html;
  // Only titles/meta are rewritten server-side; visible text is handled by brand.js.
  out = out.replace(/(<title>)([\s\S]*?)(<\/title>)/i, (_, a, t, c) => a + brandText(t, b) + c);
  out = out.replace(/(<meta\s+name="description"\s+content=")([^"]*)(")/i, (_, a, t, c) => a + escapeAttr(brandText(t, b)) + c);
  if (icon) out = out.replace(/<link\s+rel="icon"[^>]*>/i, '');
  if (out.includes('</head>')) out = out.replace('</head>', `${block}\n</head>`);
  else out = block + out;
  return out.replace(/<html\b([^>]*)>/i, (m, attrs) => `<html${attrs} data-tenant="${escapeAttr(tenant.slug || 'apex')}">`);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal standalone page for a switched-off or unknown subdomain. */
export function statusPage(tenant, { title, message, status = 503 }) {
  const b = tenant.brand;
  const css = cssFor(b);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeAttr(title)}</title>${css ? `<style>${css}</style>` : ''}
<style>body{font-family:var(--font,Archivo,system-ui,sans-serif);background:var(--paper,#f5f7f7);color:var(--ink,#1d2528);margin:0;display:grid;place-items:center;min-height:100vh;padding:24px}
.box{max-width:440px;text-align:center}.box h1{font-size:24px;margin:0 0 10px}.box p{color:var(--steel,#66737a);margin:0 0 18px}
.brand{font-weight:700;font-size:20px;color:var(--teal,#1f6f68);text-decoration:none}</style></head>
<body><div class="box"><a class="brand" href="${escapeAttr(b.website || '/')}">${escapeAttr(b.name)}</a>
<h1>${escapeAttr(title)}</h1><p>${escapeAttr(message)}</p>
<p style="font-size:12px">${escapeAttr(config.tenantDisclaimer)}</p></div></body></html>`;
  return { status, html };
}

// ---------- request gate ----------
const PAGE_PATHS = [/^\/$/, /^\/admin\/?$/, /^\/panel\/?$/, /^\/shoot\/?$/, /^\/organizers\/?$/,
  /^\/c\/\d{6}\/?$/, /^\/join\/\d{6}\/?$/, /^\/show\/[0-9a-f-]{36}\/?$/, /^\/e\/[a-z0-9]{6,16}\/?$/, /^\/d\/[A-Za-z0-9_-]{10,40}\/?$/];

export function isPagePath(pathname) { return PAGE_PATHS.some((re) => re.test(pathname)); }

/**
 * Host-level guards that run before routing:
 *  - /admin and /api/admin exist only on ADMIN_HOST (tenant hosts redirect or 403)
 *  - APEX_MODE=redirect sends page requests from ccam.my to live.johorstudio.com
 * Returns null (continue) or {action:'redirect',location} | {action:'deny',status,error}.
 */
export function guard(tenant, pathname, method, search = '') {
  // Cloudflare Access only covers /admin and /api/admin, so the raw file names must never be served:
  // /admin.html would skip the login. The organisers UI lives under /admin/organizers for the same reason.
  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/admin.html' || pathname === '/organizers.html') return { action: 'redirect', location: `${isAdminHost(tenant.host) ? '' : `https://${config.adminHost}`}/admin${search}` };
    if (pathname === '/panel.html') return { action: 'redirect', location: `/panel${search}` };
    if (pathname === '/organizers' || pathname === '/organizers/') return { action: 'redirect', location: `${isAdminHost(tenant.host) ? '' : `https://${config.adminHost}`}/admin/organizers${search}` };
  }
  const adminish = pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin');
  // Only client-facing hosts are restricted. The platform host, localhost/127.0.0.1 (dev, health checks,
  // the SSH tunnel in tests) and an unregistered hostname keep the original behaviour; Cloudflare Access
  // is what actually authenticates /admin in production.
  const restricted = tenant.kind !== 'platform';
  if (adminish && restricted) {
    if (pathname.startsWith('/api/admin')) return { action: 'deny', status: 403, error: 'Admin is only available on the platform admin host' };
    if (method === 'GET' || method === 'HEAD') return { action: 'redirect', location: `https://${config.adminHost}${pathname}${search}` };
    return { action: 'deny', status: 403, error: 'Admin is only available on the platform admin host' };
  }
  if (tenant.kind === 'apex' && config.apexMode === 'redirect' && isPagePath(pathname) && (method === 'GET' || method === 'HEAD')) {
    return { action: 'redirect', location: `${config.publicUrl}${pathname}${search}` };
  }
  return null;
}

/** ETag suffix so HTML cached for one tenant is never served for another. */
export function tenantTag(tenant) {
  return `${tenant.kind}:${tenant.slug || '-'}:${tenant.brand.updatedAt || 0}`;
}
