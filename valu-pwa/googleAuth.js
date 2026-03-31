/**
 * Google OAuth2 — Authorization Code Flow with Cloudflare Worker.
 *
 * Uses the standard OAuth2 authorization code flow with a Cloudflare Worker
 * for the server-side token exchange, enabling long-lived refresh tokens
 * for seamless, persistent authentication.
 *
 * Sign-in flow (one-time):
 *  1. User clicks "Sign in" → redirect to Google consent screen
 *  2. Google redirects back with ?code=...
 *  3. Code sent to Worker → returns access token + encrypted refresh token
 *  4. Encrypted refresh token stored in localStorage
 *
 * Subsequent visits (seamless):
 *  1. Page loads → finds encrypted refresh token in localStorage
 *  2. Calls Worker /auth/refresh → gets fresh access token
 *  3. User is signed in with zero interaction
 */

// ── Configuration ─────────────────────────────────────────────────────────────
// Update WORKER_URL after deploying the Cloudflare Worker.

const CLIENT_ID   = '399400088485-h2nrjmo500qj4s7qrvfaog2tsqet3huo.apps.googleusercontent.com';
const API_KEY     = 'AIzaSyBdC9q6tLx1vLOFyUF-8Jeuy4gpuTYiaPs';
const SCOPES      = 'https://www.googleapis.com/auth/drive.file openid email profile';
const WORKER_URL  = 'https://valu-auth.valu.workers.dev';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

let accessToken    = null;
let userProfile    = null;
let _onAuthChange  = null;
let _pendingRefresh = null;
let _refreshTimer  = null;
let _signedOut     = false;

// ── Storage helpers ───────────────────────────────────────────────────────────

function persistSession(profile) {
  if (profile) {
    localStorage.setItem('valu_user_email', profile.email);
    localStorage.setItem('valu_user_name', profile.name);
    localStorage.setItem('valu_user_picture', profile.picture || '');
    localStorage.setItem('valu_credential', JSON.stringify(profile));
  } else {
    localStorage.removeItem('valu_user_email');
    localStorage.removeItem('valu_user_name');
    localStorage.removeItem('valu_user_picture');
    localStorage.removeItem('valu_credential');
    localStorage.removeItem('valu_last_group');
    localStorage.removeItem('valu_last_group_name');
  }
}

function getStoredProfile() {
  try {
    return JSON.parse(localStorage.getItem('valu_credential'));
  } catch {
    return null;
  }
}

function cacheToken(token, expiresIn) {
  localStorage.setItem('valu_access_token', token);
  localStorage.setItem('valu_token_expiry', String(Date.now() + ((expiresIn || 3600) * 1000)));
}

function getCachedToken() {
  const token = localStorage.getItem('valu_access_token');
  const expiry = parseInt(localStorage.getItem('valu_token_expiry') || '0', 10);
  if (token && Date.now() < expiry - 60000) {
    return token;
  }
  return null;
}

function clearAllTokens() {
  localStorage.removeItem('valu_access_token');
  localStorage.removeItem('valu_token_expiry');
  localStorage.removeItem('valu_encrypted_refresh');
  // Clean up old sessionStorage keys from previous auth implementation
  sessionStorage.removeItem('valu_access_token');
  sessionStorage.removeItem('valu_token_expiry');
}

function getRedirectUri() {
  let path = window.location.pathname;
  path = path.replace(/\/index\.html$/, '/');
  if (path === '/') return window.location.origin;
  return window.location.origin + path;
}

async function fetchUserInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Failed to fetch user info');
  const data = await res.json();
  return {
    email: data.email,
    name: data.name,
    picture: data.picture || '',
    sub: data.sub,
  };
}

// ── Worker communication ──────────────────────────────────────────────────────

async function exchangeCodeForTokens(code) {
  const redirectUri = getRedirectUri();
  console.log('Token exchange — redirect_uri:', redirectUri);
  const res = await fetch(`${WORKER_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  if (!res.ok) {
    let msg = `Token exchange failed (${res.status})`;
    try { const d = await res.json(); msg = d.error_description || d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data;
}

async function refreshViaWorker(encryptedRefreshToken) {
  const res = await fetch(`${WORKER_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_refresh_token: encryptedRefreshToken }),
  });
  if (!res.ok) {
    let msg = `Token refresh failed (${res.status})`;
    try { const d = await res.json(); msg = d.error || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data;
}

// ── Proactive refresh ─────────────────────────────────────────────────────────

function scheduleRefresh(expiresIn) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  const refreshMs = Math.max((expiresIn - 300) * 1000, 60000);
  _refreshTimer = setTimeout(() => silentRefresh(), refreshMs);
}

