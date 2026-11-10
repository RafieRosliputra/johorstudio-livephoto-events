// All settings come from environment variables (set in the TrueNAS app / .env).
import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT || 8095),
  host: env.HOST || '0.0.0.0',
  publicUrl: (env.PUBLIC_URL || 'https://live.johorstudio.com').replace(/\/$/, ''),
  // m10: /mnt/ssd/livephoto/data  -> database, thumbnails
  dataDir: path.resolve(env.DATA_DIR || './data'),
  // tnas (NFS): /mnt/ssd/client-1month/livephoto  -> EVENTS/<folder>/...
  photosDir: path.resolve(env.PHOTOS_DIR || './photos'),
  // When 1, a missing marker file (.livephoto-storage) means "storage offline" (NFS not mounted).
  requireStorageMarker: env.REQUIRE_STORAGE_MARKER === '1',
  // Admins log in through Cloudflare Access (paths /admin and /api/admin on live.johorstudio.com).
  adminEmails: (env.ADMIN_EMAILS || 'rafierosliputra@gmail.com,johorstudio@gmail.com').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  accessTeam: (env.ACCESS_TEAM_DOMAIN || 'johorstudio.cloudflareaccess.com').replace(/^https?:\/\//, ''),
  accessAud: env.ACCESS_AUD || '',
  accessCertsUrl: env.ACCESS_CERTS_URL || '',          // tests only; default https://<team>/cdn-cgi/access/certs
  // Umami analytics (ana.johorstudio.com) on the public pages; empty = off
  umamiId: env.UMAMI_WEBSITE_ID || '',
  umamiSrc: env.UMAMI_SRC || 'https://ana.johorstudio.com/script.js',
  devAdmin: env.DEV_ADMIN || '',                         // dev only: treat every /api/admin request as this email
  // AI moderator for guest photos (separate Python app on m10). Empty = approve without AI.
  moderatorUrl: (env.MODERATOR_URL || '').replace(/\/$/, ''),
  liveHours: Number(env.LIVE_HOURS || 8),
  maxLiveEvents: 3,
  guestUploadsPerEvent: Number(env.GUEST_UPLOADS_PER_EVENT || 30),
  codeTries: 3,
  codeLockMin: 30,
  siteOrigins: (env.SITE_ORIGINS || 'https://johorstudio.com,https://www.johorstudio.com').split(','),
  cookieSecure: env.COOKIE_SECURE !== '0',
  scanIntervalSec: Number(env.SCAN_INTERVAL || 60),
  chunkBytes: 4 * 1024 * 1024,
  maxUploadBytes: Number(env.MAX_UPLOAD_MB || 80) * 1024 * 1024,
  maxGuestBytes: Number(env.MAX_GUEST_MB || 40) * 1024 * 1024,
  guestUploadsPerHour: Number(env.GUEST_UPLOADS_PER_HOUR || 300),
  // JS Tether APK: newest .apk in the app repo's GitHub Releases (public repo, no token).
  apkReleasesUrl: env.APK_RELEASES_URL ?? 'https://api.github.com/repos/RafieRosliputra/a7rii-android-push/releases?per_page=10',
  whatsapp: env.WHATSAPP || '60127983745',
  contactUrl: env.CONTACT_URL || 'https://johorstudio.com/#contact',

  // ---------------- white-label (ccam.my) ----------------
  // Admin UI + Cloudflare Access live on this host only; tenant hosts never serve /admin.
  adminHost: (env.ADMIN_HOST || 'live.johorstudio.com').toLowerCase(),
  // Extra hosts that get the original JohorStudio branding (the studio website links here).
  platformHosts: (env.PLATFORM_HOSTS || 'johorstudio.com,www.johorstudio.com')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  // Tenants are <slug>.<tenantZone> (e.g. passion.ccam.my). Wildcard DNS + tunnel hostname point here.
  tenantZone: (env.TENANT_ZONE || 'ccam.my').toLowerCase(),
  // Apex behaviour: 'redirect' sends ccam.my/* to publicUrl/*; 'app' serves the apex brand (brand:apex).
  apexMode: env.APEX_MODE === 'app' ? 'app' : 'redirect',
  // Brand logos uploaded from the admin UI (kept outside git, next to the database).
  brandsDir: path.resolve(env.BRANDS_DIR || path.join(env.DATA_DIR || './data', 'brands')),
  // Footer credit shown at the bottom of every tenant page ('{brand}' = tenant name).
  tenantDisclaimer: env.TENANT_DISCLAIMER || 'Servis disediakan oleh JohorStudio.com',
};

export const EVENTS_DIR = () => path.join(config.photosDir, 'EVENTS');
export const PUBLIC_UPLOAD = 'public upload';
export const META_FILE = '.livephoto.json';
export const STORAGE_MARKER = '.livephoto-storage';
export const slotFolder = (n) => `Photographer ${n}`;
