m: p
k: p
r: /Users/johorstudio/Desktop/ai/claude/projects/johorstudio-livephoto-events
c: ~/Desktop/ai/boot.md, server/src/apk.js, server/src/api.js, server/src/config.js, server/src/http.js, server/public/admin.html, server/test/api.test.js
o: server/src/apk.js, server/src/api.js, server/public/admin.html, server/test/api.test.js
t: cd server && npm test
## I
- boot: read ~/Desktop/ai/boot.md first, print BOOT proof line. reply BM, DeepSeek, user Rafi.
- feature: ADMIN RELINK APK. admin (not photographer) controls where JS Tether APK served at /api/shoot/app.apk + /api/admin/app.apk comes from. today: auto-sync newest .apk from config.apkReleasesUrl (GitHub Releases).
- source modes, persisted in dataDir/app/apk-source.json {mode,url,updatedAt}: 
  a) default = env/config.apkReleasesUrl (unchanged behaviour)
  b) custom URL: either GitHub releases API URL (existing logic) or GitHub repo URL https://github.com/<o>/<r> (convert to api releases url) or direct https URL ending .apk (download once; validate PK zip magic like existing).
  c) manual upload: admin uploads .apk file; saved as active file; auto-sync must NOT overwrite it while mode=upload.
- apk.js: refreshApk reads source file; keep existing validation (PK magic, size>1000), atomic write, old file cleanup, apk.json meta. add exported setSource(obj), getSource(), saveUploadedApk(buf, filename). meta gets `source` field (default|url|upload).
- api.js admin routes (A(...) helper, admin-only like existing /app): GET /app returns {apk, source}; PUT /app/source {mode:'default'|'url', url?} validates https only, no localhost/private IP (SSRF), then refreshApk and return result; POST /app/upload raw body (readBody, max 100MB) header x-filename, must end .apk and start with PK, sets mode=upload. keep /app/refresh working. photographer routes unchanged.
- admin.html: in apk card add small section: current source line; text input URL + "Pautkan" button (set URL); "Reset default" button; file input "Upload APK" with progress/toast. English UI like rest of admin page. no new libs.
- no change to photographer flow, no deploy, no commit, no .env edits.
- tests: extend test/api.test.js: set source url -> mock server asset served; reject http://127.0.0.1 and non-https; upload non-PK rejected; upload valid PK ok and survives refresh; reset default restores. existing tests keep passing.
## A
1 default behaviour unchanged when no apk-source.json
2 PUT /api/admin/app/source accepts github repo URL, releases api URL, direct https .apk; rejects http/private/local
3 POST /api/admin/app/upload stores valid .apk, rejects non-APK, mode=upload not overwritten by sync
4 reset to default works
5 admin only (401/403 for photographer + anonymous)
6 admin.html shows source, URL input, reset, upload
7 npm test passes
