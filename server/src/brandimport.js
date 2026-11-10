// Brand import: read a client's website and pull out name/logo/colours/fonts for the admin to review.
// No npm packages. Everything here is a *candidate* list: the admin picks what to apply, nothing is
// trusted blindly. Only public https:// hosts are fetched (the caller checks the URL, we re-check
// every redirect).
import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 CCAM-BrandBot';
const MAX_HTML = 2 * 1024 * 1024;
const MAX_CSS = 1024 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_REDIRECTS = 4;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === '::' || h === '::1' || h.startsWith('::ffff:')) return true;
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

async function assertPublicHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) { if (privateIp(h)) throw new Error('Private addresses are not allowed'); return; }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); } catch { throw new Error('Host not found'); }
  if (addrs.some((a) => privateIp(a.address))) throw new Error('Private addresses are not allowed');
}

async function readCapped(res, cap) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, cap);
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(Buffer.from(value));
    if (size >= cap) { try { await reader.cancel(); } catch { /* ignore */ } break; }
  }
  return Buffer.concat(chunks).subarray(0, cap);
}

export async function safeFetch(url, { cap = MAX_HTML, timeout = 12000, accept = '*/*' } = {}) {
  let target = String(url);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const u = new URL(target);
    if (u.protocol !== 'https:') throw new Error('Only https:// URLs are allowed');
    await assertPublicHost(u.hostname);
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, 'accept-language': 'en-MY,en;q=0.9' },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} without a location`);
      target = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { res, body: await readCapped(res, cap), finalUrl: u.toString() };
  }
  throw new Error('Too many redirects');
}

// ---------- HTML parsing (regex only: this is a hint extractor, not a browser) ----------
const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i');
    const m = re.exec(html);
    if (m) return decode(m[1]).trim();
    const re2 = new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${name}["']`, 'i');
    const m2 = re2.exec(html);
    if (m2) return decode(m2[1]).trim();
  }
  return '';
}

