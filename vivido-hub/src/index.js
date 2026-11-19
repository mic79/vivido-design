/**
 * vivido-hub — live activity + global rankings for Vivido Design games (Dotmination first).
 *
 * Runs on Cloudflare's FREE Workers plan only, and is built so it can never cost money and
 * never break the games:
 *   - Free plan: exceeding a limit makes requests fail until 00:00 UTC; nothing is billed.
 *   - Self-limit: the hub counts its own calls per UTC day and answers { paused: true } well
 *     before Cloudflare's free quota (which the TURN proxy Worker on this account shares).
 *     Games then stop calling until the next UTC day and simply hide the live/ranking extras.
 *   - Presence is kept in the object's SQLite storage (memory is wiped when Cloudflare evicts an
 *     idle object): one row write per ping, well inside the free 100,000 writes/day because the
 *     self-limit caps all calls at 40,000/day. Counts are cached for 10 s to keep reads low.
 *
 * API (JSON, CORS):
 *   POST /v1/ping   { app, id, state, nick? }        → { counts }  (state may be 'waiting:<startType>')
 *   POST /v1/score  { app, id, nick, level, ms }     → { best, rank, total }
 *   GET  /v1/top?level=N&id=…                        → { top: [...], me }
 *   GET  /v1/top?overall=1&id=…                      → { top: [...], me }
 *   POST /v1/nick   { id, nick }                     → { nick }
 */

// Daily budget for the whole hub (Workers free plan: 100,000 requests/day per account,
// shared with the TURN proxy). Stop at 40% so the proxy always keeps its share.
const DAILY_LIMIT = 40000;
const PRESENCE_TTL_MS = 100 * 1000;     // a client that stops pinging drops off after 100 s
const APPS = ['dotmination', 'dotminationvr'];
// 'waiting:<startType>' = hosting a public 2D-compatible match others can join right now
const START_TYPES = ['blank', 'half-filled'];
const STATES = ['menu', 'solo', 'lobby', 'searching', 'playing'].concat(START_TYPES.map((t) => 'waiting:' + t));
const MAX_LEVEL = 200;

const ALLOWED_ORIGINS = [
  /^https:\/\/vivido-design\.com$/,
  /^https:\/\/www\.vivido-design\.com$/,
  /^https:\/\/[a-z0-9-]+\.itch\.zone$/,
  /^https:\/\/[a-z0-9-]+\.discordsays\.com$/,
  /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
];

function corsHeaders(origin) {
  const ok = origin && ALLOWED_ORIGINS.some((re) => re.test(origin));
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://vivido-design.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    const url = new URL(request.url);
    // Discord's proxy forwards /hub/... → strip it
    const path = url.pathname.replace(/^\/hub(?=\/)/, '');
    if (!path.startsWith('/v1/')) return json({ error: 'not found' }, 404, origin);
    try {
      const stub = env.HUB.get(env.HUB.idFromName('global'));
      const inner = new Request('https://hub' + path + url.search, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: request.method === 'POST' ? await request.text() : undefined,
      });
      const res = await stub.fetch(inner);
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
      });
    } catch (e) {
      return json({ error: 'unavailable' }, 503, origin);
    }
  },
};

