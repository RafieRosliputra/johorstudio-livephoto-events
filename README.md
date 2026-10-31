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
