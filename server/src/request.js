// Async request context: lets API helpers build absolute links on the host the visitor used
// (live.johorstudio.com vs passion.ccam.my) without threading `req` through every function.
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.js';

export const store = new AsyncLocalStorage();

export function currentReq() { return store.getStore()?.req; }
export function currentTenant() { return store.getStore()?.tenant; }

/** Public origin for this request, e.g. https://passion.ccam.my or https://live.johorstudio.com. */
export function publicBase() {
  const t = currentTenant();
  return (t && t.baseUrl) || config.publicUrl;
}