function utcDay(ts) { return new Date(ts).toISOString().slice(0, 10); }
function nextUtcMidnight(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
function cleanId(s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null; }
function cleanNick(s) {
  if (typeof s !== 'string') return null;
  const n = s.normalize('NFKC').replace(/[\u0000-\u001f<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n.length >= 2 ? n : null;
}

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.limit = Number(env && env.DAILY_LIMIT) || DAILY_LIMIT;
    this.sql = state.storage.sql;
    this.countsCache = null;   // { at, value }
    this.day = null;
    this.count = 0;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS scores (
      id TEXT NOT NULL, level INTEGER NOT NULL, ms INTEGER NOT NULL, app TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (id, level))`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS scores_level_ms ON scores (level, ms)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, nick TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, app TEXT NOT NULL, state TEXT NOT NULL, seen INTEGER NOT NULL)');
  }

  // Count this call against today's budget; persisted every 25 calls (cheap on row writes)
  budget(now) {
    const day = utcDay(now);
    if (day !== this.day) {
      this.day = day;
      const row = this.sql.exec('SELECT n FROM usage WHERE day = ?', day).toArray()[0];
      this.count = row ? row.n : 0;
      this.sql.exec('DELETE FROM usage WHERE day < ?', utcDay(now - 7 * 86400000));
    }
    this.count++;
    if (this.count % 25 === 0) {
      this.sql.exec('INSERT INTO usage (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = excluded.n', day, this.count);
    }
    return this.count <= this.limit;
  }

  counts(now, fresh) {
    if (!fresh && this.countsCache && now - this.countsCache.at < 10000) return this.countsCache.value;
    const out = { online: 0, searching: 0, playing: 0, lobby: 0, waiting: {}, apps: {} };
    for (const t of START_TYPES) out.waiting[t] = 0;
    for (const a of APPS) out.apps[a] = { online: 0, searching: 0, playing: 0, lobby: 0 };
    this.sql.exec('DELETE FROM presence WHERE seen < ?', now - PRESENCE_TTL_MS);
    const rows = this.sql.exec('SELECT app, state FROM presence').toArray();
    for (const p of rows) {
      const a = out.apps[p.app];
      if (!a) continue;
      out.online++; a.online++;
      if (p.state.startsWith('waiting:')) { out.searching++; a.searching++; out.waiting[p.state.slice(8)]++; }
      else if (p.state === 'searching') { out.searching++; a.searching++; }
      else if (p.state === 'playing') { out.playing++; a.playing++; }
      else if (p.state === 'lobby') { out.lobby++; a.lobby++; }
    }
    // matches = pairs of players in a match (rounded up for an odd count)
    out.matches = Math.ceil(out.playing / 2);
    this.countsCache = { at: now, value: out };
    return out;
  }

  nickFor(id) {
    const r = this.sql.exec('SELECT nick FROM players WHERE id = ?', id).toArray()[0];
    return r ? r.nick : null;
  }

  setNick(id, nick) {
    this.sql.exec('INSERT INTO players (id, nick) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET nick = excluded.nick', id, nick);
  }

  async fetch(request) {
    const now = Date.now();
    if (!this.budget(now)) {
      return Response.json({ paused: true, until: nextUtcMidnight(now) }, { status: 503 });
    }
    const url = new URL(request.url);
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch (e) { return Response.json({ error: 'bad json' }, { status: 400 }); }
    }

    if (url.pathname === '/v1/ping' && request.method === 'POST') {
      const id = cleanId(body.id);
      const app = APPS.includes(body.app) ? body.app : null;
      if (!id || !app) return Response.json({ error: 'bad request' }, { status: 400 });
      const st = STATES.includes(body.state) ? body.state : 'menu';
      // Was this client unknown or did its state change? Then recount now instead of using the cache
      const prev = this.sql.exec('SELECT state FROM presence WHERE id = ?', id).toArray()[0];
      if (body.state === 'gone') this.sql.exec('DELETE FROM presence WHERE id = ?', id);
      else this.sql.exec(`INSERT INTO presence (id, app, state, seen) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET app = excluded.app, state = excluded.state, seen = excluded.seen`, id, app, st, now);
      const changed = !prev || body.state === 'gone' || prev.state !== st;
      return Response.json({ counts: this.counts(now, changed) });
    }

    if (url.pathname === '/v1/score' && request.method === 'POST') {
      const id = cleanId(body.id);
      const app = APPS.includes(body.app) ? body.app : null;
      const level = Number(body.level) | 0;
      const ms = Math.round(Number(body.ms));
      // Plausibility: real levels take at least a few seconds and at most two hours
      if (!id || !app || level < 1 || level > MAX_LEVEL || !(ms >= 2500 && ms <= 7200000)) {
        return Response.json({ error: 'bad request' }, { status: 400 });
      }
      const nick = cleanNick(body.nick);
      if (nick) this.setNick(id, nick);
      else if (!this.nickFor(id)) this.setNick(id, 'Player ' + id.slice(-4).toUpperCase());
      const prev = this.sql.exec('SELECT ms FROM scores WHERE id = ? AND level = ?', id, level).toArray()[0];
      if (!prev || ms < prev.ms) {
        this.sql.exec(`INSERT INTO scores (id, level, ms, app, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id, level) DO UPDATE SET ms = excluded.ms, app = excluded.app, at = excluded.at`, id, level, ms, app, now);
      }
      const best = prev && prev.ms < ms ? prev.ms : ms;
      const rank = this.sql.exec('SELECT COUNT(*) AS c FROM scores WHERE level = ? AND ms < ?', level, best).toArray()[0].c + 1;
      const total = this.sql.exec('SELECT COUNT(*) AS c FROM scores WHERE level = ?', level).toArray()[0].c;
      return Response.json({ best, rank, total, improved: !prev || ms < prev.ms });
    }

    if (url.pathname === '/v1/top' && request.method === 'GET') {
      const me = cleanId(url.searchParams.get('id') || '');
      if (url.searchParams.get('overall')) {
        // Most levels completed, ties broken by the lowest total time
        const top = this.sql.exec(`SELECT s.id, COALESCE(p.nick, 'Player') AS nick, COUNT(*) AS levels, SUM(s.ms) AS totalMs
          FROM scores s LEFT JOIN players p ON p.id = s.id GROUP BY s.id ORDER BY levels DESC, totalMs ASC LIMIT 10`).toArray();
        let mine = null;
        if (me) {
          const m = this.sql.exec('SELECT COUNT(*) AS levels, SUM(ms) AS totalMs FROM scores WHERE id = ?', me).toArray()[0];
          if (m && m.levels) {
            const ahead = this.sql.exec(`SELECT COUNT(*) AS c FROM (SELECT id, COUNT(*) AS l, SUM(ms) AS t FROM scores GROUP BY id)
              WHERE l > ? OR (l = ? AND t < ?)`, m.levels, m.levels, m.totalMs).toArray()[0].c;
            mine = { rank: ahead + 1, levels: m.levels, totalMs: m.totalMs, nick: this.nickFor(me) };
          }
        }
        const players = this.sql.exec('SELECT COUNT(DISTINCT id) AS c FROM scores').toArray()[0].c;
        return Response.json({ top: top.map((r) => ({ nick: r.nick, levels: r.levels, totalMs: r.totalMs, me: r.id === me })), me: mine, players });
      }
      const level = Number(url.searchParams.get('level')) | 0;
      if (level < 1 || level > MAX_LEVEL) return Response.json({ error: 'bad level' }, { status: 400 });
      const top = this.sql.exec(`SELECT s.id, COALESCE(p.nick, 'Player') AS nick, s.ms, s.app FROM scores s
        LEFT JOIN players p ON p.id = s.id WHERE s.level = ? ORDER BY s.ms ASC, s.at ASC LIMIT 10`, level).toArray();
      let mine = null;
      if (me) {
        const m = this.sql.exec('SELECT ms FROM scores WHERE id = ? AND level = ?', me, level).toArray()[0];
        if (m) mine = { ms: m.ms, rank: this.sql.exec('SELECT COUNT(*) AS c FROM scores WHERE level = ? AND ms < ?', level, m.ms).toArray()[0].c + 1 };
      }
      const total = this.sql.exec('SELECT COUNT(*) AS c FROM scores WHERE level = ?', level).toArray()[0].c;
      return Response.json({ level, top: top.map((r) => ({ nick: r.nick, ms: r.ms, app: r.app, me: r.id === me })), me: mine, total });
    }

    if (url.pathname === '/v1/nick' && request.method === 'POST') {
      const id = cleanId(body.id);
      const nick = cleanNick(body.nick);
      if (!id || !nick) return Response.json({ error: 'bad request' }, { status: 400 });
      this.setNick(id, nick);
      return Response.json({ nick });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
