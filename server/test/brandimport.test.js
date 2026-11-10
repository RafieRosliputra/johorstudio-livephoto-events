// Brand import unit tests: JSON-LD names, vendor-colour filtering, icon-font filtering, logo pixel
// sampling (PNG + SVG) and WCAG contrast. No network is used. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as bi from '../src/brandimport.js';

// ---- helpers to build a tiny PNG without any image library ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(Buffer.from([0])); // filter: none
    for (let x = 0; x < w; x++) rows.push(Buffer.from(pixels[y * w + x]));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('parseJsonLd reads an Organization name/slogan/logo', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'ignore me' },
      { '@type': 'Organization', name: 'Passion Sound and Event', slogan: 'Event Planner JB & KL', logo: { url: 'https://x/logo.png' }, telephone: '+607 562 3132' },
    ],
  })}</script></head></html>`;
  const nodes = bi.parseJsonLd(html);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].name, 'Passion Sound and Event');
  assert.equal(nodes[0].slogan, 'Event Planner JB & KL');
  assert.equal(nodes[0].logo, 'https://x/logo.png');
  assert.equal(nodes[0].telephone, '+607 562 3132');
});

test('looksLikeBrand rejects keyword-stuffed site names', () => {
  assert.equal(bi.looksLikeBrand('Passion Sound and Event'), true);
  assert.equal(bi.looksLikeBrand('PSE'), true);
  assert.equal(bi.looksLikeBrand('Best Event Company Johor Bahru (JB)'), false);
  assert.equal(bi.looksLikeBrand('Event Planner Kuala Lumpur (KL), Selangor, Malaysia - Homepage'), false);
  assert.equal(bi.looksLikeBrand('A | B'), false);
});

test('rankNameCandidates prefers JSON-LD over page titles and dedupes', () => {
  const ranked = bi.rankNameCandidates([
    { value: 'Best Event Company Johor Bahru (JB)', from: 'title segment', weight: 12 },
    { value: 'Passion Sound and Event', from: 'JSON-LD organization name', weight: 100 },
    { value: 'passion sound and event', from: 'og:site_name', weight: 70 },
  ]);
  assert.equal(ranked[0].value, 'Passion Sound and Event');
  assert.equal(ranked[0].weight, 100);
  assert.equal(ranked.filter((r) => r.value.toLowerCase() === 'passion sound and event').length, 1);
});

test('vendor colours (Bootstrap / WordPress palette) are never suggested as the brand', () => {
  const rows = bi.coloursIn('.a{color:#d9534f}.b{background:#9b51e0}.c{color:#c50a76;border-color:#c50a76}');
  const s = bi.suggestColours(rows);
  assert.equal(s.primary, '#c50a76');
  assert.ok(s.vendor.some((v) => v.hex === '#d9534f' && /Bootstrap/.test(v.why)));
  assert.ok(!s.palette.includes('#d9534f'));
  assert.ok(!s.palette.includes('#9b51e0'));
});

test('icon fonts are filtered out; real fonts are kept', () => {
  const css = '.a{font-family:eicons}.b{font-family:"Raleway",sans-serif}.c{font-family:dashicons}';
  const fonts = bi.fontsIn(css);
  assert.deepEqual(fonts.map((f) => f.name), ['Raleway']);
  assert.equal(bi.isIconFont('eicons'), true);
  assert.equal(bi.isIconFont('Raleway'), false);
});

test('contrastOn computes WCAG contrast for white text', () => {
  assert.equal(bi.contrastOn('#ffffff'), 1);
  assert.equal(bi.contrastOn('#000000'), 21);
  const c = bi.contrastOn('#c61a81'); // the Passion logo magenta
  assert.ok(c >= 4.5 && c <= 8, `got ${c}`);
});

test('dominantColoursOfImage reads an SVG logo', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="#c50a76"/><path fill="#ffc012"/><path fill="#c50a76"/></svg>');
  const res = bi.dominantColoursOfImage(svg, 'image/svg+xml');
  assert.equal(res.kind, 'svg');
  assert.equal(res.rows[0].hex, '#c50a76');
  assert.equal(res.rows[0].count, 2);
  assert.ok(res.rows[0].share > res.rows[1].share);
});

test('dominantColoursOfImage decodes a PNG logo and keeps saturation/contrast info', () => {
  // 4x4: 12 magenta pixels + 4 gold pixels (the Passion wordmark colours, simplified)
  const magenta = [200, 10, 118, 255];
  const gold = [245, 186, 34, 255];
  const px = [];
  for (let i = 0; i < 16; i++) px.push(i < 12 ? magenta : gold);
  const png = makePng(4, 4, px);
  const res = bi.dominantColoursOfImage(png, 'image/png');
  assert.equal(res.kind, 'png');
  assert.equal(res.rows[0].hex, '#c80a76');
  assert.ok(res.rows.some((r) => r.hex === '#f5ba22'));
  assert.ok(res.rows.every((r) => typeof r.contrastWhite === 'number'));
  assert.ok(res.rows[0].share > 50);
});

test('imageCandidates finds hero/event photos and skips the logo', () => {
  const html = `<img src="/logo.png" class="logo" width="200" height="60">
    <img src="/uploads/hero-1.jpg" width="1920" height="1280">
    <img src="/uploads/thumb.png" width="120" height="90">
    <div style="background-image:url('/uploads/bg-2.webp')"></div>`;
  const logos = [{ url: 'https://x.test/logo.png' }];
  const imgs = bi.imageCandidates(html, 'https://x.test/page', logos);
  assert.ok(imgs.some((i) => i.url === 'https://x.test/uploads/hero-1.jpg'));
  assert.ok(imgs.some((i) => i.url === 'https://x.test/uploads/bg-2.webp'));
  assert.ok(!imgs.some((i) => i.url.endsWith('/logo.png')));
});

test('unsupported image formats fail explicitly (JPEG/WebP are not decoded)', () => {
  assert.throws(() => bi.dominantColoursOfImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'));
});
