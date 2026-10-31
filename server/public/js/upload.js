// Chunked, resumable upload (same protocol the Android app uses):
//   POST start -> {id, chunk}; PUT /api/uploads/:id?offset=N; PUT thumbs; POST complete.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body, headers = {}) {
  const r = await fetch(url, { method, body, headers, credentials: 'same-origin' });
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  return { status: r.status, ok: r.ok, data };
}

// Wait until the browser says it is online again (or 30 s, in case the event never fires).
const online = () => (navigator.onLine === false ? new Promise((r) => { const t = setTimeout(r, 30000); addEventListener('online', () => { clearTimeout(t); r(); }, { once: true }); }) : null);

// Retry network errors / 5xx with backoff. 4xx errors (except 409/429) are final.
// tries = Infinity keeps going until the signal comes back (photographers).
async function withRetry(fn, tries = 8, onWait) {
  let wait = 1000;
  for (let i = 0; ; i++) {
    let res;
    try { res = await fn(); } catch (e) { res = { status: 0, data: { error: 'Network error' } }; }
    if (res.ok || res.status === 409) return res;
    const retryable = res.status === 0 || res.status >= 500 || res.status === 429;
    if (!retryable || i >= tries) {
      const e = new Error(res.data.error || `Upload failed (${res.status || 'network'})`);
      e.status = res.status; throw e;
    }
    onWait?.(res.status === 0 ? 'No connection, retrying…' : 'Server busy, retrying…');
    await (online() || sleep(wait)); wait = Math.min(wait * 2, 15000);
  }
}

/** Returns the photo; photo.duplicate = true when the server already had this file (startBody.key). */
export async function uploadPhoto({ startUrl, startBody, blob, thumbs = {}, onProgress = () => {}, tries = 8, onWait }) {
  const R = (fn) => withRetry(fn, tries, onWait);
  const start = await R(() => req('POST', startUrl, JSON.stringify({ ...startBody, size: blob.size }), { 'content-type': 'application/json' }));
  if (start.data.duplicate) return { ...start.data.photo, duplicate: true };
  const { id, chunk } = start.data;
  let offset = start.data.received || 0;
  while (offset < blob.size) {
    const part = blob.slice(offset, Math.min(blob.size, offset + chunk));
    const r = await R(() => req('PUT', `/api/uploads/${id}?offset=${offset}`, part));
    offset = r.data.received;
    onProgress(offset / blob.size);
  }
  for (const [size, t] of Object.entries(thumbs)) {
    if (t) await R(() => req('PUT', `/api/uploads/${id}/thumb/${size}`, t));
  }
  const done = await R(() => req('POST', `/api/uploads/${id}/complete`));
  return done.data.photo;
}
