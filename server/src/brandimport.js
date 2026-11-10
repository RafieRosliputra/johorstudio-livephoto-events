// Brand import: read a client's website and pull out name/logo/colours/fonts for the admin to review.
// No npm packages. Everything here is a *candidate* list: the admin picks what to apply, nothing is
// trusted blindly. Only public https:// hosts are fetched (the caller checks the URL, we re-check
// every redirect).
import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';

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

// Framework/theme defaults that are NOT a client's brand (Bootstrap, Elementor, WP 2019, Avada...).
export const VENDOR_COLORS = new Map([
  ['#d9534f', 'Bootstrap 3 danger'], ['#5cb85c', 'Bootstrap 3 success'], ['#5bc0de', 'Bootstrap 3 info'],
  ['#f0ad4e', 'Bootstrap 3 warning'], ['#337ab7', 'Bootstrap 3 primary'],
  ['#0d6efd', 'Bootstrap 5 primary'], ['#198754', 'Bootstrap 5 success'], ['#dc3545', 'Bootstrap 5 danger'],
  ['#ffc107', 'Bootstrap 5 warning'], ['#0dcaf0', 'Bootstrap 5 info'],
  ['#61ce70', 'Elementor default green'], ['#25d366', 'WhatsApp brand green'], ['#409eff', 'Element-UI blue'],
  ['#1a7efb', 'vendor blue'], ['#cf2e2e', 'WordPress 2019 red'], ['#ff6900', 'WordPress 2019 orange'],
  ['#fcb900', 'WordPress 2019 yellow'], ['#7ad03a', 'WordPress 2019 green'], ['#0693e3', 'WordPress 2019 blue'],
  ['#eeee22', 'WordPress 2019 yellow'], ['#a0ce4e', 'Avada green'], ['#6ec1e4', 'Elementor/Astra blue'],
  ['#7a7a7a', 'generic grey'], ['#4a4a4a', 'generic grey'], ['#54595f', 'Elementor secondary'],
  // WordPress editor palette (shipped with every WP site since 5.0)
  ['#00d084', 'WordPress 2019 green'], ['#8ed1fc', 'WordPress 2019 light blue'], ['#abb8c3', 'WordPress 2019 grey'],
  ['#eb144c', 'WordPress 2019 pink'], ['#f78da7', 'WordPress 2019 pale pink'], ['#9900ef', 'WordPress 2019 violet'],
  ['#9b51e0', 'WordPress 2019 purple'], ['#2ea3f2', 'Divi blue'],
  ['#7bdcb5', 'WordPress 2019 green'], ['#7adcb4', 'WordPress 2019 green'], ['#00d082', 'WordPress 2019 green'],
  ['#4aeadc', 'WordPress 2019 cyan'], ['#9778d1', 'WordPress 2019 violet'],
]);

/** JSON-LD organizations: the most reliable brand name/slogan source on WordPress/Elementor sites. */
export function parseJsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const types = [].concat(node['@type'] || []).map(String).join(' ');
      if (!/Organization|LocalBusiness|Corporation|ProfessionalService|Store|Person/i.test(types)) continue;
      const logo = typeof node.logo === 'object' && node.logo ? (node.logo.url || node.logo['@id']) : node.logo;
      out.push({
        name: typeof node.name === 'string' ? node.name : '',
        alternateName: typeof node.alternateName === 'string' ? node.alternateName : '',
        slogan: typeof node.slogan === 'string' ? node.slogan : '',
        description: typeof node.description === 'string' ? node.description : '',
        url: typeof node.url === 'string' ? node.url : '',
        logo: typeof logo === 'string' ? logo : '',
        telephone: typeof node.telephone === 'string' ? node.telephone : '',
        email: typeof node.email === 'string' ? node.email : '',
      });
    }
  }
  return out;
}

// A brand name is short and is not keyword-stuffed like "Best Event Company Johor Bahru (JB)".
const NAME_STOP = /\b(best|top|cheap|company|companies|planner|planners|organizer|organisers?|organizers?|management|services?|homepage|official|website|malaysia|johor|kuala\s*lumpur|selangor|singapore|sdn|bhd)\b/i;
export function looksLikeBrand(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 46) return false;
  if (/[|,·•]/.test(t)) return false;
  if (t.split(' ').length > 5) return false;
  if (NAME_STOP.test(t)) return false;
  if (/^[\d\W]+$/.test(t)) return false;
  return true;
}
export function rankNameCandidates(list) {
  const seen = new Map();
  for (const c of list || []) {
    const k = String(c.value || '').toLowerCase().trim();
    if (!k) continue;
    const prev = seen.get(k);
    if (!prev || (c.weight || 0) > (prev.weight || 0)) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 6);
}

