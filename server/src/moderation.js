// Guest photo moderation. Every guest upload starts as "pending" and is invisible until checked:
//   ok    -> approved (appears in the gallery and on the big screen)
//   flag  -> flagged  (waits for the admin / organiser: Allow or Remove)
//   block -> blocked  (clear NSFW: hidden, kept for the admin)
// The AI runs in a separate app on m10 (moderator/, Python). If it does not answer after a few
// tries the photo is flagged "moderator offline" so a person decides; nothing is published unchecked.
import path from 'node:path';
import { config } from './config.js';
import * as db from './db.js';
import { publishPhoto } from './live.js';
import { eventDir } from './storage.js';

// Names guests type (max 20 chars). Rude words (BM + EN) and party names are flagged, not rejected.
const WORDS = [
  // English
  'fuck', 'fck', 'fuk', 'shit', 'bitch', 'bastard', 'dick', 'pussy', 'cunt', 'asshole', 'slut', 'whore', 'porn', 'sex', 'nude',
  // Bahasa Melayu
  'babi', 'bodoh', 'bodo', 'sial', 'celaka', 'pukimak', 'puki', 'pantat', 'butoh', 'konek', 'lancau', 'pundek', 'jubur', 'haram jadah',
  'anjing', 'bangsat', 'sundal', 'lahanat', 'kimak', 'keparat', 'setan', 'bengap', 'bahalol', 'barua',
  // politics
  'umno', 'pas', 'pkr', 'dap', 'bersatu', 'amanah', 'muda', 'perikatan', 'pakatan', 'barisan', 'gerakan', 'mca', 'mic', 'reformasi',
];
const WORD_RE = new RegExp(`(^|[^a-z])(${WORDS.map((w) => w.replace(/ /g, '\\s*')).join('|')})([^a-z]|$)`, 'i');
export const nameIsSuspicious = (name) => !!name && WORD_RE.test(name.toLowerCase().replace(/[0@]/g, 'o').replace(/[1!]/g, 'i').replace(/3/g, 'e').replace(/\$/g, 's'));

async function askModerator(photo, ev) {
  const rel = path.relative(config.photosDir, path.join(eventDir(ev), photo.rel_path));
  const r = await fetch(`${config.moderatorUrl}/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: rel, id: photo.id }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`moderator ${r.status}`);
  return r.json(); // {verdict: 'ok'|'flag'|'block', labels: [...], scores: {...}}
}

const running = new Set();
export async function checkPhoto(photo) {
  if (running.has(photo.id)) return;
  running.add(photo.id);
  try {
    const ev = db.getEvent(photo.event_id);
    if (!ev) return;
    const nameFlag = nameIsSuspicious(photo.uploader) ? ['name'] : [];
    let verdict = 'ok', labels = [];
    if (config.moderatorUrl) {
      try {
        const res = await askModerator(photo, ev);
        verdict = ['ok', 'flag', 'block'].includes(res.verdict) ? res.verdict : 'flag';
        labels = Array.isArray(res.labels) ? res.labels.slice(0, 8).map(String) : [];
      } catch (e) {
        db.bumpModTries(photo.id);
        const p = db.getPhoto(photo.id);
        if (p && p.mod_tries >= 3) publishPhoto(db.setPhotoStatus(p.id, 'flagged', ['moderator offline', ...nameFlag]));
        else console.error('[moderator]', e.message);
        return;
      }
    }
    const fresh = db.getPhoto(photo.id);
    if (!fresh || fresh.status !== 'pending') return; // a person decided meanwhile
    const flags = [...labels, ...nameFlag];
    const st = verdict === 'block' ? 'blocked' : verdict === 'flag' || nameFlag.length ? 'flagged' : 'approved';
    const out = db.setPhotoStatus(photo.id, st, flags);
    publishPhoto(out);
    if (st === 'approved') findFaces(out);
  } finally {
    running.delete(photo.id);
  }
}

// Faces for the big screen (zoom / pan towards people). Any approved photo, photographer or guest.
// The photo is published again with its face boxes; the screen uses them when it shows the photo.
const faceRunning = new Set(), faceFails = new Map();
export async function findFaces(photo) {
  if (!config.moderatorUrl || faceRunning.has(photo.id) || faceRunning.size >= 3) return;
  faceRunning.add(photo.id);
  try {
    const ev = db.getEvent(photo.event_id);
    if (!ev) return;
    const rel = path.relative(config.photosDir, path.join(eventDir(ev), photo.rel_path));
    const r = await fetch(`${config.moderatorUrl}/faces`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: rel }), signal: AbortSignal.timeout(30000) });
    if (r.status === 404) { db.setFaces(photo.id, []); return; }
    if (!r.ok) throw new Error(`faces ${r.status}`);
    const { faces } = await r.json();
    const clean = (Array.isArray(faces) ? faces : []).slice(0, 12).filter((b) => Array.isArray(b) && b.length === 4 && b.every((v) => v >= 0 && v <= 1));
    const out = db.setFaces(photo.id, clean);
    if (clean.length && out) publishPhoto(out);
  } catch (e) {
    const n = (faceFails.get(photo.id) || 0) + 1;
    faceFails.set(photo.id, n);
    if (n >= 3) { db.setFaces(photo.id, []); faceFails.delete(photo.id); }
  } finally {
    faceRunning.delete(photo.id);
  }
}

// Retry loop for photos still pending (moderator was down, server restarted...), and faces not checked yet.
let timer, faceTimer;
export function startModeration() {
  const tick = () => { for (const p of db.pendingPhotos(10)) checkPhoto(p); };
  timer = setInterval(tick, 15000);
  timer.unref();
  setTimeout(tick, 2000).unref();
  faceTimer = setInterval(() => { if (config.moderatorUrl) for (const p of db.photosNeedingFaces(3)) findFaces(p); }, 2000);
  faceTimer.unref();
}
export const stopModeration = () => { clearInterval(timer); clearInterval(faceTimer); };
