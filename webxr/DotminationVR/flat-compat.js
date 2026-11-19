// flat-compat.js — CROSS-PLAY with the original flatscreen / mobile Dotmination
// (vivido-design.com/dotmination/game, itch.io, Google Play) without changing that game.
//
// DotminationVR acts exactly like an original client:
//   Matchmaking  same PeerJS cloud (0.peerjs.com) and the same slot ids the original scans:
//                dot-host-{blank|half-filled}-{1..10} / dot-peer-{…}-{1..10}. First free host
//                slot → host; a slot with a host but no peer → join it.
//   Protocol     the original's messages, unchanged:
//                  ready · move{dotIndex} · gameState{currentPlayer, moveAmount, mapString,
//                  fieldClasses, startType, matchStarter} · gameOver{winner, mapString} ·
//                  rematchReady · modeSwitch
//                Newer 2D builds also send/understand (older ones ignore them):
//                  ready{resume:true} (reconnected: continue the same board) · away · back ·
//                  leaving (closed the game: don't wait for a return) · declined (host said "Not now")
//                The host is authoritative (sends gameState after every turn, gameOver at the end).
//   Board        identical 9-row / 40-dot field and dot order (dot-rules.js is a 1:1 port).
//                mapString: one hex char per dot, 0 empty, 1-5 player--1 stage, 6-A player--2.
//   Sides        player--1 = host = teal = VR 'red'; player--2 = joiner = pink = VR 'blue'.
//
// Loaded after dot-game.js and dot-ui.js; extends the dot-game component in place.
(function (global) {
  'use strict';

  var R = global.DotRules;
  var PEER_SERVER = { host: '0.peerjs.com', port: 443, secure: true };
  var MAX_LOBBIES = 10;           // original MAX_LOBBIES
  var CHECK_TIMEOUT_MS = 2000;    // original checkPeerAvailability timeout
  var HOST_REPLY_MS = 15000;      // joined host must send its board within this (a 2D host
                                  // playing while it waits first asks its player, up to 6 s)
  var RETURN_WAIT_MS = 60000;     // link died silently: wait this long for the opponent
  var AWAY_WAIT_MS = 180000;      // either player switched away: wait this long
  var ASK_SECONDS = 6;            // "Opponent joined!" prompt auto-starts after this
  var DEAD_SLOT_MS = 10 * 60000;  // skip an unresponsive host's slot this long
  var P1 = 'player--1';
  var P2 = 'player--2';
  var LOG = '[CrossPlay]';

  function sideOf(player) { return player === P1 ? 'red' : 'blue'; }
  function playerOf(side) { return side === 'red' ? P1 : P2; }
  function otherSide(side) { return side === 'blue' ? 'red' : 'blue'; }
  function flatStartType(vr) { return vr === 'half' || vr === 'half-filled' ? 'half-filled' : 'blank'; }

  // ── Board <-> original mapString ─────────────────────────────────────────
  function toMapString(state) {
    var blue = R.code('blue'), red = R.code('red');
    var s = '';
    for (var i = 0; i < state.owner.length; i++) {
      var st = state.stage[i], o = state.owner[i], c = 0;
      if (st > 0 && o === red) c = st;            // player--1
      else if (st > 0 && o === blue) c = st + 5;  // player--2
      s += c.toString(16).toUpperCase();
    }
    return s;
  }
  function fromMapString(state, str) {
    if (!str || str.length !== state.owner.length) {
      console.warn(LOG, 'mapString length mismatch', str && str.length, state.owner.length);
      return false;
    }
    var blue = R.code('blue'), red = R.code('red');
    for (var i = 0; i < str.length; i++) {
      var c = parseInt(str[i], 16) || 0;
      if (c > 5 && c <= 10) { state.owner[i] = blue; state.stage[i] = c - 5; }
      else if (c > 0 && c <= 5) { state.owner[i] = red; state.stage[i] = c; }
      else { state.owner[i] = 0; state.stage[i] = 0; }
    }
    return true;
  }
  function freshState(startType) {
    var st = new R.State();
    if (startType === 'half-filled') st.populateHalf('red', 'blue'); // original clearPlayfield
    else st.clear();
    return st;
  }

  function game() {
    var el = document.querySelector('[dot-game]');
    return el && el.components && el.components['dot-game'];
  }
  function refreshMenu() {
    var m = document.querySelector('[vr-menu]');
    var c = m && m.components && m.components['vr-menu'];
    if (c && typeof c.refreshLobbyUI === 'function') {
      try { c.refreshLobbyUI(); } catch (e) { /* ignore */ }
    }
  }

  async function getIce() {
    if (typeof global.getIceServers === 'function') {
      try { return await global.getIceServers(); } catch (e) { /* fall through */ }
    }
    return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  }

  /** Original checkPeerAvailability: true when nobody holds `id` right now. */
  function checkAvailability(id) {
    return new Promise(function (resolve) {
      var done = false;
      var p = new Peer(id, PEER_SERVER);
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { p.destroy(); } catch (e) { /* ignore */ }
        resolve(v);
      }
      var t = setTimeout(function () { finish(false); }, CHECK_TIMEOUT_MS);
      p.on('open', function () { finish(true); });
      p.on('error', function (err) { finish(!(err && err.type === 'unavailable-id')); });
    });
  }

  var X = {
    active: false,        // searching, waiting or connected
    role: null,           // 'host' | 'peer'
    slot: 0,
    startType: 'blank',   // original value: 'blank' | 'half-filled'
    status: '',
    peer: null,
    conn: null,
    connected: false,
    hasSentGameState: false,
    initialSync: false,
    matchStarter: P1,
    myRematch: false,
    oppRematch: false,
    resume: null,         // { until, timer } while waiting for a dropped opponent / reconnecting
    oppAway: false,       // opponent said it switched away
    linkDropped: false,   // the link died silently (not a clean close)
    declined: false,      // the host we joined said "Not now"
    retired: [],          // host: old PeerJS objects still carrying a running link
    _gen: 0,
    _deadSlots: {}  // 'blank-1' → time. An original host whose peer left ignores new joiners
                    // (its hasConnected flag is never reset), so such a slot stays occupied.
  };

  function setStatus(msg) {
    X.status = msg;
    console.log(LOG, msg);
    refreshMenu();
    var g = game();
    if (g && g._xRefreshEndCard) g._xRefreshEndCard();
  }

  function send(msg) {
    if (X.conn && X.conn.open) {
      try { X.conn.send(msg); return true; } catch (e) { console.warn(LOG, 'send failed', e); }
    }
    return false;
  }

  X.isHost = function () { return X.role === 'host'; };

  /** Start cross-play. vrStartType: 'blank' | 'half' (VR lobby toggle) or the original names. */
  X.start = async function (vrStartType) {
    if (X.active) return;
    if (global.isMultiplayer && typeof global.endMultiplayer === 'function') global.endMultiplayer();
    var gen = ++X._gen;
    X.declined = false;
    X.active = true;
    X.role = null;
    X.slot = 0;
    X.connected = false;
    X.startType = flatStartType(vrStartType ||
      (typeof global.getStartType === 'function' ? global.getStartType() : 'blank'));
    var g = game();
    if (g && g.matchActive && !g._dualBotPreview && typeof g.endMatch === 'function') g.endMatch();
    setStatus("Searching '" + X.startType + "' game slots...");
    var slot = null;
    try {
      slot = await findSlot(X.startType, gen);
    } catch (e) {
      console.warn(LOG, 'slot search failed', e);
    }
    if (gen !== X._gen) return;
    if (!slot) {
      X.active = false;
      setStatus('No free cross-play slot - try again');
      return;
    }
    X.slot = slot.slot;
    X.role = slot.role;
    if (slot.role === 'host') await setupHost(slot.slot, gen);
    else await setupPeer(slot.slot, gen);
  };

  async function findSlot(st, gen) {
    for (var i = 1; i <= MAX_LOBBIES; i++) {
      if (gen !== X._gen) return null;
      setStatus('Searching slot ' + i + ' / ' + MAX_LOBBIES + '...');
      var hostFree = await checkAvailability('dot-host-' + st + '-' + i);
      if (gen !== X._gen) return null;
      if (hostFree) return { slot: i, role: 'host' };
      var dead = X._deadSlots[st + '-' + i];
      if (dead && Date.now() - dead < DEAD_SLOT_MS) continue;
      var peerFree = await checkAvailability('dot-peer-' + st + '-' + i);
      if (peerFree) return { slot: i, role: 'peer' };
    }
    return null;
  }

  async function setupHost(slot, gen) {
    var ice = await getIce();
    if (gen !== X._gen) return;
    var id = 'dot-host-' + X.startType + '-' + slot;
    var peer = new Peer(id, Object.assign({ config: { iceServers: ice } }, PEER_SERVER));
    X.peer = peer;
    peer.on('open', function () {
      if (gen !== X._gen) return;
      setStatus('Waiting for an opponent (slot ' + slot + ')');
      if (slot > 1) watchLowerSlots(slot, gen);
    });
    X._onConn = function (c) {
      if (gen !== X._gen) { try { c.close(); } catch (e) { /* ignore */ } return; }
      if (X.conn && X.conn.open && X.connected) {
        console.log(LOG, 'already connected, rejecting', c.peer);
        try { c.close(); } catch (e2) { /* ignore */ }
        return;
      }
      if (X.conn) { var stale = X.conn; X.conn = null; try { stale.close(); } catch (e3) { /* ignore */ } }
      attach(c, gen);
    };
    peer.on('connection', X._onConn);
    peer.on('error', function (err) { onPeerError(err, gen); });
  }

  // Host: the matchmaking server can drop us (headset asleep, network blip) while the game
  // link keeps working. Sign in again with a fresh PeerJS object under the same id, so the
  // opponent can find us if their link drops later. (PeerJS 1.4.7's reconnect() makes every
  // later join arrive twice, which breaks reconnecting.)
  var signalPending = null;
  function rejoinSignal() {
    if (!X.active || !X.isHost() || signalPending || !X.peer || X.peer.destroyed || !X.peer.disconnected) return;
    var gen = X._gen;
    var old = X.peer;
    var id = 'dot-host-' + X.startType + '-' + X.slot;
    getIce().then(function (ice) {
      if (gen !== X._gen || X.peer !== old || signalPending) return;
      var np = new Peer(id, Object.assign({ config: { iceServers: ice } }, PEER_SERVER));
      signalPending = np;
      np.on('open', function () {
        signalPending = null;
        if (gen !== X._gen || X.peer !== old) { try { np.destroy(); } catch (e) { /* ignore */ } return; }
        console.log(LOG, 'signed back in to the matchmaking server as', id);
        X.retired.push(old);
        X.peer = np;
        np.on('connection', function (c) { if (X._onConn) X._onConn(c); });
      });
      np.on('error', function (err) {
        console.warn(LOG, 'matchmaking sign-in failed, retrying:', err && err.type);
        if (signalPending === np) signalPending = null;
        try { np.destroy(); } catch (e) { /* ignore */ }
      });
    });
  }
  setInterval(rejoinSignal, 5000);

  function destroyRetired() {
    var list = X.retired;
    X.retired = [];
    list.forEach(function (p) { if (p !== X.peer) { try { p.destroy(); } catch (e) { /* ignore */ } } });
  }

  /** Hosting above slot 1: originals scan from slot 1 up, so join one that waits lower down. */
  function watchLowerSlots(slot, gen) {
    var busy = false;
    var timer = setInterval(async function () {
      if (gen !== X._gen || X.conn) { if (gen !== X._gen) clearInterval(timer); return; }
      if (busy) return;
      busy = true;
      try {
        for (var k = 1; k < slot; k++) {
          var st = X.startType;
          if (await checkAvailability('dot-host-' + st + '-' + k)) {           // nobody there
            delete X._deadSlots[st + '-' + k];   // the stuck host is gone; a new one may come
            continue;
          }
          if (gen !== X._gen || X.conn) return;
          var dead = X._deadSlots[st + '-' + k];
          if (dead && Date.now() - dead < DEAD_SLOT_MS) continue;
          if (!(await checkAvailability('dot-peer-' + st + '-' + k))) continue; // already full
          if (gen !== X._gen || X.conn) return;
          clearInterval(timer);
          console.log(LOG, 'host waiting in lower slot ' + k + ', joining it');
          var old = X.peer;
          var g2 = ++X._gen;
          X.peer = null;
          try { if (old) old.destroy(); } catch (e) { /* ignore */ }
          X.slot = k;
          X.role = 'peer';
          await setupPeer(k, g2);
          return;
        }
      } finally { busy = false; }
    }, 15000);
  }

  async function setupPeer(slot, gen) {
    var ice = await getIce();
    if (gen !== X._gen) return;
    var id = 'dot-peer-' + X.startType + '-' + slot;
    var hostId = 'dot-host-' + X.startType + '-' + slot;
    var peer = new Peer(id, Object.assign({ config: { iceServers: ice } }, PEER_SERVER));
    X.peer = peer;
    peer.on('open', function () {
      if (gen !== X._gen) return;
      setStatus('Connecting to host (slot ' + slot + ')...');
      attach(peer.connect(hostId, { reliable: true }), gen);
      // No opening board in time → that host is stuck; remember the slot and search again
      var st = X.startType, key = st + '-' + slot;
      setTimeout(function () {
        if (gen !== X._gen || X.initialSync || X.resume) return;
        X._deadSlots[key] = Date.now();
        teardown("That game didn't respond - searching again", false);
        setTimeout(function () { if (!X.active) X.start(st); }, 300);
      }, HOST_REPLY_MS);
    });
    peer.on('error', function (err) { onPeerError(err, gen); });
  }

  function onPeerError(err, gen) {
    if (gen !== X._gen) return;
    console.warn(LOG, 'peer error', err && err.type, err);
    if (X.resume) return;   // reconnecting: the host may not be back yet; keep trying
    // Transient signalling hiccups while a game is running: keep the data channel
    if (X.connected && err && (err.type === 'network' || err.type === 'server-error')) return;
    var t = err && err.type;
    teardown(t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'socket-closed'
      ? "Can't reach the matchmaking server - check your internet"
      : "Couldn't connect to the other player", false);
  }

  // A peer that vanishes without closing (tab killed, phone asleep, network gone) never sends
  // 'close'. Watch the WebRTC link itself: 'failed', or 'disconnected' for 8 s, counts as gone.
  // Works with any client version (no extra messages on the wire).
  function watchLink(c, onGone) {
    var pc = c && c.peerConnection;
    if (!pc || pc.__dotWatch) return;
    pc.__dotWatch = true;
    var timer = null;
    var fired = false;
    function gone() {
      if (fired) return;
      fired = true;
      if (timer) clearTimeout(timer);
      onGone();
    }
    pc.addEventListener('iceconnectionstatechange', function () {
      var st = pc.iceConnectionState;
      if (st === 'failed' || st === 'closed') gone();
      else if (st === 'disconnected') {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { if (pc.iceConnectionState === 'disconnected') gone(); }, 8000);
      } else if (timer) { clearTimeout(timer); timer = null; }
    });
  }

  function attach(c, gen) {
    X.conn = c;
    X.initialSync = false;
    X.hasSentGameState = false;
    X.myRematch = false;
    X.oppRematch = false;
    function onOpen() {
      if (gen !== X._gen || X.conn !== c) return;
      if (X.connected) return;
      X.connected = true;
      X.linkDropped = false;
      if (!X.isHost() && X.resume) {
        // Back after a drop: ask the host to continue the same board
        send({ type: 'ready', resume: true });
        resumed();
        return;
      }
      setStatus('Connected - ' + (X.isHost() ? 'you are host (teal)' : 'you joined (pink)'));
      if (!X.isHost()) send({ type: 'ready' });   // original: peer announces itself
    }
    c.on('open', onOpen);
    c.on('data', function (d) {
      if (gen !== X._gen || X.conn !== c) return;
      onData(d);
    });
    c.on('close', function () {
      if (gen !== X._gen || X.conn !== c) return;
      onClose();
    });
    c.on('error', function (e) { console.warn(LOG, 'conn error', e); });
    c.on('open', function () {
      watchLink(c, function () {
        if (gen !== X._gen || X.conn !== c) return;
        X.linkDropped = true;
        try { c.close(); } catch (e) { /* ignore */ }
        if (X.conn === c) onClose();
      });
    });
    if (c.open) onOpen();
  }

  function onData(d) {
    if (!d || !d.type) return;
    var g = game();
    if (!g) return;
    switch (d.type) {
      case 'ready':
        if (!X.isHost()) break;
        // The opponent came back after a drop: continue the same board
        if (d.resume && X.resume && g._xplay && g.matchActive) {
          X.hostSendState(g.boards.shared);
          resumed();
          break;
        }
        if (X.resume) {   // they reloaded instead: the old match is over, start a new one
          clearResume();
          X.hasSentGameState = false;
          g.xAbort('');
        }
        // Host answers the first ready with the opening board (original setupConnectionHandlers)
        if (!X.hasSentGameState) {
          X.hasSentGameState = true;
          if (g._xIsPlayingSolo()) {
            // Playing a level / the bot while waiting: ask first
            g._xAskJoin(function () { if (X.connected) hostStartMatch(); }, declineJoin);
          } else {
            hostStartMatch();
          }
        }
        break;
      case 'away':
      case 'back':
        X.oppAway = d.type === 'away';
        if (!X.resume && g._xplay && g.matchActive) {
          g._showNotice(X.oppAway ? 'Your opponent switched away from the game' : 'Your opponent is back', X.oppAway ? 6000 : 2500);
        }
        break;
      case 'leaving':
        // Closed the game on purpose: no point waiting for a return
        X._oppLeft = true;
        break;
      case 'declined':
        X.declined = true;
        break;
      case 'gameState':
        if (X.isHost()) break;
        if (d.startType) X.startType = d.startType;
        if (d.matchStarter) X.matchStarter = d.matchStarter;
        if (!X.initialSync || !g.matchActive) {
          X.initialSync = true;
          X.myRematch = false;
          X.oppRematch = false;
          g.xStartMatch({
            mySide: 'blue', host: false, mapString: d.mapString,
            turn: sideOf(d.currentPlayer), turnNo: d.moveAmount | 0
          });
          send({ type: 'ready' });                 // original: peer confirms the sync
          setStatus('Playing - you are pink (slot ' + X.slot + ')');
        } else {
          g.xSync(d.mapString, sideOf(d.currentPlayer), d.moveAmount | 0);
        }
        break;
      case 'move':
        g.xRemoteMove(d.dotIndex | 0);
        break;
      case 'gameOver':
        if (!X.isHost()) g.xGameOver(sideOf(d.winner), d.mapString);
        break;
      case 'rematchReady':
        X.oppRematch = true;
        if (X.myRematch) bothReady();
        else setStatus('Opponent wants a rematch');
        break;
      case 'modeSwitch':
        // Original host left multiplayer (or said "Not now" to our join)
        teardown(X.declined ? "That player can't start a match right now" : 'Opponent left the match', false);
        break;
      default:
        console.log(LOG, 'ignored message', d);
    }
  }

  function onClose() {
    var g = game();
    X.connected = false;
    X.conn = null;
    var left = X._oppLeft;
    X._oppLeft = false;
    // The player who joined left before the host answered the "Opponent joined!" prompt
    if (g && g._xAsk) { g._xAskClose(); X.hasSentGameState = false; setStatus('Waiting for an opponent (slot ' + X.slot + ')'); return; }
    // A running match whose link ended without a goodbye: wait for the opponent to come back
    if (!left && g && g._xplay && g.matchActive && X.active) {
      startResume(g);
      return;
    }
    if (X.isHost() && X.peer && !X.peer.destroyed) {
      // Original peers reconnect to the same slot; keep hosting
      X.hasSentGameState = false;
      if (g) g.xAbort('Your opponent left the match');
      setStatus('Opponent left - waiting (slot ' + X.slot + ')');
    } else {
      teardown('Your opponent left the match', false);
    }
  }

  // ── Reconnecting after a drop (same rules as the 2D game) ──────────────────
  var lastVisibleAt = Date.now();
  var wasHiddenAt = 0;
  function meAway() {
    return (global.document && global.document.hidden) || X._xrHidden ||
      (wasHiddenAt && Date.now() - lastVisibleAt < 20000);
  }
  function returnWait() {
    if (X.oppAway || meAway()) return AWAY_WAIT_MS;
    if (X.linkDropped) return RETURN_WAIT_MS;
    return X.isHost() ? 30000 : 15000;
  }
  function clearResume() {
    if (X.resume) { clearTimeout(X.resume.timer); clearInterval(X.resume.loop); }
    X.resume = null;
  }
  function startResume(g) {
    clearResume();
    var ms = returnWait();
    var away = X.oppAway;
    X.resume = { until: Date.now() + ms, timer: setTimeout(giveUpResume, ms), loop: null, nextTry: 0 };
    var msg = X.isHost()
      ? (away ? 'Your opponent switched away. Waiting for them to come back...' : 'Your opponent disconnected. Waiting for them to come back...')
      : (away ? 'Your opponent switched away. Reconnecting when they are back...' : 'Lost the connection. Reconnecting...');
    g._showNotice(msg, ms);
    setStatus(msg);
    if (X.isHost()) {
      destroyRetired();
      rejoinSignal();
    } else {
      // Keep trying to reach the same host until it answers or the wait runs out
      X.resume.loop = setInterval(function () {
        if (!X.resume || X.connected) return;
        if (Date.now() < X.resume.nextTry) return;
        X.resume.nextTry = Date.now() + 10000;
        try { if (X.peer) X.peer.destroy(); } catch (e) { /* ignore */ }
        X.peer = null;
        setupPeer(X.slot, X._gen);
      }, 1000);
    }
  }
  function resumed() {
    clearResume();
    X.oppAway = false;
    var g = game();
    if (g) { g._clearNotice(); g._showNotice('Reconnected', 2500); }
    setStatus('Playing - you are ' + (X.isHost() ? 'teal (host, slot ' : 'pink (slot ') + X.slot + ')');
  }
  function giveUpResume() {
    clearResume();
    var g = game();
    if (X.isHost()) {
      X.hasSentGameState = false;
      if (g) { g._clearNotice(); g.xAbort('Your opponent left the match'); }
      setStatus('Opponent left - waiting (slot ' + X.slot + ')');
    } else {
      teardown('Your opponent left the match', false);
    }
  }

  // Host said "Not now" to a joining player: tell them, stop hosting
  function declineJoin() {
    send({ type: 'declined' });
    send({ type: 'modeSwitch' });
    teardown('Stopped waiting for cross-play opponents', true);
    var g = game();
    if (g) g._showNotice('Stopped waiting for cross-play opponents', 4000);
  }

  // Tell the opponent when this player switches away (tab hidden, headset off, system menu)
  function sayVisibility(away) {
    if (away) wasHiddenAt = Date.now(); else lastVisibleAt = Date.now();
    if (X.connected) send({ type: away ? 'away' : 'back' });
    if (!away) rejoinSignal();
  }
  if (global.document) {
    global.document.addEventListener('visibilitychange', function () { sayVisibility(global.document.hidden); });
  }
  function watchXrSession() {
    var scene = global.document && global.document.querySelector('a-scene');
    if (!scene) return;
    scene.addEventListener('enter-vr', function () {
      var xr = scene.renderer && scene.renderer.xr;
      var session = xr && xr.getSession && xr.getSession();
      if (!session || session.__dotVis) return;
      session.__dotVis = true;
      session.addEventListener('visibilitychange', function () {
        var hidden = session.visibilityState === 'hidden';
        if (hidden === !!X._xrHidden) return;
        X._xrHidden = hidden;
        sayVisibility(hidden);
      });
    });
  }
  if (global.document && global.document.readyState !== 'loading') watchXrSession();
  else if (global.document) global.document.addEventListener('DOMContentLoaded', watchXrSession);

  function hostStartMatch() {
    var g = game();
    if (!g) return;
    X.myRematch = false;
    X.oppRematch = false;
    var st = freshState(X.startType);
    var map = toMapString(st);
    send({
      type: 'gameState',
      currentPlayer: X.matchStarter,
      moveAmount: 0,
      mapString: map,
      fieldClasses: 'field ' + X.matchStarter,
      startType: X.startType,
      matchStarter: X.matchStarter
    });
    g.xStartMatch({ mySide: 'red', host: true, mapString: map, turn: sideOf(X.matchStarter), turnNo: 0 });
    setStatus('Playing - you are teal (host, slot ' + X.slot + ')');
  }

  function bothReady() {
    X.myRematch = false;
    X.oppRematch = false;
    if (X.isHost()) {
      X.matchStarter = X.matchStarter === P1 ? P2 : P1;   // original: starter alternates
      hostStartMatch();
    } else {
      X.initialSync = false;                               // next gameState starts the match
      setStatus('Rematch accepted - waiting for host');
    }
  }

  // ── Calls from the game component ─────────────────────────────────────────
  X.sendMove = function (idx) { send({ type: 'move', dotIndex: idx }); };

  /** Host: authoritative board after a finished turn (original nextPlayer). */
  X.hostSendState = function (board) {
    if (!X.isHost()) return;
    var cp = playerOf(board.turn);
    send({
      type: 'gameState',
      currentPlayer: cp,
      moveAmount: board.turnNo | 0,
      mapString: toMapString(board.state),
      fieldClasses: 'field ' + cp,
      startType: X.startType,
      matchStarter: X.matchStarter
    });
  };

  X.sendGameOver = function (winnerSide, board) {
    if (!X.isHost()) return;
    send({ type: 'gameOver', winner: playerOf(winnerSide), mapString: toMapString(board.state) });
  };

  X.rematch = function () {
    if (!X.connected) return;
    X.myRematch = true;
    send({ type: 'rematchReady' });
    if (X.oppRematch) bothReady();
    else setStatus('Waiting for opponent to accept the rematch');
  };

  /** Leave cross-play. A host tells the flat peer (original modeSwitch → back to its menu). */
  X.stop = function () {
    if (!X.active) return;
    if (X.connected) send({ type: X.isHost() ? 'modeSwitch' : 'leaving' });
    teardown('Cross-play off', true);
  };

  function teardown(msg, polite) {
    clearResume();
    destroyRetired();
    X.oppAway = false;
    X.declined = false;
    X._oppLeft = false;
    var gp = game();
    if (gp && gp._xAskClose) gp._xAskClose();
    X._gen++;
    var peer = X.peer, conn = X.conn;
    X.peer = null;
    X.conn = null;
    X.connected = false;
    X.active = false;
    X.role = null;
    var g = game();
    if (g) g.xAbort(msg);
    setTimeout(function () {   // let a final modeSwitch flush
      try { if (conn) conn.close(); } catch (e) { /* ignore */ }
      try { if (peer) peer.destroy(); } catch (e2) { /* ignore */ }
    }, polite ? 150 : 0);
    setStatus(msg);
  }

  X.toggle = function () { if (X.active) X.stop(); else X.start(); };
  X._toMapString = toMapString;
  X._fromMapString = fromMapString;

  // Leaving the page: close at once (stop() defers the close, which never runs on unload),
  // so the other player is told immediately instead of after a network timeout.
  function closeNow() {
    if (!X.active) return;
    // Host: the original "match over" message. Joined player: 'leaving' (newer 2D builds stop
    // waiting for a return; older ones ignore it)
    try { if (X.connected) send({ type: X.isHost() ? 'modeSwitch' : 'leaving' }); } catch (e) { /* ignore */ }
    try { if (X.conn) X.conn.close(); } catch (e2) { /* ignore */ }
    try { if (X.peer) X.peer.destroy(); } catch (e3) { /* ignore */ }
  }
  global.addEventListener('pagehide', closeNow);
  global.addEventListener('beforeunload', closeNow);
  global.FlatCompat = X;

  // ── dot-game component hooks ──────────────────────────────────────────────
  if (!global.AFRAME || !AFRAME.components['dot-game']) {
    console.error(LOG, 'dot-game must load first');
    return;
  }
  var C = AFRAME.components['dot-game'].Component.prototype;
  function wrap(name, fn) {
    var orig = C[name];
    C[name] = function () { return fn.call(this, orig, Array.prototype.slice.call(arguments)); };
  }

  /** Begin a cross-play match from the original's opening gameState. */
  C.xStartMatch = function (o) {
    if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
    if (this._tutorial && this.endTutorial) this.endTutorial(true);
    if (this._welcomeCard && this._uiHide) this._uiHide(this._welcomeCard);
    if (this._dualBotPreview || this.matchActive) {
      this._xplay = null;
      this.onMatchEnded({ cancelled: true });
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
    }
    this._clearVictory();
    this._clearMatchBanner();
    this._endingMatch = false;
    this._endPending = false;
    this._dualBotPreview = false;
    global.offlinePreview = false;
    global.botReactionTarget = null;
    global.botReactionTargetBlue = null;
    global.isLobbyBotMatch = false;
    this._xplay = { mySide: o.mySide, host: !!o.host };
    this._levelMatch = 0;
    this._recent = { blue: [], red: [] };
    this._resultLine = '';
    this._resultSegs = null;
    this._matchElapsedMs = 0;

    var b = this.boards.shared;
    if (b.state.layout.rows !== R.ROWS || b.state.layout.cols !== R.COLS) b.state = new R.State();
    fromMapString(b.state, o.mapString);
    b.turn = o.turn;
    b.turnNo = o.turnNo | 0;
    b.rev = 0;
    b._schedTurn = -1;
    b._pitch = 0;
    b.view.setBotChoice(-1);
    b.view.syncFrom(b.state);

    this._seats = { blue: { bot: false }, red: { bot: false } };
    this.modes.setMode('duel');
    this.matchActive = true;
    this.matchState = 'PLAYING';
    this._pendingMatch = null;
    this.modes.start(Date.now());
    this._refreshScores();
    if (this.matchStats) this.matchStats.start(performance.now());
    b.turnStartedAt = performance.now();
    if (this._sceneRoot) this._sceneRoot.visible = true;
    this._clearRemoteAvatarEl(document.getElementById('bot-body'));
    this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));
    this._showMatchBodies({ showBot: false });
    this._matchSeatMeta = {
      blueIsBot: false, redIsBot: false,
      blueName: this._sideNickname('blue'), redName: this._sideNickname('red'),
      wasBotMatch: false, mySide: o.mySide, wasSeatedPlayer: true
    };
    if (window.matchRecorder) {
      window.matchRecorder.startRecording(Date.now());
      window.matchRecorder.recordEvent('init', { level: 0, boards: { shared: b.serialize() } });
    }
    this._matchGoAt = performance.now();
    this._xPlaceAtSeat(o.mySide);
    this._musicMatch();
    this._showMatchBanner('GO!');
    var self = this;
    setTimeout(function () { if (self.matchState === 'PLAYING') self._clearMatchBanner(); }, 900);
    this._updateHUD();
    this._updateNameLabels();
    this._updateBoardLabels(performance.now(), true);
    this.el.sceneEl.emit('lobby-state-updated');
    refreshMenu();
  };

  C._xPlaceAtSeat = function (side) {
    var seat = this.seatPose(side);
    var player = document.getElementById('player');
    if (!player || !seat) return;
    player.setAttribute('position', seat.x + ' 0 ' + seat.z);
    player.object3D.rotation.y = THREE.MathUtils.degToRad(seat.ry || 0);
    var rig = document.getElementById('rig');
    if (rig) { rig.setAttribute('position', '0 0 0'); rig.setAttribute('rotation', '0 0 0'); }
    var body = document.getElementById('player-body');
    if (body && this._tintBody) this._tintBody(body, this._sideColorCss(side));
  };

  /** The opponent's move (original handleOpponentMove). */
  C.xRemoteMove = function (idx) {
    var x = this._xplay;
    if (!x || !this.matchActive || this.matchState !== 'PLAYING') return;
    var b = this.boards.shared;
    var actor = otherSide(x.mySide);
    // The host is authoritative for its own moves; a joiner's move must be on its turn
    if (x.host && b.turn !== actor) { console.warn(LOG, 'move out of turn ignored', idx); return; }
    if (!b.state.canTap(actor, idx)) { console.warn(LOG, 'illegal move ignored', idx); return; }
    if (b.view.busy()) b.view.play(null, null, { instant: true });
    var turnNo = b.turnNo;
    var res = b.state.apply(actor, idx);
    if (!res) return;
    b.turnNo++;
    b.rev++;
    // Joiner: like the original peer, the turn only passes when the host's gameState arrives
    // (after the host's chain animation). Moving earlier would be dropped by an animating host.
    b.turn = x.host ? x.mySide : actor;
    b.turnStartedAt = performance.now();
    b._pitch = 0;
    b.view.play(res, b.state);
    this._afterMove(b, actor, idx, res, { local: false, turnNo: turnNo });
  };

  /** Joiner: the host's authoritative gameState after a turn. */
  C.xSync = function (mapString, turnSide, turnNo) {
    if (!this._xplay || !this.matchActive) return;
    var b = this.boards.shared;
    if (toMapString(b.state) !== mapString) {
      console.log(LOG, 'resync board from host');
      fromMapString(b.state, mapString);
      if (b.view.busy()) b.view.play(null, b.state);
      else b.view.syncFrom(b.state);
    }
    if (b.turn !== turnSide) b.turnStartedAt = performance.now();
    b.turn = turnSide;
    b.turnNo = turnNo | 0;
    b.rev++;
    this._refreshScores();
    this._updateBoardLabels(performance.now(), true);
    this._updateHUD();
  };

  /** Joiner: the host's gameOver (final board + winner). */
  C.xGameOver = function (winnerSide, mapString) {
    if (!this._xplay || !this.matchActive || this._endPending) return;
    var b = this.boards.shared;
    if (mapString && toMapString(b.state) !== mapString) {
      fromMapString(b.state, mapString);
      if (b.view.busy()) b.view.play(null, b.state);
      else b.view.syncFrom(b.state);
    }
    this.modes.winner = winnerSide;
    this.modes.reason = 'dominated';
    this._endPending = true;
    this._matchElapsedMs = Date.now() - (this.modes.matchStart || Date.now());
    var self = this;
    setTimeout(function () {
      self._endPending = false;
      self._endFromMode({ ended: true, winner: winnerSide, reason: 'dominated' });
    }, b.view.remainingMs() + 500);
  };

  /** Connection gone / cross-play stopped: cancel a running match, drop the end card. */
  C.xAbort = function (msg) {
    if (!this._xplay) return;
    var wasLive = this.matchActive;
    this._xplay = null;
    if (wasLive) {
      this.onMatchEnded({ cancelled: true });
    } else {
      this._clearVictory();
      this._scheduleDualIdle(400);
    }
    if (msg) this._showNotice(msg, 6500);
    this._updateNameLabels();
    this._updateBoardLabels(performance.now(), true);
  };

  wrap('_performMove', function (orig, a) {
    var board = a[0], actor = a[1], idx = a[2];
    if (this._xplay && actor === this._xplay.mySide && board.state.canTap(actor, idx)) {
      X.sendMove(idx);   // original sends the move before playing it locally
    }
    return orig.apply(this, a);
  });

  wrap('_afterMove', function (orig, a) {
    var r = orig.apply(this, a);
    var x = this._xplay;
    if (!x || !x.host || !this.matchActive) return r;
    var board = a[0], res = a[3], info = a[4] || {};
    if (!info.local) this._checkBoardEnd(board);   // host judges the opponent's moves too
    var self = this, rev = board.rev;
    // Original host sends gameState once its chain animation ends (one step per 0.1 s).
    // Timed from this move's own steps, not the render queue, so a paused headset can't stall it.
    var steps = res && res.steps ? res.steps.length : 0;
    var delay = (steps + 1) * (board.view.speed || 100) + 30;
    // No local move until that gameState is out: the flat peer drops moves while it animates
    this._xHoldUntil = performance.now() + delay + 20;
    setTimeout(function () {
      if (!self._xplay || !self.matchActive || self._endPending || board.rev !== rev) return;
      X.hostSendState(board);
    }, delay);
    return r;
  });

  wrap('_myActionBoard', function (orig, a) {
    if (this._xplay && this._xHoldUntil && performance.now() < this._xHoldUntil) return null;
    return orig.apply(this, a);
  });

  wrap('_checkBoardEnd', function (orig, a) {
    if (this._xplay && !this._xplay.host) return;   // joiner waits for the host's gameOver
    return orig.apply(this, a);
  });

  wrap('_endFromMode', function (orig, a) {
    var info = a[0] || {};
    if (this._xplay && this._xplay.host && info.winner && !info.cancelled && this.matchActive && !this._endingMatch) {
      X.sendGameOver(info.winner, this.boards.shared);
    }
    return orig.apply(this, a);
  });

  wrap('onMatchStarted', function (orig, a) {
    this._xplay = null;   // any lobby / offline match replaces cross-play
    return orig.apply(this, a);
  });

  wrap('startOfflinePreviewMatch', function (orig, a) {
    if (this._xplay && (this.matchActive || this._victory)) return;
    return orig.apply(this, a);
  });

  wrap('_canResumeDualIdle', function (orig, a) {
    if (this._xplay && (this.matchActive || this._victory)) return false;
    return orig.apply(this, a);
  });

  wrap('endMatch', function (orig, a) {
    // END MATCH during cross-play = leave it (the original has no "end" message)
    if (this._xplay && X.active) { X.stop(); return; }
    return orig.apply(this, a);
  });

  wrap('_localSide', function (orig, a) { return this._xplay ? this._xplay.mySide : orig.apply(this, a); });
  wrap('_mySeatSide', function (orig, a) { return this._xplay ? this._xplay.mySide : orig.apply(this, a); });
  wrap('_isLocalAuthoritySide', function (orig, a) {
    return this._xplay ? a[0] === this._xplay.mySide : orig.apply(this, a);
  });
  wrap('_sideNickname', function (orig, a) {
    if (!this._xplay) return orig.apply(this, a);
    return a[0] === this._xplay.mySide ? String(global.playerNickname || 'You').slice(0, 12) : 'Opponent';
  });
  wrap('_modeTitle', function (orig, a) { return this._xplay ? 'CROSS-PLAY' : orig.apply(this, a); });

  // End card: original showMultiplayerGameOverOverlay — You Win! / You Lose! + Rematch (both sides)
  wrap('_playVictory', function (orig, a) {
    if (!this._xplay) return orig.apply(this, a);
    var info = a[0] || {};
    this._clearVictory();
    if (!this._sceneRoot) return;
    if (!this._uiReady) this._uiInit();
    var winner = info.winner || (this.modes && this.modes.winner) || 'draw';
    var mine = this._xplay.mySide;
    this._endInfo = {
      winner: winner,
      title: winner === 'draw' ? 'Draw!' : (winner === mine ? 'You Win!' : 'You Lose!'),
      stars: null,
      buttons: [{ id: 'xrematch', label: 'Rematch', icon: 'undo', primary: true }],
      sub: this._xEndSub()
    };
    this._victory = { root: this._endCard.group, t0: performance.now(), endCard: true };
    this._uiShow(this._endCard, this._uiFrontPos(0.04));
    this._endCard.shownAt = performance.now();
    this._sfx('win', { volume: 0.5 });
  });

  /** A level / bot game of the player's own (not the idle preview, not cross-play). */
  C._xIsPlayingSolo = function () {
    if (this._xplay || this._dualBotPreview) return !!this._tutorial;
    return !!(this.matchActive || this._tutorial || (this._victory && !this._victory.xask));
  };

  /** Someone joined while this player plays solo: Play now (countdown) / Not now. */
  C._xAskJoin = function (onYes, onNo) {
    if (!this._sceneRoot) { onYes(); return; }
    if (!this._uiReady) this._uiInit();
    var self = this;
    var left = ASK_SECONDS;
    this._xAsk = { yes: onYes, no: onNo, timer: null };
    var draw = function () {
      self._endInfo = {
        winner: 'draw',
        title: 'Opponent joined!',
        stars: null,
        sub: 'Cross-play ' + (X.startType === 'half-filled' ? 'Half-Filled' : 'Blank') + ' match. Your current game will end.',
        buttons: [{ id: 'xask-no', label: 'Not now' }, { id: 'xask-yes', label: 'Play now (' + left + ')', primary: true }]
      };
      self._endCard.dirty = true;
    };
    draw();
    this._xAskPrevVictory = this._victory;
    this._victory = { root: this._endCard.group, t0: performance.now(), endCard: true, xask: true };
    this._uiShow(this._endCard, this._uiFrontPos(0.04));
    this._endCard.shownAt = performance.now();
    this._sfx('win', { volume: 0.4 });
    this._xAsk.timer = setInterval(function () {
      left--;
      if (left <= 0) { self._xAskAnswer(true); return; }
      draw();
    }, 1000);
  };
  C._xAskAnswer = function (yes) {
    var a = this._xAsk;
    if (!a) return;
    this._xAskClose();
    if (yes) a.yes(); else a.no();
  };
  C._xAskClose = function () {
    var a = this._xAsk;
    if (!a) return;
    clearInterval(a.timer);
    this._xAsk = null;
    if (this._victory && this._victory.xask) {
      this._uiHide(this._endCard);
      this._endInfo = null;
      this._victory = this._xAskPrevVictory || null;
    }
    this._xAskPrevVictory = null;
  };

  C._xEndSub = function () {
    if (!X.connected) return 'Opponent left';
    if (X.myRematch) return 'Waiting for opponent...';
    if (X.oppRematch) return 'Opponent wants a rematch';
    return '';
  };

  C._xRefreshEndCard = function () {
    if (!this._xplay || !this._endInfo || !this._endCard) return;
    this._endInfo.sub = this._xEndSub();
    if (!X.connected) this._endInfo.buttons = [];
    this._endCard.dirty = true;
  };

  wrap('_onEndCard', function (orig, a) {
    if (a[0] === 'xask-yes' || a[0] === 'xask-no') {
      this._xAskAnswer(a[0] === 'xask-yes');
      return;
    }
    if (a[0] === 'xrematch') {
      if (this._xplay) X.rematch();
      this._xRefreshEndCard();
      return;
    }
    return orig.apply(this, a);
  });
})(typeof window !== 'undefined' ? window : globalThis);
