/**
 * Google OAuth2 auth module — single-step flow.
 *
 * Uses google.accounts.oauth2.initTokenClient with expanded scopes
 * (drive.file + openid/email/profile) so one account-selection prompt
 * grants both API access and user identity.
 *
 * Token is cached in sessionStorage for seamless reloads within its
 * ~1 hour lifetime. User profile is cached in localStorage.
 */

const CLIENT_ID = '399400088485-h2nrjmo500qj4s7qrvfaog2tsqet3huo.apps.googleusercontent.com';
const API_KEY   = 'AIzaSyBdC9q6tLx1vLOFyUF-8Jeuy4gpuTYiaPs';
const SCOPES    = 'https://www.googleapis.com/auth/drive.file openid email profile';

let tokenClient      = null;
let accessToken      = null;
let userProfile      = null;
let _onAuthChange         = null;
let _tokenRejecter        = null;
let _connectResolver      = null;
let _pendingTokenPromise  = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

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
  sessionStorage.setItem('valu_access_token', token);
  sessionStorage.setItem('valu_token_expiry', String(Date.now() + ((expiresIn || 3600) * 1000)));
}

function getCachedToken() {
  const token = sessionStorage.getItem('valu_access_token');
  const expiry = parseInt(sessionStorage.getItem('valu_token_expiry') || '0', 10);
  if (token && Date.now() < expiry - 60000) {
    return token;
  }
  return null;
}

function clearCachedToken() {
  sessionStorage.removeItem('valu_access_token');
  sessionStorage.removeItem('valu_token_expiry');
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

// ── Public API ─────────────────────────────────────────────────────────────────

const GoogleAuth = {

  get accessToken() { return accessToken; },
  get userProfile() { return userProfile; },
  get isSignedIn() { return !!userProfile; },

  /**
   * Initialize the OAuth2 token client. Call once after the GIS script loads.
   * Restores cached profile + token from storage for seamless reloads.
   */
  init(onAuthChange) {
    _onAuthChange = onAuthChange;

    const storedProfile = getStoredProfile();
    if (storedProfile) {
      userProfile = storedProfile;
    }

    const cached = getCachedToken();
    if (cached) {
      accessToken = cached;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) {
          if (_connectResolver) {
            _connectResolver.reject(new Error(resp.error));
            _connectResolver = null;
          }
          return;
        }
        if (resp.access_token) {
          accessToken = resp.access_token;
          cacheToken(resp.access_token, resp.expires_in);

          if (_connectResolver) {
            _connectResolver.resolve(resp.access_token);
            _connectResolver = null;
          }
        }
      },
      error_callback: (err) => {
        console.warn('Token popup error:', err);
        if (_tokenRejecter) {
          _tokenRejecter(new Error('popup_blocked'));
          _tokenRejecter = null;
        }
        if (_connectResolver) {
          _connectResolver.reject(new Error('popup_blocked'));
          _connectResolver = null;
        }
      },
    });

    if (storedProfile && accessToken) {
      if (_onAuthChange) _onAuthChange(true, userProfile);
    } else if (storedProfile) {
      // Profile cached but token expired — still show as "signed in"
      // so cached data displays, but API calls will need reconnect
      if (_onAuthChange) _onAuthChange(true, userProfile);
    } else {
      if (_onAuthChange) _onAuthChange(false, null);
    }
  },

  /**
   * Initiate the single-step connect flow. Must be called from a user gesture.
   * Opens Google account selector, grants Drive + profile access, fetches
   * user info, and notifies the app.
   */
  async connect() {
    const token = await new Promise((resolve, reject) => {
      _connectResolver = { resolve, reject };
      tokenClient.requestAccessToken({
        prompt: 'select_account',
      });
    });

    const profile = await fetchUserInfo(token);
    userProfile = profile;
    persistSession(profile);

    if (_onAuthChange) _onAuthChange(true, userProfile);
  },

  /**
   * Get a valid access token. Returns cached token if available.
   * If no token exists, attempts a silent refresh (prompt:'').
   * Throws 'popup_blocked' if the browser blocks the popup.
   */
  getAccessToken() {
    if (accessToken) {
      const expiry = parseInt(sessionStorage.getItem('valu_token_expiry') || '0', 10);
      if (Date.now() < expiry - 60000) {
        return Promise.resolve(accessToken);
      }
      accessToken = null;
      clearCachedToken();
    }

    const cached = getCachedToken();
    if (cached) {
      accessToken = cached;
      return Promise.resolve(cached);
    }

    if (_pendingTokenPromise) return _pendingTokenPromise;

    if (!tokenClient) {
      return Promise.reject(new Error('Not signed in'));
    }

    _pendingTokenPromise = new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        _pendingTokenPromise = null;
        _tokenRejecter = null;
        if (resp.error) {
          reject(resp);
          return;
        }
        accessToken = resp.access_token;
        cacheToken(resp.access_token, resp.expires_in);
        resolve(accessToken);
      };

      _tokenRejecter = (err) => {
        _pendingTokenPromise = null;
        reject(err);
      };

      tokenClient.requestAccessToken({
        prompt: '',
        hint: localStorage.getItem('valu_user_email') || '',
      });
    });

    return _pendingTokenPromise;
  },

  handleAuthFailure() {
    accessToken = null;
    clearCachedToken();
    return this.getAccessToken();
  },

  signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    userProfile = null;
    persistSession(null);
    clearCachedToken();
    if (_onAuthChange) _onAuthChange(false, null);
  },

  /**
   * Show the Google Picker to select a Valu spreadsheet.
   */
  async showPicker(query = 'Valu:') {
    const token = await this.getAccessToken();

    if (typeof google.picker === 'undefined' || !google.picker.PickerBuilder) {
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
            const doc = data.docs[0];
            resolve({ id: doc.id, name: doc.name });
          } else if (data.action === google.picker.Action.CANCEL) {
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
