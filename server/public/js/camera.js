// Take a photo with the phone camera from the web page, then confirm (✓ upload / ✗ discard).
// Used by the guest gallery and the admin / organiser panel.

let css = false;
function addCss() {
  if (css) return;
  css = true;
  const s = document.createElement('style');
  s.textContent = `
  .shot { position: fixed; inset: 0; z-index: 80; background: #0b0f10; display: flex; flex-direction: column; }
  .shot .pic { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .shot img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
  .shot .ask { color: #e8eeee; text-align: center; font: 600 16px Archivo, system-ui, sans-serif; padding: 0 16px; }
  .shot .acts { display: flex; justify-content: center; gap: 56px; padding: 18px 16px max(26px, env(safe-area-inset-bottom, 0px)); }
  .shot .acts button { width: 76px; height: 76px; border-radius: 50%; border: 0; display: grid; place-items: center; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
  .shot .acts button svg { width: 38px; height: 38px; }
  .shot .no { background: #d6453d; } .shot .yes { background: #2e9d6a; }
  .shot .acts span { display: block; color: #c9d3d2; font: 600 13px Archivo, system-ui, sans-serif; text-align: center; margin-top: 8px; }
  .shot .acts button:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }`;
  document.head.appendChild(s);
}

const X = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
export const cameraIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

/** Opens the camera (rear camera on phones; a file picker on computers). Resolves with the photo, or null. */
export function takePhoto() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.setAttribute('capture', 'environment');
    inp.style.display = 'none';
    inp.onchange = () => { resolve(inp.files[0] || null); inp.remove(); };
    inp.oncancel = () => { resolve(null); inp.remove(); };
    document.body.appendChild(inp);
    inp.click();
  });
}

/** Full-screen preview of the photo: ✓ = upload, ✗ = discard. Resolves true / false. */
export function confirmShot(file, question = 'Upload this photo?') {
  addCss();
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('div');
    el.className = 'shot';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', question);
    el.innerHTML = `<div class="pic"><img alt="Photo you just took"></div><div class="ask"></div>
      <div class="acts"><div><button class="no" type="button" aria-label="Discard">${X}</button><span>Discard</span></div>
      <div><button class="yes" type="button" aria-label="Upload">${TICK}</button><span>Upload</span></div></div>`;
    el.querySelector('img').src = url;
    el.querySelector('.ask').textContent = question;
    const done = (v) => { URL.revokeObjectURL(url); el.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    el.querySelector('.no').onclick = () => done(false);
    el.querySelector('.yes').onclick = () => done(true);
    document.addEventListener('keydown', key);
    document.body.appendChild(el);
    el.querySelector('.yes').focus();
  });
}
