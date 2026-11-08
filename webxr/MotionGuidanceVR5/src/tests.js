/**
 * The calibration curriculum — 14 halls in 4 chapters, each harder than the last.
 *
 * Participant-facing copy (name, brief, steps) is written for end users.
 * Researcher-facing fields: focus, objective, youDo, weDo, protocol.
 *
 * course: lab-frame 3D route (path.js) — the hall is generated around it.
 * room:   architecture spec (architecture.js). sound: room tone (sfx.js).
 * look:   gaze targets {s, side (+1 left / −1 right), lateral m, height m above path}.
 */
import { Route } from './path.js';

export const CHAPTERS = [
  { id: 1, name: 'Stillness & Glide' },
  { id: 2, name: 'Turning' },
  { id: 3, name: 'Elevation' },
  { id: 4, name: 'Attention' },
];

const RAMP = 2.5;
/** Trial seconds for a route at cruise speed v (cosine ramps included). */
const secs = (route, v) => Math.round((route.s / v + RAMP) * 10) / 10;
const ride = (route, v) => ({ course: { kind: 'ride', route }, trialSec: secs(route, v), trialKind: 'ride' });

const HALL = { type: 'nave', bay: 5, Wo: 8.2, colH: 7.2 };
const ROT = { type: 'rotunda', colH: 7.2 };

/** Descent that ends at floor level: start height = drop of the climb. */
function descent(len, from, to, grade, ease) {
  const drop = -grade * ((to - from) - ease);
  return new Route(drop).straight(len).climb(from, to, grade, ease);
}

