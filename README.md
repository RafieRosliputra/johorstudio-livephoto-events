# JS Live Photo (live.johorstudio.com)

Galeri gambar live untuk event JohorStudio.com: jurugambar (app JS Tether / web) dan tetamu (web, kod 6 digit) upload, gambar muncul serta-merta di telefon tetamu dan di skrin besar (LED). Gambar tetamu ditapis AI dahulu.

| Folder | Isi |
|---|---|
| `server/` | Node 24, tanpa pakej npm: API, website (English), SSE live. `npm test` |
| `moderator/` | Python: AI tapis gambar tetamu (NSFW, politik, dokumen/teks, keganasan…), CPU di m10 |
| `deploy/` | TrueNAS: `install.sh` (dari Mac), `setup-tnas.sh`, `setup-m10.sh`, `update.sh`, `compose.yaml` |
| `docs/` | `HANDOFF.md` (status & keputusan), pelan asal v3 |

App Android **JS Tether** ada dalam repo berasingan `a7rii-android-push` (Releases: APK).

## Pasang / naik taraf
```bash
git clone https://github.com/RafieRosliputra/johorstudio-livephoto-events && cd johorstudio-livephoto-events
./deploy/install.sh          # tnas (NFS) + m10 (app livephoto + moderator), selamat diulang
./deploy/update.sh           # kemas kini kod sahaja
```
Admin: https://live.johorstudio.com/admin (Cloudflare Access). Organiser: /panel (kod organiser). Photographer: /shoot atau app.


## White-label tenants (ccam.my)

The same app and database serve every client brand: the brand is chosen from the request `Host`.

| Host | Result |
|---|---|
| `live.johorstudio.com` | platform + admin (`/admin`, Cloudflare Access) |
| `johorstudio.com`, `www.johorstudio.com` | platform brand |
| `ccam.my`, `www.ccam.my` | apex: `APEX_MODE=redirect` to `live.johorstudio.com` (or `app` to serve an apex brand) |
| `<slug>.ccam.my` | that organiser's brand (`organizers` table); unknown/off slug -> 404/503 page |
| a custom domain in `organizers.domain` | same brand |

- Brand = JSON on `organizers.brand`: name, logo, favicon, 11 colours, font, tagline, website, WhatsApp, disclaimer,
  hide-platform-links. Colours are validated hex; fonts and URLs are allow-listed (`src/tenant.js`).
- Server injects `:root` CSS variables + `window.__BRAND` into `<head>`; `public/js/brand.js` replaces the visible
  JohorStudio text/logo/contact links and appends the footer credit "Servis disediakan oleh JohorStudio.com".
- `/admin/organizers` (Access-protected) creates/edits/toggles organiser brands, uploads logos and can read a client
  website to suggest name/slogan/logo/fonts; brand colours are sampled from the **logo pixels** (PNG/SVG, zero-dep)
  because a site's CSS is usually framework boilerplate (`src/brandimport.js`).
- Events carry `organizer_id`; a tenant host only serves its own events (gallery, QR, download, uploads, sessions).
- Env: `ADMIN_HOST`, `PLATFORM_HOSTS`, `TENANT_ZONE`, `APEX_MODE`, `BRANDS_DIR`, `TENANT_DISCLAIMER`.
- Deploy: one wildcard DNS record + one tunnel public hostname (`*.ccam.my`) once; on/off is then a status switch in the admin.
- Docs in the ccam.my workspace: `docs/SIAP.md`, `docs/deploy-runbook.md`, `docs/CHANGES.md`.

## Linked repo: JS Tether app

The Android app **[a7rii-android-push](https://github.com/RafieRosliputra/a7rii-android-push)** (branch `v4`) uses these routes: `/auth/code`, `/api/shoot` (+ `guestUrl`, `guestCode`), `/api/shoot/uploads`, `/api/uploads/*`, `/api/shoot/check`, `/api/shoot/photos*` (own photos list / thumbnail / delete), `/api/shoot/app` and `/api/shoot/app.apk` (in-app update; version is read from the APK file name `JSTether-vX.Y.Z.apk`). `/join/<code>` opens the app; `public/.well-known/assetlinks.json` must match the app's signing key (release.keystore SHA-256). Change one side, check the other.
