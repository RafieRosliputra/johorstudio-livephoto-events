// Streaming ZIP (no compression: photos are already compressed). Nothing is written to disk;
// the exact size is known up front, so browsers show real progress. ZIP64 records are added
// only when the archive passes 4 GB, so small archives stay plain ZIP for old unzip tools.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LIMIT = 0xffffffff;

function dosTime(ms) {
  const d = new Date(ms);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ name, file, size, mtime }] -> { size, pipe(res) }. Each file must be smaller than 4 GB. */
export function zipPlan(entries, { limit = LIMIT } = {}) {
  let offset = 0;
  const items = entries.map((e) => {
    const name = Buffer.from(e.name, 'utf8');
    const it = { ...e, nameBuf: name, offset, ...dosTime(e.mtime || Date.now()) };
    offset += 30 + name.length + e.size + 16; // local header + data + data descriptor
    return it;
  });
  const cdStart = offset;
  let cdSize = 0;
  for (const it of items) {
    it.big = it.offset >= limit;
    cdSize += 46 + it.nameBuf.length + (it.big ? 12 : 0);
  }
  const zip64 = cdStart + cdSize >= limit || items.length >= 0xffff || items.some((it) => it.big);
  const size = cdStart + cdSize + (zip64 ? 56 + 20 : 0) + 22;
  return { size, count: items.length, pipe: (res) => stream(res, items, cdStart, cdSize, zip64) };
}

async function stream(res, items, cdStart, cdSize, zip64) {
  const write = (buf) => (res.write(buf) ? null : new Promise((r) => res.once('drain', r)));
  let aborted = false;
  res.on('close', () => { aborted = true; });
  for (const it of items) {
    if (aborted) return;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(it.big ? 45 : 20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(it.time, 10); h.writeUInt16LE(it.date, 12); // crc and sizes follow in the data descriptor
    h.writeUInt16LE(it.nameBuf.length, 26);
    await write(Buffer.concat([h, it.nameBuf]));
    let crc = 0, n = 0;
    try {
      for await (const chunk of fs.createReadStream(it.file, { highWaterMark: 1 << 20 })) {
        if (aborted) return;
        crc = zlib.crc32(chunk, crc); n += chunk.length;
        await write(chunk);
      }
    } catch { /* file gone meanwhile: the archive would be wrong, stop */ }
    if (n !== it.size) { res.destroy(); return; }
    it.crc = crc >>> 0;
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(it.crc, 4); dd.writeUInt32LE(it.size, 8); dd.writeUInt32LE(it.size, 12);
    await write(dd);
  }
  const cd = [];
  for (const it of items) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 45, 4); c.writeUInt16LE(it.big ? 45 : 20, 6); c.writeUInt16LE(0x0808, 8);
    c.writeUInt16LE(0, 10); c.writeUInt16LE(it.time, 12); c.writeUInt16LE(it.date, 14);
    c.writeUInt32LE(it.crc, 16); c.writeUInt32LE(it.size, 20); c.writeUInt32LE(it.size, 24);
    c.writeUInt16LE(it.nameBuf.length, 28); c.writeUInt16LE(it.big ? 12 : 0, 30);
    c.writeUInt32LE(it.big ? LIMIT : it.offset, 42);
    cd.push(c, it.nameBuf);
    if (it.big) { const x = Buffer.alloc(12); x.writeUInt16LE(1, 0); x.writeUInt16LE(8, 2); x.writeBigUInt64LE(BigInt(it.offset), 4); cd.push(x); }
  }
  await write(Buffer.concat(cd));
  if (zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(items.length), 24); z.writeBigUInt64LE(BigInt(items.length), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40); z.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdStart + cdSize), 8); loc.writeUInt32LE(1, 16);
    await write(Buffer.concat([z, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : items.length, 8); end.writeUInt16LE(zip64 ? 0xffff : items.length, 10);
  end.writeUInt32LE(zip64 ? LIMIT : cdSize, 12); end.writeUInt32LE(zip64 ? LIMIT : cdStart, 16);
  await write(end);
  res.end();
}
