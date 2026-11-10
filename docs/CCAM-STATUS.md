# Implementation status — white-label `ccam.my` (final, code-complete)

> 2026-11-10 · deepseek · branch `ccam-tenants` · `npm test` = **45/45**
> This is the reconciliation between the design (`docs/spec-tenant.md`, written mid-flight) and what is
> actually implemented+tested. Where they differ, this file is the truth. Nothing here is deployed.

## 1. Objective vs delivered

| Objective item | Status | Where |
|---|---|---|
| `ccam.my` → same app as `live.johorstudio.com` | **done** in code: apex is a host of the same process; `APEX_MODE=redirect` sends page requests to `live.johorstudio.com`, API/assets pass through. Not yet routed in Cloudflare. | `server/src/tenant.js` guard, `docs/infra-routing.md` |
| Client subdomain with own branding (e.g. `passion.ccam.my`) | **done**: `organizers` row per client, brand JSON, host resolution, server-side injection | `server/src/tenant.js`, `server/src/db.js` |
| Branding pulled from the client's website (logo/colour/name) | **done + verified live**: JSON-LD name/slogan, logo download, PNG/SVG logo-pixel colours, font, event photos | `server/src/brandimport.js`, `test/brandimport.test.js` |
| Admin "EVENT ORGANIZER" on live.johorstudio.com: create/edit/on-off/deploy | **done**: `/admin/organizers` (Access-protected), status switch = deploy | `server/public/organizers.html`, `server/src/api.js` |
| Footer disclaimer "Servis disediakan oleh JohorStudio.com" | **done**: appended to every tenant footer; platform footer untouched | `server/public/js/brand.js`, `config.tenantDisclaimer` |
| Spec | **done** | `docs/spec-tenant.md` + this file |
| Code + passing tests | **done** | 45/45, branch pushed |
| Deploy runbook | **done** | `docs/deploy-runbook.md` |
| Do not touch production without Rafi | **respected**: `live.johorstudio.com` unchanged (200, 29,825 B), m10 still `d94092f` | — |

## 2. Spec section → final implementation

| Spec | Implemented as | Tests |
|---|---|---|
| §2.1 host matrix | `resolveHost`: admin/platform/apex/tenant/unknown; fail-closed only inside the tenant zone | `tenant.test.js` host matrix |
| §2.2 `organizers` table + additive migration | `CREATE TABLE IF NOT EXISTS organizers`, `events.organizer_id` via try/catch `ALTER`; `SCHEMA_VERSION` stays 2 | CRUD + ownership tests |
| §2.3 brand JSON | 27 fields, validated by `cleanBrand` (hex, font, https/local paths, 5-image list); derived dark/light/soft colours | colour + brand tests |
| §2.4 event ownership + scoping | `eventVisibleOnHost` applied to gallery, QR/code login, photos, SSE, download zip, uploads, `me`, shoot, client panel, live-status, showcase; 404/401 across tenants | "an event only shows on its owner tenant host" |
| §2.5 injection pipeline | `:root` CSS vars, `window.__BRAND`, `/js/brand.js`, title/meta per host, favicon, `data-tenant`; `no-cache` + `Vary: Host`, no HTML ETag | branded HTML test |
| §2.6 admin lock | `/admin`, `/organizers`, `/admin/organizers`, `/api/admin` only on admin host; raw `*.html` files redirected | "admin paths are blocked on tenant hosts" |
| §2.7 per-request `publicBase()` | `AsyncLocalStorage` request context; QR/share/download/WhatsApp links follow the visited host | contact + brand tests |
| §2.8 disabled/404 | off tenant = 503 page (noindex), unknown subdomain = 404 page; static assets still load | draft/off/unknown tests |
| §3 brand leaks | `brand.js` replaces text case-insensitively, hides platform links, removes the JohorStudio mosaic, hides platform footer lines, adds the credit; tenant `live-status`/`showcase` scoped | screenshots + exceptions=0 |
| §4 admin UI | `organizers.html`: list/create/edit/on-off/delete, logo upload+URL, website import with candidate picking, colours with reset, live preview, platform-brand tabs | CDP UI smoke (0 console errors) |
| §5 tests | 45 tests across `api.test.js`, `tenant.test.js`, `brandimport.test.js` | `npm test` |
| §6 import | JSON-LD name/slogan, logo ranking, **server-side PNG/SVG pixel sampling**, vendor-colour + icon-font filters, WCAG contrast pick, event-photo candidates | `brandimport.test.js`, live run on passion site |

## 3. Deviations from the mid-flight spec (intentional)

