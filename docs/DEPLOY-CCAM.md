# Deploy runbook · ccam.my white-label

> English, dense. Executed against production on 2026-11-10 19:33 (see `docs/CCAM-STATUS.md` §5 for the exact state).
> Keep this for future tenants/deploys and rollback.
> Repo: `johorstudio-livephoto-events` · branch with the work: `ccam-tenants` (based on `205ea6d`).
> App: TrueNAS custom app `livephoto` on m10 (`/mnt/ssd/livephoto/app`, port 8095), behind cloudflared tunnel.

## 0. Pre-flight (must pass before touching m10)

```bash
cd app/server && npm test          # 45/45 pass
node ../demo/verify.sh             # live HTTP checks (hosts, branding, hero photos, admin gate)
git status --short                 # only expected files
```

Backup the production DB + brand dir first (m10):

```bash
ssh -i ~/.ssh/truenas_claude truenas_admin@100.101.43.120 \
  'sudo cp /mnt/ssd/livephoto/data/livephoto.db /mnt/ssd/livephoto/data/livephoto.db.bak-$(date +%Y%m%d-%H%M) && ls -la /mnt/ssd/livephoto/data'
```

## 1. Ship the code

```bash
# from the Mac, in app/
git push -u origin ccam-tenants

# on m10: pull the branch, rebuild/redeploy the app
HOST=truenas_admin@100.101.43.120 BRANCH=ccam-tenants ./deploy/update.sh
```

`update.sh` checks out `origin/<BRANCH>` into `/mnt/ssd/livephoto/app` and runs
`midclt call -j app.redeploy livephoto`, then waits for `/auth/config` to answer.

Verify the app came up (no tunnel changes yet, so only via LAN):

```bash
ssh -i ~/.ssh/truenas_claude truenas_admin@100.101.43.120 \
  'curl -s -m3 http://127.0.0.1:8095/ | head -c 120; echo; midclt call app.query | grep -o "\"name\": \"livephoto\""'
```

## 2. Add the tunnel hostnames (Cloudflare dashboard — one time)

Zero Trust → Networks → Tunnels → the m10 tunnel (`5d1680e1-a30b-4010-9d52-eeae3c7abac9`) → Public Hostnames:

| Subdomain | Domain | Service type | URL |
|---|---|---|---|
| *(empty)* | `ccam.my` | HTTP | `192.168.0.100:8095` |
| `*` | `ccam.my` | HTTP | `192.168.0.100:8095` |

- Leave **Host Header** empty: cloudflared forwards the original `Host`, the app picks the tenant from it.
- Delete any leftover A/AAAA records for `ccam.my` / `www.ccam.my` first (tunnel wants CNAMEs).
- Do **not** attach Access to these routes: guests must open their gallery without a login.
- SSL/TLS → Edge Certificates → **Always Use HTTPS: ON** (Universal SSL already covers `*.ccam.my`, one level).

If the Cloudflare API token is available instead of the dashboard (needs `Zone:DNS:Edit`, `Account:Cloudflare Tunnel:Edit`),
read the **whole** tunnel config first and merge — `PUT /accounts/{id}/cfd_tunnel/{tunnel}/configurations` replaces every ingress rule:

```bash
# read (never blind-PUT)
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/cfd_tunnel/$TUNNEL/configurations" | jq .
```

## 3. Verify routing (from any machine)

```bash
dig +short passion.ccam.my            # should return Cloudflare IPs (proxied)
curl -sI https://ccam.my/ | head -1   # 302 -> https://live.johorstudio.com/ (APEX_MODE=redirect)
curl -sI https://passion.ccam.my/ | head -1  # 404 page until the organiser is switched on (or 200 when live)
curl -s https://ccam.my/cdn-cgi/trace | head -3
```

TLS check for the wildcard:

```bash
openssl s_client -connect passion.ccam.my:443 -servername passion.ccam.my </dev/null 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName
```

## 4. Create the first tenant (admin)

1. Open `https://live.johorstudio.com/admin/organizers` (Cloudflare Access login).
2. `+ New event organizer` → Company name + subdomain slug (`passion`).
3. `Read website` → `https://passion-sound-event.com/` → pick name/logo/colours → *Apply*.
   The measured Passion brand is already in `brands/passion/` (logo-primary white lockup for the dark header,
   logo-horizontal for light surfaces, palette `#c50a76 / #8f288c / #ffc012 / #cc4a10`, font Raleway).
4. Upload the logo(s) (≤4 MB, PNG/JPEG/WebP/SVG/GIF/ICO), set colours/font/WhatsApp/disclaimer.
5. `Deploy (go live)` → status `live`. Open `https://passion.ccam.my`.
6. Create the client's event in `/admin` with **Client = Passion Sound & Event** so its gallery/QR only opens on
   `passion.ccam.my` (platform events stay on `live.johorstudio.com`).

## 5. Rollback

```bash
ssh -i ~/.ssh/truenas_claude truenas_admin@100.101.43.120 \
  'cd /mnt/ssd/livephoto/app && git checkout -f main && midclt call -j app.redeploy livephoto'
```

- Old code ignores `organizer_id` / `organizers` (additive columns/tables stay; harmless).
- Tunnel hostnames can stay: with the old code `ccam.my` would serve the JohorStudio app (no tenant branding).
  Remove the two public hostnames if ccam.my must go dark.
- DB restore (only if a migration misbehaves — it should not, schema version stays 2):
  `cp livephoto.db.bak-* livephoto.db` then redeploy.

## 6. Env on m10 (already in `deploy/compose.yaml`)

```
ADMIN_HOST=live.johorstudio.com
PLATFORM_HOSTS=johorstudio.com,www.johorstudio.com
TENANT_ZONE=ccam.my
APEX_MODE=redirect          # or 'app' to serve the ccam.my apex brand
BRANDS_DIR=/data/brands
TENANT_DISCLAIMER=Servis disediakan oleh JohorStudio.com
```

Ad-hoc tests without the tunnel (m10 LAN / SSH port-forward):

```bash
curl -s -H 'Host: passion.ccam.my' http://127.0.0.1:8095/api/brand | jq '.name, .kind'
curl -s -H 'Host: passion.ccam.my' http://127.0.0.1:8095/ | grep -o 'data-tenant="[^"]*"'
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: passion.ccam.my' http://127.0.0.1:8095/admin   # 302 to admin host
```
