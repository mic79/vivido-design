#!/usr/bin/env node
/**
 * Separation candidate / stagger regression tests.
 * Run: node RTSVR4/test-separation.mjs
 */
import assert from 'node:assert/strict';
import { UNIT_SEPARATION_CONTACT_STAGGER } from './js/config.js';
import { getSeparationCandidateKind } from './js/separation-policy.js';

function unit(partial) {
  return {
    id: 'u1',
    hp: 100,
    type: 'rifleman',
    state: 'idle',
    targetPos: null,
    path: null,
    _sepInContact: false,
    ...partial,
  };
}

console.log('--- separation candidates ---');

assert.equal(
  getSeparationCandidateKind(unit({ state: 'moving' }), 0, 4),
  'mover',
  'moving unit is always a mover candidate'
);

assert.equal(
  getSeparationCandidateKind(unit({ state: 'attacking', targetPos: { x: 1, z: 1 } }), 0, 4),
  'mover',
  'chasing attacker is a mover candidate'
);

assert.equal(
  getSeparationCandidateKind(unit({ state: 'attacking', targetPos: null, path: [] }), 0, 4),
  null,
  'stationary firing unit skips separation'
);

assert.equal(
  getSeparationCandidateKind(unit({ type: 'harvester', state: 'harvesting' }), 0, 4),
  null,
  'harvesting harvester skips'
);

assert.equal(
  getSeparationCandidateKind(unit({ state: 'idle', _sepInContact: false }), 0, 4),
  null,
  'idle with no contact is skipped'
);

const idleContact = unit({ id: 'idle_a', state: 'idle', _sepInContact: true });
let contactHits = 0;
for (let f = 0; f < 16; f++) {
  if (getSeparationCandidateKind(idleContact, f, 4) === 'contact') contactHits++;
}
assert.ok(contactHits >= 3 && contactHits <= 5, `stagger ~1/4 over 16 frames, got ${contactHits}`);

assert.ok(UNIT_SEPARATION_CONTACT_STAGGER >= 2 && UNIT_SEPARATION_CONTACT_STAGGER <= 8);

console.log('✅ test-separation passed');