async function silentRefresh() {
  const encryptedRefresh = localStorage.getItem('valu_encrypted_refresh');
  if (!encryptedRefresh) return;

  try {
    const result = await refreshViaWorker(encryptedRefresh);
    if (_signedOut) return;
    accessToken = result.access_token;
    cacheToken(result.access_token, result.expires_in);
    scheduleRefresh(result.expires_in);
  } catch (err) {
    console.warn('Silent token refresh failed:', err.message);
    if (!_signedOut) accessToken = null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const GoogleAuth = {

  get accessToken() { return accessToken; },
  get userProfile() { return userProfile; },
  get isSignedIn() { return !!userProfile; },

  /**
   * Initialize auth. Called once on app startup.
   * Handles OAuth callback if ?code= is in the URL.
   * Otherwise restores session from localStorage and refreshes token silently.
   */
  async init(onAuthChange) {
    _onAuthChange = onAuthChange;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (code) {
      window.history.replaceState({}, '', window.location.pathname);

      const savedState = localStorage.getItem('valu_oauth_state');
      localStorage.removeItem('valu_oauth_state');

      if (!state || !savedState || state !== savedState) {
        console.error('OAuth state mismatch — possible CSRF');
        onAuthChange(false, null);
        return;
      }

      try {
        const result = await exchangeCodeForTokens(code);
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        localStorage.setItem('valu_encrypted_refresh', result.encrypted_refresh_token);

        const profile = await fetchUserInfo(accessToken);
        userProfile = profile;
        persistSession(profile);

        scheduleRefresh(result.expires_in);
        onAuthChange(true, userProfile);
      } catch (err) {
        console.error('OAuth callback failed:', err);
        onAuthChange(false, null);
      }
      return;
    }

    // Normal page load — restore session
    const storedProfile = getStoredProfile();
    const encryptedRefresh = localStorage.getItem('valu_encrypted_refresh');

    if (storedProfile && encryptedRefresh) {
      userProfile = storedProfile;

      const cached = getCachedToken();
      if (cached) {
        accessToken = cached;
        const expiry = parseInt(localStorage.getItem('valu_token_expiry') || '0', 10);
        const remaining = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
        scheduleRefresh(remaining);
        onAuthChange(true, userProfile);
        return;
      }

      onAuthChange(true, userProfile);

      try {
        const result = await refreshViaWorker(encryptedRefresh);
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        scheduleRefresh(result.expires_in);
      } catch (err) {
        console.warn('Background token refresh failed:', err.message);
        accessToken = null;
      }
      return;
    }

    onAuthChange(false, null);
  },

  /**
   * Start the sign-in flow. Redirects the browser to Google's consent screen.
   * Must be called from a user gesture (button click).
   */
  connect() {
    _signedOut = false;
    const state = crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('valu_oauth_state', state);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: getRedirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    window.location.href = `${GOOGLE_AUTH_URL}?${params}`;
  },

  /**
   * Get a valid access token. Refreshes via Worker if expired.
   * Throws 'refresh_failed' if unable to get a token (triggers reconnect UI).
   */
  async getAccessToken() {
    if (accessToken) {
      const expiry = parseInt(localStorage.getItem('valu_token_expiry') || '0', 10);
      if (Date.now() < expiry - 60000) {
        return accessToken;
      }
      accessToken = null;
    }

    const cached = getCachedToken();
    if (cached) {
      accessToken = cached;
      return cached;
    }

    const encryptedRefresh = localStorage.getItem('valu_encrypted_refresh');
    if (!encryptedRefresh) {
      throw new Error('Not signed in');
    }

    if (_pendingRefresh) return _pendingRefresh;

    _pendingRefresh = refreshViaWorker(encryptedRefresh)
      .then(result => {
        _pendingRefresh = null;
        if (_signedOut) return null;
        accessToken = result.access_token;
        cacheToken(result.access_token, result.expires_in);
        scheduleRefresh(result.expires_in);
        return accessToken;
      })
      .catch(err => {
        _pendingRefresh = null;
        if (!_signedOut) accessToken = null;
        throw new Error('refresh_failed');
      });

    return _pendingRefresh;
  },

  /**
   * Called by sheetsApi on 401 responses. Clears current token and retries.
   */
  handleAuthFailure() {
    accessToken = null;
    localStorage.removeItem('valu_access_token');
    localStorage.removeItem('valu_token_expiry');
    return this.getAccessToken();
  },

  /**
   * Sign out and revoke the access token.
   */
  signOut() {
    _signedOut = true;
    if (accessToken) {
      fetch(`${GOOGLE_REVOKE_URL}?token=${accessToken}`, { method: 'POST' }).catch(() => {});
    }
    accessToken = null;
    userProfile = null;
    _pendingRefresh = null;
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = null;
    persistSession(null);
    clearAllTokens();
    if (_onAuthChange) _onAuthChange(false, null);
  },

  /**
   * Show the Google Picker to select a Valu spreadsheet.
   */
  async showPicker(query = 'Valu:') {
    const token = await this.getAccessToken();

    if (typeof google === 'undefined' || !google.picker || !google.picker.PickerBuilder) {
      await new Promise((res, rej) => {
        if (typeof gapi !== 'undefined') {
          gapi.load('picker', { callback: res, onerror: rej });
        } else {
          rej(new Error('Google API loader not available'));
        }
      });
    }

    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(true)
        .setMimeTypes('application/vnd.google-apps.spreadsheet')
        .setQuery(query);

      new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .setTitle('Select a Valu group spreadsheet')
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs && data.docs[0];
            if (doc) {
              resolve({ id: doc.id, name: doc.name });
            } else {
              resolve(null);
            }
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          } else if (data.action === 'error') {
            resolve(null);
          }
        })
        .build()
        .setVisible(true);
    });
  },

  API_KEY,
};

export default GoogleAuth;
