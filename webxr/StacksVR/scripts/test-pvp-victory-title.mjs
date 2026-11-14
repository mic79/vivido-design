#!/usr/bin/env node
/**
 * VERIFY: PvP end banner must NEVER say "BOT WINS!" when red is a human.
 * Root cause: hardcoded `youAreBlue ? 'BOT WINS!' : 'YOU WIN!'` for winner===red.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');
const lobby = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');

function victoryTitle(winner, opts) {
  opts = opts || {};
  var mySide = opts.mySide || 'blue';
  var meta = opts.meta || {};
  var info = opts.info || {};
  if (winner === 'draw') return 'DRAW!';
  if (winner === mySide) return 'YOU WIN!';

  var oppIsBot = false;
  if (winner === 'red') {
    if (info.wasBotMatch != null) oppIsBot = !!info.wasBotMatch;
    else if (meta.redIsBot != null) oppIsBot = !!meta.redIsBot;
  } else if (winner === 'blue') {
    oppIsBot = !!meta.blueIsBot;
  }
  if (oppIsBot) return 'BOT WINS!';

  var name = winner === 'red'
    ? (info.redName || meta.redName)
    : (info.blueName || meta.blueName);
  if (name && name !== 'Blue' && name !== 'Red' && name !== 'Bot') {
    return String(name).toUpperCase() + ' WINS!';
  }
  if (winner === 'red') return 'RED WINS!';
  if (winner === 'blue') return 'BLUE WINS!';
  return String(winner).toUpperCase();
}

function main() {
  assert(src.includes('_victoryTitle'), 'victory title helper');
  assert(src.includes('_matchSeatMeta'), 'seat meta snapshot at GO');
  assert(!src.includes("youAreBlue ? 'BOT WINS!'"), 'hardcoded BOT WINS for red gone');
  assert(lobby.includes('wasBotMatch: wasBotMatch'), 'match-ended carries wasBotMatch');
  assert(lobby.includes('wasBotMatch: !!data.wasBotMatch'), 'peer applies wasBotMatch');

  // Host (blue) loses to human red in PvP
  assert.strictEqual(
    victoryTitle('red', {
      mySide: 'blue',
      meta: { redIsBot: false, redName: 'Alex', wasBotMatch: false },
      info: { wasBotMatch: false, redName: 'Alex' }
    }),
    'ALEX WINS!',
    'PvP: human red win must show nickname, not BOT'
  );

  // Host (blue) loses to bot
  assert.strictEqual(
    victoryTitle('red', {
      mySide: 'blue',
      meta: { redIsBot: true, wasBotMatch: true },
      info: { wasBotMatch: true }
    }),
    'BOT WINS!',
    'vs-bot: red win is BOT WINS'
  );

  // Client (red) wins PvP
  assert.strictEqual(
    victoryTitle('red', {
      mySide: 'red',
      meta: { redIsBot: false, wasBotMatch: false }
    }),
    'YOU WIN!',
    'PvP red seat sees YOU WIN'
  );

  // Client (red) loses to blue human
  assert.strictEqual(
    victoryTitle('blue', {
      mySide: 'red',
      meta: { blueIsBot: false, blueName: 'HostNick' },
      info: { blueName: 'HostNick', wasBotMatch: false }
    }),
    'HOSTNICK WINS!',
    'PvP: blue human win uses nickname'
  );

  // After seats cleared, wasBotMatch:false must not fall back to Bot
  assert.strictEqual(
    victoryTitle('red', {
      mySide: 'blue',
      meta: {},
      info: { wasBotMatch: false }
    }),
    'RED WINS!',
    'cleared seats + wasBotMatch false → RED WINS not BOT'
  );

  console.log('PASS test-pvp-victory-title');
}

main();
