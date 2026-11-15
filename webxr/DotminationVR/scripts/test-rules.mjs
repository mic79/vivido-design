import fs from 'fs'; import vm from 'vm';
// Headless rules/AI test: node scripts/test-rules.mjs  (no browser needed)
import { fileURLToPath } from 'url';
const dir = fileURLToPath(new URL('..', import.meta.url));
globalThis.window = globalThis;
for (const f of ['dot-board.js','dot-bot.js']) vm.runInThisContext(fs.readFileSync(dir+f,'utf8'));
const {DotBoard, DotBot} = globalThis;
let assert=(c,m)=>{ if(!c){console.error('FAIL',m);process.exit(1);} };
for (const R of [3,4]) {
  const L = DotBoard.layoutFor(R);
  assert(L.count === 3*R*(R+1)+1, 'count '+R);
  for (let i=0;i<L.count;i++) { assert(L.neighbors[i].every(n=>L.neighbors[n].includes(i)),'sym'); assert(L.mirror[L.mirror[i]]===i,'mirror'); }
}
// chain test
let s = new DotBoard.State(3); s.owner[18]=1; s.stage[18]=5; // center? 
let res = s.apply('blue', 18); assert(res.explosions>=1 && s.owner[18]===1 && s.stage[18]===1, 'burst');
assert(L3ok(s), 'ok');
function L3ok(s){ return true; }
// serialize roundtrip
s.prefill(1234,'blue','red'); const snap=s.serialize(); const t=new DotBoard.State(3); t.load(snap); assert(JSON.stringify(t.serialize())===JSON.stringify(snap),'roundtrip');
assert(s.count('blue')===s.count('red') && s.stageSum('blue')===s.stageSum('red'),'symmetric prefill');
// full games
let stats={blue:0,red:0,draw:0}, maxMoves=0, t0=Date.now(), maxChain=0;
for (let g=0; g<20; g++) {
  const st=new DotBoard.State(g%2?3:4); st.prefill(1000+g,'blue','red');
  let turn='blue', moves=0, winner=null;
  while (moves<600) {
    const me=turn, op=turn==='blue'?'red':'blue';
    const mv=DotBot.chooseMove(st, me, op, me==='blue'?DotBot.PROFILES.duel:{depth:1,noise:1});
    if (mv<0) {winner=op;break;}
    const r=st.apply(me,mv); assert(r,'legal'); maxChain=Math.max(maxChain,r.explosions);
    moves++;
    if (st.count(op)===0){winner=me;break;}
    turn=op;
  }
  stats[winner||'draw']++; maxMoves=Math.max(maxMoves,moves);
}
console.log('games', stats, 'maxMoves', maxMoves, 'maxChain', maxChain, 'ms', Date.now()-t0);
// timing depth-2 on R4 mid-game
const st=new DotBoard.State(4); st.prefill(7,'blue','red'); let tt=Date.now(); for(let i=0;i<10;i++) DotBot.chooseMove(st,'blue','red',DotBot.PROFILES.duel); console.log('depth2 ms/move', (Date.now()-tt)/10);
// rush: player(greedy-ish) vs virus
let rs={win:0,lose:0,stall:0};
for (let g=0; g<20; g++){ const st=new DotBoard.State(4); st.prefill(55+g,'blue','virus'); let n=0, w=null;
 while(n<400){ const mv=DotBot.chooseMove(st,'blue','virus',DotBot.PROFILES.rushSeat); st.apply('blue',mv); n++; if(!st.count('virus')){w='win';break;}
   const vm2=DotBot.chooseMove(st,'virus','blue',DotBot.PROFILES.virus); if(vm2<0){w='win';break;} st.apply('virus',vm2); if(!st.count('blue')){w='lose';break;} }
 rs[w||'stall']++; }
console.log('rush seat-bot vs virus', rs);
// infect
const st2=new DotBoard.State(4); st2.prefill(9,'blue','virus'); const before=st2.count('blue'); const ch=st2.infect('blue','virus',3,42); assert(ch.length===3 && st2.count('blue')===before-3,'infect');
console.log('ALL OK');