export const TESTS = [
  /* ---------------- Chapter 1 · Stillness & Glide ---------------- */
  {
    id: 'C01_still', chamber: '01', chapter: 1,
    name: 'Still Stance',
    brief: 'Stand in the light and hold still while the ring fills.',
    steps: ['Stand in the ring', 'Look ahead', 'Hold still'],
    focus: 'Quiet postural sway', objective: 'Remain still until the floor ring completes.',
    youDo: 'Stand still inside the ring, look straight ahead.', weDo: 'Nothing moves. We record head drift.',
    protocol: 'standing', course: { kind: 'still' }, introSec: 3, trialSec: 12, trialKind: 'still',
    theme: 'still', accent: 0x58d6c6,
    room: { ...ROT, Rc: 8.5, sunEl: 66, feedback: 'steady', exposure: 1.0 },
    sound: { size: 6.5, drone: 55, bright: 520, level: 0.9 },
  },
  {
    id: 'C02_glide', chamber: '02', chapter: 1,
    name: 'First Glide',
    brief: 'A gentle glide down the hall. Keep your head level.',
    steps: ['Face the arch', 'Stay level', 'Arrive'],
    focus: 'Upright stability during forward optic flow', objective: 'Stay upright during a slow straight glide.',
    youDo: 'Stand tall, look down the hall.', weDo: 'Straight 18 m glide at 1.0 m/s with eased start and stop.',
    protocol: 'standing', ...ride(new Route().straight(18), 1.0), introSec: 3,
    theme: 'glide', accent: 0x8ec8ff,
    room: { ...HALL },
    sound: { size: 5.5, drone: 62, bright: 700, level: 0.8 },
  },
  {
    id: 'C03_brisk', chamber: '03', chapter: 1,
    name: 'Brisk Glide',
    brief: 'The same hall, much faster. Stand tall and breathe.',
    steps: ['Stand tall', 'Eyes down the hall', 'Arrive'],
    focus: 'Upright stability at higher speed', objective: 'Stay upright through a fast straight glide.',
    youDo: 'Stand tall. Squeeze the grip to stop completely if you need to.', weDo: 'Straight 36 m at 2.4 m/s.',
    protocol: 'standing', ...ride(new Route().straight(36), 2.4), introSec: 3,
    theme: 'glide', accent: 0xff8f7e,
    room: { ...HALL, colH: 8.2 },
    sound: { size: 6.0, drone: 73, bright: 900, level: 0.75 },
  },

  /* ---------------- Chapter 2 · Turning (seated) ---------------- */
  {
    id: 'C04_curveL', chamber: '04', chapter: 2,
    name: 'Wide Curve Left',
    brief: 'Sit back. As the hall curves left, let your head lean into it.',
    steps: ['Take a seat', 'Lean left with the curve', 'Arrive'],
    focus: 'Seated turn alignment — gentle left', objective: 'Lean into a wide 45° left curve.',
    youDo: 'Sit upright and lean gently into the bend, like a passenger.', weDo: 'R 22 m, 45° left at 1.3 m/s.',
    protocol: 'seated', ...ride(new Route().straight(5).turn(45, 22, 5).straight(5), 1.3), introSec: 3,
    theme: 'turn', accent: 0xb9a4ff,
    room: { ...HALL, feedback: 'lean' },
    sound: { size: 5.5, drone: 49, bright: 600, level: 0.8 },
  },
  {
    id: 'C05_curveR', chamber: '05', chapter: 2,
    name: 'Wide Curve Right',
    brief: 'Now the hall bends right. Lean right with it.',
    steps: ['Take a seat', 'Lean right with the curve', 'Arrive'],
    focus: 'Seated turn alignment — gentle right', objective: 'Lean into a wide 45° right curve.',
    youDo: 'Lean gently into the bend.', weDo: 'R 22 m, 45° right at 1.3 m/s.',
    protocol: 'seated', ...ride(new Route().straight(5).turn(-45, 22, 5).straight(5), 1.3), introSec: 3,
    theme: 'turn', accent: 0x7fe0b0,
    room: { ...HALL, feedback: 'lean' },
    sound: { size: 5.5, drone: 52, bright: 620, level: 0.8 },
  },
  {
    id: 'C06_sbend', chamber: '06', chapter: 2,
    name: 'S-Bend',
    brief: 'Left, then right. Follow each bend with a gentle lean.',
    steps: ['Take a seat', 'Lean left, then right', 'Arrive'],
    focus: 'Lean reversal', objective: 'Lean into a left then right bend.',
    youDo: 'Lean into each bend in turn.', weDo: 'S-bend: 40° left then 40° right, R 16 m, 1.3 m/s.',
    protocol: 'seated', ...ride(new Route().straight(4).turn(40, 16, 4).straight(1).turn(-40, 16, 4).straight(4), 1.3), introSec: 3,
    theme: 'turn', accent: 0x9fb4ff,
    room: { ...HALL, feedback: 'lean' },
    sound: { size: 5.5, drone: 47, bright: 640, level: 0.8 },
  },
  {
    id: 'C07_tight', chamber: '07', chapter: 2,
    name: 'Tight Turn',
    brief: 'A full quarter turn around the colonnade. Lean further in.',
    steps: ['Take a seat', 'Lean into the turn', 'Arrive'],
    focus: 'Seated alignment, tighter radius', objective: 'Lean into a 90° left turn, R 8 m.',
    youDo: 'Lean further than before — the turn is tighter.', weDo: 'R 8 m, 90° left at 1.1 m/s.',
    protocol: 'seated', ...ride(new Route().straight(3).turn(90, 8, 3).straight(3), 1.1), introSec: 3,
    theme: 'turn', accent: 0xffc36e,
    room: { ...ROT, feedback: 'lean', sunEl: 64 },
    sound: { size: 6.5, drone: 51, bright: 560, level: 0.85 },
  },
  {
    id: 'C08_sharp', chamber: '08', chapter: 2,
    name: 'Sharp Turn',
    brief: 'The sharpest turn yet, to the right. Lean right and stay relaxed.',
    steps: ['Take a seat', 'Lean right into the turn', 'Arrive'],
    focus: 'Seated alignment, sharp radius', objective: 'Lean into a 90° right turn, R 5 m.',
    youDo: 'Lean right into the turn.', weDo: 'R 5 m, 90° right at 1.0 m/s.',
    protocol: 'seated', ...ride(new Route().straight(3).turn(-90, 5, 2.5).straight(3), 1.0), introSec: 3,
    theme: 'turn', accent: 0xff7fb2,
    room: { ...ROT, feedback: 'lean', sunEl: 62 },
    sound: { size: 6.5, drone: 46, bright: 540, level: 0.85 },
  },

  /* ---------------- Chapter 3 · Elevation (standing) ---------------- */
  {
    id: 'C09_rise', chamber: '09', chapter: 3,
    name: 'Gentle Ascent',
    brief: 'The walkway rises gently through the hall. Stay upright.',
    steps: ['Stand tall', 'Stay level as you rise', 'Arrive'],
    focus: 'Upright posture on a shallow climb', objective: 'Stay upright on an 8 % ascent.',
    youDo: 'Stand tall and look ahead.', weDo: '8 % grade (≈1.3 m rise) over 28 m at 1.2 m/s.',
    protocol: 'standing', ...ride(new Route().straight(28).climb(4, 24, 0.08, 4), 1.2), introSec: 3,
    theme: 'climb', accent: 0x7fd6ff,
    room: { ...HALL },
    sound: { size: 5.8, drone: 60, bright: 760, level: 0.8 },
  },
  {
    id: 'C10_descent', chamber: '10', chapter: 3,
    name: 'Descent',
    brief: 'You start high above the floor and glide down. Keep your head level.',
    steps: ['Stand tall', 'Stay level going down', 'Arrive'],
    focus: 'Upright posture on a descent', objective: 'Stay upright on a 12 % descent.',
    youDo: 'Stand tall and look ahead.', weDo: '−12 % grade (≈2.2 m drop) over 30 m at 1.2 m/s.',
    protocol: 'standing', ...ride(descent(30, 4, 26, -0.12, 4), 1.2), introSec: 3,
    theme: 'climb', accent: 0xa0e87a,
    room: { ...HALL, colH: 8.2 },
    sound: { size: 6.0, drone: 57, bright: 700, level: 0.8 },
  },
  {
    id: 'C11_climb', chamber: '11', chapter: 3,
    name: 'Steep Climb',
    brief: 'A steep climb up among the arches. Stay upright and relaxed.',
    steps: ['Stand tall', 'Stay upright on the climb', 'Arrive'],
    focus: 'Upright posture on a steep climb', objective: 'Stay upright on a 24 % ascent.',
    youDo: 'Stand tall. Squeeze the grip to stop completely if needed.', weDo: '24 % grade (≈3.4 m rise) over 26 m at 1.1 m/s.',
    protocol: 'standing', ...ride(new Route().straight(26).climb(4, 22, 0.24, 4), 1.1), introSec: 3,
    theme: 'climb', accent: 0xffa36e,
    room: { ...HALL, colH: 8.2 },
    sound: { size: 6.2, drone: 64, bright: 820, level: 0.8 },
  },
  {
    id: 'C12_spiral', chamber: '12', chapter: 3,
    name: 'Spiral Ascent',
    brief: 'Spiral upward under the dome. Lean into the turn as you rise.',
    steps: ['Take a seat', 'Lean in as you climb', 'Arrive'],
    focus: 'Combined turn + climb', objective: 'Lean into a 200° rising left spiral.',
    youDo: 'Lean into the turn and keep your head relaxed.', weDo: 'R 7 m, 200° left, 12 % climb (≈2.4 m) at 1.0 m/s.',
    protocol: 'seated',
    ...ride(new Route().straight(3).turn(200, 7, 3).straight(3).climb(3, 3 + 200 * Math.PI / 180 * 7, 0.12, 4), 1.0),
    introSec: 3,
    theme: 'turn', accent: 0xe0a8ff,
    room: { ...ROT, feedback: 'lean', sunEl: 72 },
    sound: { size: 7.0, drone: 44, bright: 600, level: 0.85 },
  },

  /* ---------------- Chapter 4 · Attention ---------------- */
  {
    id: 'C13_look', chamber: '13', chapter: 4,
    name: 'Look Targets',
    brief: 'Look at each target and hold until its ring fills, about two seconds.',
    steps: ['Fill the left target', 'Fill the right target', 'Face forward'],
    focus: 'Yaw tracking while moving', objective: 'Hold gaze on a left then a right target while gliding.',
    youDo: 'Hold your gaze on each target until its ring fills.', weDo: '22 m glide at 0.9 m/s past two targets.',
    protocol: 'standing', ...ride(new Route().straight(22), 0.9), introSec: 3,
    theme: 'look', accent: 0xf0b866,
    look: {
      dwellSec: 1.8, accuracyDeg: 7,
      targets: [
        { s: 8, side: 1, lateral: 3.0, height: 1.6, label: 'left' },
        { s: 15, side: -1, lateral: 3.0, height: 1.6, label: 'right' },
      ],
    },
    room: { ...HALL },
    sound: { size: 5.6, drone: 58, bright: 650, level: 0.8 },
  },
  {
    id: 'C14_lookud', chamber: '14', chapter: 4,
    name: 'Look Up & Down',
    brief: 'Targets high in the arches and low by the floor. Find each one and hold.',
    steps: ['High on the left', 'Low on the right', 'High on the right', 'Face forward'],
    focus: 'Pitch + yaw tracking while moving', objective: 'Hold gaze on high and low targets while gliding.',
    youDo: 'Look up or down to each target and hold until it fills.', weDo: '26 m glide at 0.9 m/s past three targets.',
    protocol: 'standing', ...ride(new Route().straight(26), 0.9), introSec: 3,
    theme: 'look', accent: 0xff9cc0,
    look: {
      dwellSec: 1.8, accuracyDeg: 7,
      targets: [
        { s: 9, side: 1, lateral: 2.8, height: 5.2, label: 'high_left' },
        { s: 15, side: -1, lateral: 2.4, height: 0.35, label: 'low_right' },
        { s: 22, side: -1, lateral: 2.8, height: 5.6, label: 'high_right' },
      ],
    },
    room: { ...HALL, colH: 8.2 },
    sound: { size: 6.0, drone: 61, bright: 680, level: 0.8 },
  },
];

export function testById(id) {
  return TESTS.find((t) => t.id === id) || TESTS[0];
}

export function chapterOf(t) {
  return CHAPTERS.find((c) => c.id === t.chapter) || CHAPTERS[0];
}

export function chamberDuration(t) {
  return (t.introSec || 0) + (t.trialSec || 0);
}
