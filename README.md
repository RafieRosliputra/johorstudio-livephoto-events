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


## Linked repo: JS Tether app

The Android app **[a7rii-android-push](https://github.com/RafieRosliputra/a7rii-android-push)** (branch `v4`) uses these routes: `/auth/code`, `/api/shoot` (+ `guestUrl`, `guestCode`), `/api/shoot/uploads`, `/api/uploads/*`, `/api/shoot/check`, `/api/shoot/photos*` (own photos list / thumbnail / delete), `/api/shoot/app` and `/api/shoot/app.apk` (in-app update; version is read from the APK file name `JSTether-vX.Y.Z.apk`). `/join/<code>` opens the app; `public/.well-known/assetlinks.json` must match the app's signing key (release.keystore SHA-256). Change one side, check the other.