1. **UI path is `/admin/organizers`, not `/organizers`** — Cloudflare Access only covers `/admin` and
   `/api/admin`; putting the page under `/admin` means the existing Access app protects it without a second app.
   `/organizers`, `/admin.html`, `/organizers.html`, `/panel.html` redirect to the clean, protected URLs.
2. **Hero images are a brand field** (`brand.heroImages`, max 5) — spec did not define them. `/data/hero.json` is
   answered per tenant host, so the landing page needed no template change.
3. **Logo colours are sampled server-side** (PNG via zlib + SVG fills) instead of the spec's browser-canvas idea:
   no CORS, no client dependency, and it is what makes "Read website" return the real brand instead of Bootstrap defaults.
4. **Fail-closed is scoped to `*.ccam.my`**. Other unknown hosts (localhost, `127.0.0.1`, IPs, SSH-tunnelled hosts)
   keep the platform brand so dev/health checks work; any unregistered `*.ccam.my` is 404. Admin API still requires Access.
5. **`events.organizer_id`** was added (spec proposed it; it is now required for tenant isolation). Empty = JohorStudio/p.
   Admin can create an event for a client or move an existing one.
6. **Tenant contact details** (`whatsapp`, `contactUrl`, `website`) are returned by `/auth/config` and `/api/e/:token`,
   so the gallery/landing contact links belong to the client, not the platform.
7. **Analytics**: Umami `data-domains` is set to the request host (aggregate remains one website id; per-tenant IDs are future work).
8. **Import apply is fill-only**: it never overwrites fields the admin already set (name, colours, logo, font, tagline,
   hero images). Admin edits win.

## 4. Evidence to reproduce

```bash
cd app/server && npm test                 # 45/45
node ../../demo/verify.sh                 # live HTTP checks against a throwaway demo instance
node ../../demo/ui-smoke.mjs              # browser: /admin/organizers edit + real website import (needs demo on :8199)
```

Recorded evidence:
- `demo/shots/passion-home.png` — tenant landing with Passion logo/colours/font and 5 of Passion's own event photos.
- `demo/shots/passion-gallery.png` — tenant gallery: branded header, magenta upload button, footer credit.
- `demo/shots/admin-organizers.png`, `admin-organizer-edit.png`, `admin-events.png` — admin module, editor, client badge.
- Import run on `https://passion-sound-event.com/`: name `Passion Sound and Event`, tagline `Event Planner JB & KL`,
  primary `#872983` (7.85:1), accent `#f5ba22`, font Raleway, 8 event-photo candidates, logo downloaded — 0.9 s.
- Browser checks: 0 JS exceptions on tenant and platform landing pages; `#yr`, `#organiserLink`, gallery WhatsApp link intact.

## 5. Production state (deployed 2026-11-10 19:33)

Done directly by DeepSeek after Rafi's go-ahead:

1. **Tunnel** `m10`: public hostnames `ccam.my` + `*.ccam.my` → `HTTP 192.168.0.100:8095` (config version 54, 25 ingress,
   every old route untouched, backup in the workspace `demo/cf-backup/`).
2. **DNS** zone `ccam.my`: placeholder `A 192.0.2.1` records at `@` and `www` deleted; `CNAME @`, `CNAME www`,
   `CNAME *` → `5d1680e1-a30b-4010-9d52-eeae3c7abac9.cfargotunnel.com`, proxied.
3. **Worker routes** `ccam.my/*` and `www.ccam.my/*` (script `ccam-under-construction`) removed — they were the
   "Under Construction" page. Script itself still exists (unused) and can be deleted later.
4. **Always Use HTTPS** ON for the zone (http → 301 https verified).
5. **App deployed** to m10 (`livephoto`, commit `4620982`), and `main` fast-forwarded to it so the default
   `deploy/update.sh` cannot roll tenancy back.
6. **First tenant live**: organizer `passion` (id `3de0e8d2-1327-4adc-a61b-b37c256d2fe6`), status `live`,
   brand kit applied (colours, Raleway, 3 logos downloaded, 5 hero photos).

Verified from outside: `https://ccam.my/` → 302 to `live.johorstudio.com`; `https://passion.ccam.my/` → 200 branded
(31,885 B, title "Passion Sound & Event Live", `--teal:#c50a76`, logo 200, `/data/hero.json` 5 client photos);
`passion.ccam.my/admin` → 302 to the Access-protected admin; `live.johorstudio.com` 200 unchanged.

Remaining for Rafi:
1. Create the client's events in `/admin` and pick **Client = Passion Sound & Event** (gallery/QR only opens on that domain).
2. Confirm the three ASSUME in `docs/SIAP.md` §5 (apex redirect, BM disclaimer, AA colours) — editable in the admin.
3. Optional: delete the unused `ccam-under-construction` Worker; phase 2 (themed illustrations, per-tenant Umami, import rate limit).
