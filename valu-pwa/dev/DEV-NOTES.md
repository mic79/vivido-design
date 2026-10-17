# Valu dev - notes

Run locally: `http://localhost:8080/dev/` (same `python -m http.server 8080` as the stable app).
Tests (nothing to install, Node 20+): from `dev/` run `node --test`.
Hardened auth worker: `cloudflare-worker-dev/` (`node --test` there as well). Dev talks to its own deployment, `valu-auth-dev`, with PKCE on; the stable worker `valu-auth` is never used by dev. Dev keeps its refresh token under `valu_dev_encrypted_refresh` (automatic while the version ends in `-dev`).

## What differs from stable (v196)
- All libraries and fonts are local in `vendor/` (Vue 3.5.44, GSAP 3.15.0 + plugins, Lato, Material Icons). Only Google's Picker scripts are still loaded from Google. `shake.js` replaced by `vendor/shake-lite.js`.
- Inline scripts moved to `boot.js` / `app.js`; version lives only in `version.js`.
- Assistant/FAQ text is HTML-escaped (`htmlSafe.js`); formula-looking text is neutralized before writing to Sheets; row IDs are verified before updating cached rows; polling pauses when the tab is hidden; crypto-random IDs; no debug `console.log`.
- "Open shared group" no longer adds a duplicate when you pick a sheet that is already listed (it updates the existing entry), and a newly added group gets its "Last modified" right away.
- Sign-out clears cached chats/groups; Settings -> Privacy has "Sign out & forget this device" (revokes access at Google).
- Service worker: own `valu-dev-*` cache, offline boot, no forced reload on update, bounded cache.
- `_headers` (CSP is report-only), `.assetsignore`, manifest id/scope.

## To promote dev -> stable
1. In Google Cloud Console add the redirect URI `http://localhost:8080/dev/` while testing (not needed after promotion).
2. `version.js`: change `'v197-dev'` to the plain number (e.g. `'v197'`).
3. `manifest.json`: set `"id"` to `"/index.html"` (keeps installed apps recognising it as the same app) and `name`/`short_name` back to `Valu`.
4. Copy `_headers` and `.assetsignore` to the root of whatever folder you deploy. Watch the browser console for `Content-Security-Policy-Report-Only` messages; when clean, rename the header to `Content-Security-Policy`.
5. Auth worker: paste `cloudflare-worker-dev/src/index.js` into the EXISTING stable `valu-auth` worker (Cloudflare account that owns it) - its secrets stay as they are, so nobody is signed out - and add the new origins if any. Then in `googleAuth.js` set `WORKER_URL` back to `https://valu-auth.valu.workers.dev` (keep `USE_PKCE = true`), and add that URL to `connect-src` in `_headers`. The separate `valu-auth-dev` worker can then be deleted.
