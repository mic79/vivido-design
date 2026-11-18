// discord.js — Dotmination as a Discord Activity.
//
// Discord loads the game in an iframe on <client_id>.discordsays.com and adds
// ?instance_id=…&frame_id=…&platform=… to the URL. Inside that iframe every network
// request must go through Discord's proxy (URL mappings set in the Developer Portal),
// so we patch fetch/WebSocket to the mapped paths, and we pair the two players by the
// Activity instance: everyone who joins the same Activity session shares instanceId.
// Matchmaking (script.js) tries that Activity room first, then the public lobbies
// shared with the web game, the app and DotminationVR (crossplay).
//
// Outside Discord this module does nothing.
import { DiscordSDK, patchUrlMappings } from '../lib/discord-sdk.mjs';

// Discord Developer Portal → Dotmination → OAuth2 → Client ID
const DISCORD_CLIENT_ID = '1572602198703997048';

const params = new URLSearchParams(window.location.search);
const inDiscord = params.has('frame_id') && params.has('instance_id');

if (inDiscord) {
  // Same prefixes as the URL mappings in the Developer Portal (Activities → URL Mappings)
  patchUrlMappings([
    { prefix: '/peerjs', target: '0.peerjs.com' },
    { prefix: '/turn', target: 'dotmination-turn-proxy.odd-bird-4c2c.workers.dev' },
  ]);

  const sdk = new DiscordSDK(DISCORD_CLIENT_ID);
  const instanceId = sdk.instanceId || params.get('instance_id') || '';
  // PeerJS ids allow [A-Za-z0-9_-]; keep it short but unique per Activity session
  let h = 0;
  for (let i = 0; i < instanceId.length; i++) h = (Math.imul(h, 31) + instanceId.charCodeAt(i)) >>> 0;
  const room = (instanceId.replace(/[^A-Za-z0-9]/g, '').slice(-12) + h.toString(36)).toLowerCase();

  window.DOT_DISCORD = { sdk, instanceId, room, platform: params.get('platform') || 'desktop', ready: false };
  document.documentElement.classList.add('in-discord');

  // "Only play with people in this call" toggle (index.html, multiplayer start options).
  // Off by default: matchmaking checks this Activity first, then the public crossplay lobbies.
  const initFriendsToggle = () => {
    const box = document.getElementById('dcFriendsOnly');
    if (!box) return;
    try { box.checked = localStorage.getItem('dotDiscordFriendsOnly') === '1'; } catch (e) {}
    box.addEventListener('change', () => {
      try { localStorage.setItem('dotDiscordFriendsOnly', box.checked ? '1' : '0'); } catch (e) {}
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFriendsToggle);
  else initFriendsToggle();

  sdk.ready()
    .then(() => {
      window.DOT_DISCORD.ready = true;
      console.log('[Discord] Activity ready, room', room);
    })
    .catch((err) => console.warn('[Discord] SDK ready failed', err));
}