function linkHref(html, rel) {
  const re = new RegExp(`<link\\b[^>]*rel\\s*=\\s*["']([^"']*\\b${rel}\\b[^"']*)["'][^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  const tag = m[0];
  const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  const sizes = /sizes\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
  return href ? { href: decode(href), sizes } : null;
}

const ABS = (base, href) => { try { return new URL(href, base).toString(); } catch { return null; } };

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function nameCandidates(html, host) {
  const out = [];
  const add = (v, from) => {
    v = String(v || '').replace(/\s+/g, ' ').trim();
    if (!v || v.length > 80) return;
    if (!out.some((o) => o.value.toLowerCase() === v.toLowerCase())) out.push({ value: v, from });
  };
  add(metaContent(html, ['og:site_name', 'application-name', 'apple-mobile-web-app-title']), 'meta og:site_name');
  const t = titleOf(html);
  if (t) {
    const first = t.split(/\s*[|\u2013\u2014-]\s*/)[0].trim();
    add(first, 'title (first segment)');
  }
  const alt = /<img[^>]*(?:class|id|alt)\s*=\s*["'][^"']*(?:logo|brand)[^"']*["'][^>]*alt\s*=\s*["']([^"']+)["']/i.exec(html)
    || /<img[^>]*alt\s*=\s*["']([^"']+)["'][^>]*(?:class|id)\s*=\s*["'][^"']*(?:logo|brand)/i.exec(html);
  if (alt) add(decode(alt[1]), 'img alt (logo)');
  const h1 = /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html);
  if (h1) add(decode(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '), 'h1');
  if (!out.length) {
    const bare = host.replace(/^www\./, '').split('.')[0];
    add(bare.charAt(0).toUpperCase() + bare.slice(1), 'hostname');
  }
  return out;
}

function logoCandidates(html, baseUrl) {
  const out = [];
  const add = (url, from, extra = {}) => {
    const abs = ABS(baseUrl, decode(url));
    if (!abs || !/^https?:/i.test(abs)) return;
    if (out.some((o) => o.url === abs)) return;
    out.push({ url: abs, from, ...extra });
  };
  const og = metaContent(html, ['og:image', 'twitter:image']);
  if (og) add(og, 'og:image');
  for (const rel of ['apple-touch-icon', 'icon', 'shortcut icon', 'mask-icon']) {
    const l = linkHref(html, rel);
    if (l) add(l.href, `<link rel=${rel}>${l.sizes ? ` ${l.sizes}` : ''}`, l.sizes ? { sizes: l.sizes } : {});
  }
  const imgRe = /<img\b[^>]*>/gi;
  let m, n = 0;
  while ((m = imgRe.exec(html)) && n < 400) {
    n++;
    const tag = m[0];
    const src = /(?:src|data-src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const classId = `${/class\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || ''} ${/id\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || ''}`;
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (/logo|brand/i.test(`${src} ${classId} ${alt}`)) add(src, `img (logo|brand in src/class/alt)`);
    else if (/header|navbar|site-header/i.test(classId)) add(src, 'img inside header');
    if (out.length >= 8) break;
  }
  return out;
}

// ---------- colours ----------
function rgbToHex(r, g, b) {
  const f = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
function hexToHsl(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let hh = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hh = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
  }
  return [hh, s * 100, l * 100];
}

export function coloursIn(css) {
  const counts = new Map();
  const push = (hex) => { const k = hex.toLowerCase(); counts.set(k, (counts.get(k) || 0) + 1); };
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let h = m[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    push('#' + h);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*([\d.]+))?\s*\)/gi)) {
    if (m[4] != null && Number(m[4]) < 0.5) continue; // transparent backgrounds are not a brand colour
    push(rgbToHex(+m[1], +m[2], +m[3]));
  }
  for (const m of css.matchAll(/hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/gi)) {
    const [h, s, l] = [+m[1], +m[2], +m[3]];
    // hsl -> rgb
    const c = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100), x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = l / 100 - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg].map((v) => (v + mm) * 255);
    push(rgbToHex(...rgb));
  }
  const rows = [...counts.entries()].map(([hex, count]) => {
    const [h, s, l] = hexToHsl(hex);
    return { hex, count, h, s, l };
  }).sort((a, b) => b.count - a.count);
  return rows;
}

/** Turn a colour list into suggested brand values. */
export function suggestColours(rows) {
  const saturated = rows.filter((r) => r.s >= 22 && r.l >= 12 && r.l <= 82);
  const neutrals = rows.filter((r) => r.s < 22);
  const darks = rows.filter((r) => r.l < 26);
  const lights = rows.filter((r) => r.l > 90 && r.s < 30);
  const primary = saturated[0]?.hex || '';
  const accent = saturated.find((r) => r.hex !== primary && Math.abs(r.h - (rows.find((x) => x.hex === primary)?.h ?? 0)) > 25)?.hex || '';
  return {
    primary,
    accent,
    graphite: darks[0]?.hex || '',
    ink: rows.filter((r) => r.s < 35 && r.l > 8 && r.l < 28)[0]?.hex || '',
    paper: lights[0]?.hex || '',
    palette: saturated.slice(0, 5).map((r) => r.hex),
    neutrals: neutrals.slice(0, 4).map((r) => r.hex),
  };
}

function fontsIn(css) {
  const counts = new Map();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)[;}]/gi)) {
    const stack = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const main = stack.find((f) => !/^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica|arial|emoji|math)$/i.test(f));
    if (main) counts.set(main, (counts.get(main) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })).slice(0, 6);
}

function googleFontUrl(html) {
  const m = /<link[^>]*href\s*=\s*["'](https:\/\/fonts\.googleapis\.com\/[^"']+)["']/i.exec(html);
  return m ? decode(m[1]) : '';
}

/**
 * Fetch a client's website and return brand candidates for the admin UI.
 * Throws on network/validation errors; the caller shows the message.
 */
export async function extractBrand(siteUrl) {
  const { body, finalUrl } = await safeFetch(siteUrl, { cap: MAX_HTML, accept: 'text/html,application/xhtml+xml' });
  const html = body.toString('utf8');
  const base = finalUrl;
  const sources = [];

  const names = nameCandidates(html, new URL(base).hostname);
  sources.push({ field: 'name', from: 'og:site_name / title / logo alt / h1' });

  const logos = logoCandidates(html, base);
  const fav = linkHref(html, 'icon') || linkHref(html, 'apple-touch-icon');
  const favIcon = fav ? ABS(base, fav.href) : (logos[0]?.url || '');
  const ogImage = metaContent(html, ['og:image']) || '';
  const themeColor = metaContent(html, ['theme-color']);
  const description = metaContent(html, ['description', 'og:description']);
  const taglineCandidates = [];
  const h1 = /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html);
  if (h1) taglineCandidates.push({ value: decode(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), from: 'h1' });
  const sub = /<(?:p|h2|div)[^>]*class\s*=\s*["'][^"']*(?:tagline|subtitle|sub-heading|slogan)[^"']*["'][^>]*>([\s\S]{1,300}?)<\//i.exec(html);
  if (sub) taglineCandidates.push({ value: decode(sub[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), from: 'tagline element' });

  // Colours: inline CSS + up to 3 same-site stylesheets.
  let css = '';
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += m[1] + '\n';
  const sheets = [];
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["'][^"']*stylesheet[^"']*["'][^>]*>/gi)) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    const abs = href ? ABS(base, href) : null;
    if (abs && abs.startsWith('https://') && !sheets.includes(abs)) sheets.push(abs);
    if (sheets.length >= 3) break;
  }
  for (const sheet of sheets) {
    try {
      const r = await safeFetch(sheet, { cap: MAX_CSS, accept: 'text/css' });
      css += r.body.toString('utf8') + '\n';
      sources.push({ field: 'colours', from: sheet });
    } catch { /* a stylesheet we cannot read is not fatal */ }
  }
  const rows = coloursIn(css);
  const suggestedColors = suggestColours(rows);
  if (themeColor && /^#[0-9a-f]{6}$/i.test(themeColor)) suggestedColors.primary = themeColor;

  const fonts = fontsIn(css);
  return {
    url: siteUrl,
    finalUrl: base,
    fetchedAt: new Date().toISOString(),
    name: names[0]?.value || '',
    nameCandidates: names,
    tagline: taglineCandidates[0]?.value || '',
    taglineCandidates,
    description,
    ogImage,
    favicon: favIcon,
    logoCandidates: logos,
    themeColor,
    colors: rows.slice(0, 12),
    suggestedColors,
    fonts,
    fontUrl: googleFontUrl(html),
    sources,
  };
}

/** Download a logo candidate into memory (checked public https only). */
export async function fetchImage(url) {
  const { body, res, finalUrl } = await safeFetch(url, { cap: MAX_IMAGE, accept: 'image/*' });
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { body, contentType: type, finalUrl };
}
