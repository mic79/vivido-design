const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResponse(request, env, null, 204);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/auth/token' && request.method === 'POST') {
        return await handleTokenExchange(request, env);
      }
      if (url.pathname === '/auth/refresh' && request.method === 'POST') {
        return await handleTokenRefresh(request, env);
      }
    } catch (err) {
      return corsResponse(request, env, { error: err.message }, 500);
    }

    return new Response('Not found', { status: 404 });
  },
};

function corsResponse(request, env, body, status = 200) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const isAllowed = allowed.some(o => origin === o);

  const headers = {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };

  if (body === null) return new Response(null, { status, headers });

  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function getEncryptionKey(secret) {
  const raw = new TextEncoder().encode(secret.padEnd(32, '\0').slice(0, 32));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(text, secret) {
  const key = await getEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const buf = new Uint8Array(iv.length + ciphertext.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...buf));
}

async function decrypt(encoded, secret) {
  const key = await getEncryptionKey(secret);
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const iv = raw.slice(0, 12);
  const data = raw.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

async function handleTokenExchange(request, env) {
  const { code, redirect_uri } = await request.json();
  if (!code || !redirect_uri) {
    return corsResponse(request, env, { error: 'Missing code or redirect_uri' }, 400);
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  const data = await resp.json();
  if (data.error) {
    console.error('Google token error:', JSON.stringify(data));
    return corsResponse(request, env, {
      error: data.error,
      error_description: data.error_description || '',
      redirect_uri_sent: redirect_uri,
    }, 400);
  }

  const result = {
    access_token: data.access_token,
    expires_in: data.expires_in,
  };

  if (data.refresh_token) {
    result.encrypted_refresh_token = await encrypt(data.refresh_token, env.ENCRYPTION_SECRET);
  }

  return corsResponse(request, env, result);
}

async function handleTokenRefresh(request, env) {
  const { encrypted_refresh_token } = await request.json();
  if (!encrypted_refresh_token) {
    return corsResponse(request, env, { error: 'Missing encrypted_refresh_token' }, 400);
  }

  let refreshToken;
  try {
    refreshToken = await decrypt(encrypted_refresh_token, env.ENCRYPTION_SECRET);
  } catch {
    return corsResponse(request, env, { error: 'Invalid or corrupted refresh token' }, 401);
  }

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  const data = await resp.json();
  if (data.error) {
    return corsResponse(request, env, { error: data.error }, 401);
  }

  return corsResponse(request, env, {
    access_token: data.access_token,
    expires_in: data.expires_in,
  });
}
