// One box for the 6-digit event code, shown as "123 456". Paste and autofill work;
// on phones the numeric keypad opens. Same API as the old six-box version.
import { api } from './common.js';

export function codeBoxes(container, { value = '', onChange = () => {}, onComplete = () => {} } = {}) {
  container.classList.add('codewrap');
  container.innerHTML = '<input class="codeinput" type="text" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" placeholder="123 456" aria-label="6-digit code">';
  const box = container.querySelector('input');
  const digits = () => box.value.replace(/\D/g, '').slice(0, 6);
  const show = (d) => (d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d);
  let last = '';
  const changed = () => {
    const d = digits();
    if (box.value !== show(d)) box.value = show(d);
    container.classList.remove('bad');
    if (d === last) return;
    last = d;
    onChange(d);
    if (d.length === 6) onComplete(d);
  };
  box.addEventListener('input', changed);
  box.addEventListener('paste', () => setTimeout(changed, 0));
  box.addEventListener('focus', () => { const n = box.value.length; box.setSelectionRange(n, n); });
  const set = (s) => { box.value = show(String(s || '').replace(/\D/g, '').slice(0, 6)); changed(); };
  if (value) set(value);
  return {
    get: digits, set,
    focus: () => box.focus(),
    shake: () => { container.classList.remove('bad'); void container.offsetWidth; container.classList.add('bad'); },
    clear: () => { box.value = ''; last = ''; box.focus(); },
  };
}

/** Send a code; returns the server reply or throws an Error with .data (triesLeft...). */
export function sendCode(code, extra = {}) {
  return api('POST', '/auth/code', { code, ...extra });
}
