#!/usr/bin/env node
/**
 * Soft-body unit separation must stay OFF (user directive).
 * Run: node RTSVR6/test-separation.mjs
 */
import assert from 'node:assert/strict';
import {
  UNIT_SEPARATION_RADIUS,
  UNIT_SEPARATION_ACCEL,
  UNIT_CLEARANCE_MIN,
} from './js/config.js';
import { getSeparationCandidateKind } from './js/separation-policy.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const unitsSrc = fs.readFileSync(path.join(root, 'js/units.js'), 'utf8');

console.log('--- soft separation must be disabled ---');

assert.equal(UNIT_SEPARATION_RADIUS, 0);
assert.equal(UNIT_SEPARATION_ACCEL, 0);
assert.equal(UNIT_CLEARANCE_MIN, 0);

assert.equal(
  getSeparationCandidateKind({ id: 'u', hp: 100, state: 'moving' }, 0, 4),
  null,
  'policy never nominates units'
);

assert.ok(
  !unitsSrc.includes('applySeparation('),
  'units.js must not call applySeparation'
);
assert.ok(
  !unitsSrc.includes('UNIT_CLEARANCE_MIN'),
  'units.js must not run ally hard-clearance'
);
assert.ok(
  unitsSrc.includes('no unit↔unit soft-body push') ||
    unitsSrc.includes('no unit') && unitsSrc.includes('soft-body'),
  'updateMovement documents that soft-body push is gone'
);

console.log('✅ test-separation passed (soft-body off)');
