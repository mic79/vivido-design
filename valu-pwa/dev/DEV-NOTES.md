# Valu dev - notes

Run locally: `http://localhost:8080/dev/` (same `python -m http.server 8080` as the stable app).
Tests (nothing to install, Node 20+): from `dev/` run `node --test`.
Hardened auth worker: `cloudflare-worker-dev/` (`node --test` there as well). Dev talks to its own deployment, `valu-auth-dev`, with PKCE on; the stable worker `valu-auth` is never used by dev. Dev keeps its refresh token under `valu_dev_encrypted_refresh` (automatic while the version ends in `-dev`).

## What differs from stable (v196)
- All libraries and fonts are local in `vendor/` (Vue 3.5.44, GSAP 3.15.0 + plugins, Lato, Material Icons). Only Google's Picker scripts are still loaded from Google. `shake.js` replaced by `vendor/shake-lite.js`.
- Inline scripts moved to `boot.js` / `app.js`; version lives only in `version.js`.
- Assistant/FAQ text is HTML-escaped (`htmlSafe.js`); formula-looking text is neutralized before writing to Sheets; row IDs are verified before updating cached rows; polling pauses when the tab is hidden; crypto-random IDs; no debug `console.log`.
- "Open shared group" no longer adds a duplicate when you pick a sheet that is already listed (it updates the existing entry), and a newly added group gets its "Last modified" right away.
- v198-dev: Balance Overview shows plain numbers (no currency symbols); Add/Save/Delete buttons on Expenses, Income and Accounts show "Saving..." and ignore repeated taps; per-group option "Require a category" (Groups > group configuration, settings keys expenseCategoryRequired / incomeCategoryRequired); recurring/FX "last checked" stamps are now also updated in the app's own settings (they were only saved to the Sheet, so stale values re-suggested old months at the next app start).
- v199-dev: Expenses: when a category or search filter is active and it contains entries with "Sold" in the title, a "Hide sold" button appears; it hides those entries and the totals show only what was bought.
- v200-dev: FIX mixed-up accounts. Stable and dev share one origin (so one localStorage); only the refresh token was separate, so dev could show one account's email/cached groups while loading another account's data. While the version ends in `-dev`, `boot.js` now stores ALL dev keys under a `dev:` prefix (except `valu_theme`), so the two apps no longer share any session data. No effect after promotion. Also, on load the app now checks that the stored profile matches the account behind the token, and switches to the real account (dropping the other one's cached data) if not. You must sign in once on dev after this update.
- Sign-out clears cached chats/groups; Settings -> Privacy has "Sign out & forget this device" (revokes access at Google).
- Service worker: own `valu-dev-*` cache, offline boot, no forced reload on update, bounded cache.
- `_headers` (CSP is report-only), `.assetsignore`, manifest id/scope.

## To promote dev -> stable
1. In Google Cloud Console add the redirect URI `http://localhost:8080/dev/` while testing (not needed after promotion).
2. `version.js`: change the `-dev` version to the plain number (e.g. `'v199-dev'` -> `'v199'`; it must be higher than stable's current number so caches refresh).
3. `manifest.json`: set `"id"` to `"/index.html"` (keeps installed apps recognising it as the same app) and `name`/`short_name` back to `Valu`.
4. Copy `.assetsignore` to the root of whatever folder you deploy. `_headers` is optional: it only adds a report-only CSP (no protection until renamed); skip it unless you want to watch the console, then (if copied) watch the browser console for `Content-Security-Policy-Report-Only` messages; when clean, rename the header to `Content-Security-Policy`.
5. Auth worker: paste `cloudflare-worker-dev/src/index.js` into the EXISTING stable `valu-auth` worker (Cloudflare account that owns it) - its secrets stay as they are, so nobody is signed out - and add the new origins if any. Then in `googleAuth.js` set `WORKER_URL` back to `https://valu-auth.valu.workers.dev` (keep `USE_PKCE = true`), and add that URL to `connect-src` in `_headers`. The separate `valu-auth-dev` worker can then be deleted.
