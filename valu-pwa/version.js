/**
 * Single source of truth for the app version.
 * Loaded as a classic script by index.html (window.VALU_VERSION) and by the service worker
 * (importScripts). Bump this ONE value on every deploy: it renames the cache and updates the
 * "What's new" label in the side menu.
 *
 * (The /dev copy uses a "-dev" suffix so its caches never collide with the stable app's caches.)
 */
(function (root) {
  root.VALU_VERSION = 'v201';
})(typeof self !== 'undefined' ? self : this);