function nameCandidates(html, host, jsonld = []) {
  const raw = [];
  const push = (value, from, weight) => {
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v || v.length < 2 || v.length > 90) return;
    raw.push({ value: v, from, weight });
  };
  for (const j of jsonld) {
    push(j.name, 'JSON-LD organization name', looksLikeBrand(j.name) ? 100 : 30);
    push(j.alternateName, 'JSON-LD alternate name', looksLikeBrand(j.alternateName) ? 70 : 25);
  }
  push(metaContent(html, ['application-name', 'apple-mobile-web-app-title']), 'meta application-name', 85);
  const og = metaContent(html, ['og:site_name']);
  push(og, 'meta og:site_name', looksLikeBrand(og) ? 70 : 20);
  const t = titleOf(html);
  if (t) for (const seg of t.split(/\s*[|\u2013\u2014]\s*/)) push(seg, 'title segment', looksLikeBrand(seg) ? 55 : 12);
  const alt = /<img[^>]*(?:class|id|alt)\s*=\s*["'][^"']*(?:logo|brand)[^"']*["'][^>]*alt\s*=\s*["']([^"']+)["']/i.exec(html)
    || /<img[^>]*alt\s*=\s*["']([^"']+)["'][^>]*(?:class|id)\s*=\s*["'][^"']*(?:logo|brand)/i.exec(html);
  if (alt) push(decode(alt[1]).replace(/\s*\b(logo|brand)\b\s*/gi, ' '), 'img alt (logo)', 65);
  const h1 = /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(html);
  if (h1) push(decode(h1[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '), 'h1', 35);
  const ranked = rankNameCandidates(raw);
  if (!ranked.length || (ranked[0].weight || 0) < 30) {
    const bare = host.replace(/^www\./, '').split('.')[0];
    ranked.push({ value: bare.charAt(0).toUpperCase() + bare.slice(1), from: 'hostname', weight: 5 });
  }
  return ranked;
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
  // Real logos are usually <img> tags in the header; icons come after them (they are tiny).
  const imgRe = /<img\b[^>]*>/gi;
  let m, n = 0;
  while ((m = imgRe.exec(html)) && n < 400) {
    n++;
    const tag = m[0];
    const src = /(?:src|data-src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const classId = `${/class\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || ''} ${/id\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || ''}`;
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (/logo|brand/i.test(`${src} ${classId} ${alt}`)) add(src, 'img (logo|brand in src/class/alt)');
    else if (/header|navbar|site-header/i.test(classId)) add(src, 'img inside header');
    if (out.length >= 6) break;
  }
  for (const rel of ['apple-touch-icon', 'icon', 'shortcut icon', 'mask-icon']) {
    const l = linkHref(html, rel);
    if (l) add(l.href, `<link rel=${rel}>${l.sizes ? ` ${l.sizes}` : ''}`, l.sizes ? { sizes: l.sizes } : {});
  }
  return out;
}

/** Event/hero photos from the client's site, for the tenant landing mosaic (up to 5 are used). */
export function imageCandidates(html, baseUrl, logos = []) {
  const out = [];
  const seen = new Set((logos || []).map((l) => l.url));
  const add = (url, from) => {
    const abs = ABS(baseUrl, decode(url));
    if (!abs || !/^https:\/\//i.test(abs) || seen.has(abs)) return;
    if (!/\.(jpe?g|png|webp|avif)(\?|$)/i.test(abs)) return;
    seen.add(abs);
    out.push({ url: abs, from });
  };
  const imgRe = /<img\b[^>]*>/gi;
  let m, n = 0;
  while ((m = imgRe.exec(html)) && n < 800) {
    n++;
    const tag = m[0];
    const src = /(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src) continue;
    const w = Number(/width\s*=\s*["']?(\d+)/i.exec(tag)?.[1] || 0);
    const h = Number(/height\s*=\s*["']?(\d+)/i.exec(tag)?.[1] || 0);
    const cls = /class\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] || '';
    const heroish = /hero|slide|banner|cover|gallery|portfolio|event|showcase/i.test(`${cls} ${src}`);
    if ((w >= 700 || h >= 700 || heroish)) add(src, `img${w ? ` ${w}x${h}` : ''}${heroish ? ' (hero/gallery)' : ''}`);
    if (out.length >= 10) break;
  }
  for (const bg of html.matchAll(/background(?:-image)?\s*:\s*[^;{}"']{0,40}?url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)) {
    add(bg[2], 'css background');
    if (out.length >= 10) break;
  }
  return out.slice(0, 8);
}

// ---------- colours ----------
function rgbToHex(r, g, b) {
  const f = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}
function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast of `hex` against `other` (default white); the app puts white text on the primary colour. */
export function contrastOn(hex, other = '#ffffff') {
  const a = luminance(hex), b = luminance(other);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
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


// ---------- colours from the logo itself ----------
// A website's CSS is often framework boilerplate (Bootstrap, WordPress palette); the real brand lives in
// the logo image. PNG and SVG can be decoded with the standard library, so the server samples the logo.
function pngPixels(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || bitDepth !== 8 || interlace !== 0) throw new Error('unsupported png');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported png colour type');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(stride * h);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

function countColor(counts, hex, weight = 1) {
  const k = hex.toLowerCase();
  counts.set(k, (counts.get(k) || 0) + weight);
}

/** Decode a PNG or SVG logo and return its dominant colours (no external packages). */
export function dominantColoursOfImage(buf, contentType = '') {
  const counts = new Map();
  let kind = '';
  const head = buf.subarray(0, 600).toString('utf8').replace(/^\uFEFF/, '').trim();
  if ((buf[0] === 0x89 && buf[1] === 0x50) || /png/i.test(contentType)) {
    const { w, h, channels, data } = pngPixels(buf);
    kind = 'png';
    const stepX = Math.max(1, Math.floor(w / 400));
    const stepY = Math.max(1, Math.floor(h / 400));
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * channels;
        let r, g, b, a = 255;
        if (channels === 4) { r = data[i]; g = data[i + 1]; b = data[i + 2]; a = data[i + 3]; }
        else if (channels === 3) { r = data[i]; g = data[i + 1]; b = data[i + 2]; }
        else if (channels === 2) { r = g = b = data[i]; a = data[i + 1]; }
        else { r = g = b = data[i]; }
        if (a < 128) continue;
        countColor(counts, rgbToHex(r, g, b));
      }
    }
  } else if (/svg|xml/i.test(contentType) || head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    kind = 'svg';
    for (const m of head.matchAll(/(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) {
      let hex = m[1];
      if (hex.length === 4) hex = '#' + hex.slice(1).split('').map((c) => c + c).join('');
      countColor(counts, hex);
    }
  } else {
    throw new Error('unsupported image type');
  }
  const rows = [...counts.entries()].map(([hex, count]) => {
    const [h, s, l] = hexToHsl(hex);
    return { hex, count, h, s, l };
  }).sort((a, b) => b.count - a.count);
  const total = rows.reduce((n, r) => n + r.count, 0) || 1;
  return {
    kind,
    rows: rows.slice(0, 12).map((r) => ({ ...r, share: Math.round((r.count / total) * 1000) / 10, contrastWhite: contrastOn(r.hex) })),
  };
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
  // Framework defaults outrank the real brand in a raw CSS count; drop them before choosing.
  const vendor = rows.filter((r) => VENDOR_COLORS.has(r.hex)).map((r) => ({ hex: r.hex, why: VENDOR_COLORS.get(r.hex) }));
  const usable = rows.filter((r) => !VENDOR_COLORS.has(r.hex));
  const saturated = usable.filter((r) => r.s >= 22 && r.l >= 12 && r.l <= 82);
  const neutrals = usable.filter((r) => r.s < 22);
  const darks = usable.filter((r) => r.l < 26);
  const lights = usable.filter((r) => r.l > 90 && r.s < 30);
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
    vendor: vendor.slice(0, 6),
  };
}

const ICON_FONT = /^(eicons|elementor-icons|fontawesome|font-awesome|dashicons|swiper-icons|themify-icons|icomoon|glyphicons|material-icons|simple-line-icons|feather|ionicons|lucide|remixicon|bootstrap-icons)$/i;
export const isIconFont = (name) => ICON_FONT.test(String(name || '').trim());
export function fontsIn(css) {
  const counts = new Map();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)[;}]/gi)) {
    const stack = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    const main = stack.find((f) => !/^(inherit|initial|unset|sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont|segoe ui|roboto|helvetica|arial|emoji|math)$/i.test(f) && !isIconFont(f));
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

  const jsonld = parseJsonLd(html);
  const names = nameCandidates(html, new URL(base).hostname, jsonld);
  sources.push({ field: 'name', from: 'JSON-LD organization / meta application-name / og:site_name / logo alt / title' });

  const logos = logoCandidates(html, base);
  const images = imageCandidates(html, base, logos);
  // The logo carries the real brand colours; sample the first PNG/SVG candidate we can decode.
  let logoColours = [];
  let logoPixelSource = null;
  for (const cand of logos.slice(0, 3)) {
    try {
      const img = await fetchImage(cand.url);
      const res = dominantColoursOfImage(img.body, img.contentType);
      const sat = res.rows.filter((r) => r.s >= 20 && r.l >= 10 && r.l <= 90 && !VENDOR_COLORS.has(r.hex));
      if (sat.length >= 2) { logoColours = sat.slice(0, 5); logoPixelSource = { url: cand.url, kind: res.kind }; break; }
    } catch { /* JPEG/WebP logos cannot be decoded here; CSS colours remain the fallback */ }
  }
  const fav = linkHref(html, 'icon') || linkHref(html, 'apple-touch-icon');
  const favIcon = fav ? ABS(base, fav.href) : (logos[0]?.url || '');
  const ogImage = metaContent(html, ['og:image']) || '';
  const themeColor = metaContent(html, ['theme-color']);
  const description = metaContent(html, ['description', 'og:description']);
  // Tagline candidates: JSON-LD slogan > visible tagline/h1 > title segment > meta description.
  const tagRaw = [];
  const pushT = (value, from, weight) => {
    const v = decode(String(value || '')).replace(/\s+/g, ' ').trim().replace(/^[|\u2013\u2014\-\s]+|[|\u2013\u2014\-\s]+$/g, '');
    if (v.length < 4 || v.length > 120) return;
    if (names[0] && v.toLowerCase() === names[0].value.toLowerCase()) return;
    tagRaw.push({ value: v, from, weight });
  };
  for (const j of jsonld) { pushT(j.slogan, 'JSON-LD slogan', 90); }
  const chosenName = names[0]?.value || '';
  const titleSegs = titleOf(html).split(/\s*[|\u2013\u2014]\s*/).map((x) => x.trim()).filter(Boolean);
  for (const seg of titleSegs) pushT(seg, 'title segment', looksLikeBrand(seg) ? 50 : 20);
  const h1 = /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html);
  if (h1) pushT(decode(h1[1].replace(/<[^>]+>/g, ' ')), 'h1', chosenName && h1[1].includes(chosenName) ? 35 : 55);
  const sub = /<(?:p|h2|div)[^>]*class\s*=\s*["'][^"']*(?:tagline|subtitle|sub-heading|slogan)[^"']*["'][^>]*>([\s\S]{1,300}?)<\//i.exec(html);
  if (sub) pushT(decode(sub[1].replace(/<[^>]+>/g, ' ')), 'tagline element', 60);
  const ogDesc = metaContent(html, ['og:description', 'description']);
  if (ogDesc) pushT(ogDesc.split(/(?<=[.!?])\s/)[0], 'meta description', 30);
  const taglineCandidates = rankNameCandidates(tagRaw).map(({ value, from }) => ({ value, from }));

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
  if (logoColours.length) {
    // Logo pixels beat the stylesheet: this is what makes the import pick the client's real colour.
    // Prefer the most frequent logo colour that can carry white text (the app puts white text on --teal).
    const primary = logoColours.find((c) => c.contrastWhite >= 4.5) || logoColours[0];
    const accent = logoColours.find((c) => Math.abs(c.h - primary.h) > 25 && c.hex !== primary.hex);
    suggestedColors.primary = primary.hex;
    if (accent) suggestedColors.accent = accent.hex;
    suggestedColors.palette = logoColours.map((c) => c.hex);
    suggestedColors.source = 'logo';
    suggestedColors.note = `primary picked from ${logoColours.length} logo colours (white-text contrast ${primary.contrastWhite}:1)`;
  } else if (themeColor && /^#[0-9a-f]{6}$/i.test(themeColor) && !VENDOR_COLORS.has(themeColor.toLowerCase())) {
    suggestedColors.primary = themeColor;
    suggestedColors.source = 'theme-color';
  } else {
    suggestedColors.source = 'stylesheet';
  }

  const fonts = fontsIn(css);
  const fontUrl = googleFontUrl(html);
  const googleFamily = (() => {
    if (!fontUrl) return '';
    const m = /[?&]family=([^:&]+)/i.exec(fontUrl);
    return m ? decode(m[1]).replace(/\+/g, ' ').trim() : '';
  })();
  if (googleFamily && !fonts.some((f) => f.name.toLowerCase() === googleFamily.toLowerCase())) {
    fonts.unshift({ name: googleFamily, count: 0, from: 'Google Fonts <link>' });
  }
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
    imageCandidates: images,
    logoColours,
    logoPixelSource,
    themeColor,
    colors: rows.slice(0, 12),
    suggestedColors,
    fonts,
    fontUrl,
    // Contact details a JSON-LD Organization block often carries (shown in the admin as hints).
    organization: jsonld[0] ? {
      name: jsonld[0].name, slogan: jsonld[0].slogan, url: jsonld[0].url,
      telephone: jsonld[0].telephone, email: jsonld[0].email, logo: jsonld[0].logo,
    } : null,
    sources,
  };
}

/** Download a logo candidate into memory (checked public https only). */
export async function fetchImage(url) {
  const { body, res, finalUrl } = await safeFetch(url, { cap: MAX_IMAGE, accept: 'image/*' });
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { body, contentType: type, finalUrl };
}
