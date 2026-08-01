#!/usr/bin/env node
/* ==========================================================================
   L.U.M.E.N. — CONTRAST VERIFICATION
   Run:  node tools/verify-contrast.mjs

   ---------------------------------------------------------------------------
   WHY THIS EXISTS
   ---------------------------------------------------------------------------
   v1.0 shipped with shadows that were mathematically invisible on open
   ground. The shadow colour and the map's ground colour were the same value,
   #08111B, so the contrast ratio between "lit" and "shadowed" was exactly
   1.000:1.

   Nothing caught it. Every other harness passed. The code was correct, the
   geometry was correct, the compositing was correct, and the result was a
   perfectly accurate rendering of nothing.

   The lesson is that a visual system has numeric contracts too, and "does it
   look right" is not a test — especially not against a dark palette, where
   the eye adapts and a difference of two or three L* can seem present when
   it is not there at all.

   This harness reads the real palette out of the real files and measures it.
   ========================================================================== */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

/* --------------------------------------------------------------------------
   COLOUR SCIENCE

   Two measures, because they answer different questions:

     contrast ratio (WCAG)  how reliably two tones can be told apart. Built
                            for text legibility, but the underlying question
                            is the same: is there a perceptible step here.

     L* (CIE lightness)     perceptually uniform lightness, 0 to 100. The
                            useful one for judging whether a LADDER of tones
                            is evenly spaced, which raw luminance cannot show
                            because it is wildly non-linear near black.

   The second matters more here. Near black, a large relative change in
   luminance is a small perceptual change, which is exactly the trap v1.0
   fell into.
   -------------------------------------------------------------------------- */

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

const linearise = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const luminance = h => {
  const [r, g, b] = hex(h).map(linearise);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const lightness = h => {
  const y = luminance(h);
  return y <= 0.008856 ? 903.3 * y : 116 * Math.cbrt(y) - 16;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/** Composite src over dst at alpha, the way the canvas does. */
const composite = (dst, src, alpha) => {
  const d = hex(dst);
  const s = hex(src);
  return '#' + d
    .map((c, i) => Math.round((s[i] * alpha + c * (1 - alpha)) * 255)
      .toString(16).padStart(2, '0'))
    .join('');
};

/* -------------------------------------------------------------------------- */

function check(label, actual, min, unit = '') {
  checks++;
  const pass = actual >= min;
  if (!pass) failures++;
  console.log(
    `[${pass ? 'PASS' : 'FAIL'}] ${label.padEnd(54)} ` +
    `${actual.toFixed(2).padStart(7)}${unit}  min ${min}${unit}`
  );
}

function assert(label, cond, detail) {
  checks++;
  if (!cond) failures++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
  if (!cond && detail) console.log(`       ${detail}`);
}

function section(t) {
  console.log('\n' + '='.repeat(92) + '\n' + t + '\n' + '='.repeat(92));
}

/* ==========================================================================
   READ THE ACTUAL PALETTE FROM THE ACTUAL FILES
   Not a copy. If the style file and this harness disagree, the harness is
   wrong by definition.
   ========================================================================== */

const style = JSON.parse(
  readFileSync(join(ROOT, 'assets', 'style', 'lumen-dark.json'), 'utf8')
);

const tokens = readFileSync(join(ROOT, 'assets', 'css', '01-tokens.css'), 'utf8');
const shadowSrc = readFileSync(join(ROOT, 'src', 'render', 'shadows.mjs'), 'utf8');

const layerColour = id => {
  const l = style.layers.find(x => x.id === id);
  if (!l) return null;
  const p = l.paint || {};
  const c = p['background-color'] || p['fill-color'] || p['line-color'];
  return typeof c === 'string' ? c : null;
};

const token = name => {
  const m = new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens);
  return m ? m[1] : null;
};

const GROUND = layerColour('background');
const BUILDING = layerColour('building-fill');
const WATER = layerColour('water');
const ROAD_MINOR = layerColour('road-minor');
const ROAD_MAJOR = layerColour('road-major');
const LIGHT = token('lumen-light');
const CHASSIS = token('nova-space');

const ALPHA = parseFloat(/LIGHT_ALPHA\s*=\s*([\d.]+)/.exec(shadowSrc)[1]);

console.log('L.U.M.E.N. contrast verification');
console.log(`  ground     ${GROUND}   L*=${lightness(GROUND).toFixed(1)}`);
console.log(`  building   ${BUILDING}   L*=${lightness(BUILDING).toFixed(1)}`);
console.log(`  light wash ${LIGHT}   alpha=${ALPHA}`);

/* Derived states — what the operator actually sees */
const GROUND_LIT = composite(GROUND, LIGHT, ALPHA);
const GROUND_SHADED = GROUND;
const ROOF_LIT = composite(BUILDING, LIGHT, ALPHA);
const BUILDING_SHADED = BUILDING;

/* ==========================================================================
   1. THE CONTRACT THAT v1.0 BROKE
   ========================================================================== */

section('1. LIT GROUND vs SHADOWED GROUND — the reason this file exists');

assert(
  'The light wash is not the same colour as the ground',
  LIGHT.toLowerCase() !== GROUND.toLowerCase(),
  'painting a colour onto itself is a no-op'
);

const deltaL = lightness(GROUND_LIT) - lightness(GROUND_SHADED);
const ratio = contrast(GROUND_LIT, GROUND_SHADED);

console.log(`       shadowed ground  ${GROUND_SHADED}  L*=${lightness(GROUND_SHADED).toFixed(1)}`);
console.log(`       sunlit ground    ${GROUND_LIT}  L*=${lightness(GROUND_LIT).toFixed(1)}`);

/* 8 L* is roughly the point at which a large flat area reads as a different
   tone at arm's length on a phone in a dim room. Below that it becomes a
   "is that a shadow or a JPEG artefact" judgement, which is not a readout. */
check('Sunlit vs shadowed ground, perceptual step', deltaL, 8, ' L*');
check('Sunlit vs shadowed ground, contrast ratio', ratio, 1.3, ' : 1');

/* ==========================================================================
   2. THE TONAL LADDER
   Every surface the operator must distinguish, in order, with the gaps
   between them measured.
   ========================================================================== */

section('2. TONAL LADDER');

const ladder = [
  ['building in shadow', BUILDING_SHADED],
  ['ground in shadow  ', GROUND_SHADED],
  ['building roof lit ', ROOF_LIT],
  ['ground sunlit     ', GROUND_LIT],
  ['road minor (lit)  ', composite(ROAD_MINOR, LIGHT, ALPHA)],
  ['road major (lit)  ', composite(ROAD_MAJOR, LIGHT, ALPHA)]
].sort((a, b) => lightness(a[1]) - lightness(b[1]));

let previous = null;
let minGap = Infinity;

for (const [name, colour] of ladder) {
  const l = lightness(colour);
  const gap = previous === null ? null : l - lightness(previous);
  if (gap !== null) minGap = Math.min(minGap, gap);
  console.log(
    `       ${name}  ${colour}  L*=${l.toFixed(1).padStart(5)}` +
    (gap === null ? '' : `   step +${gap.toFixed(1)}`)
  );
  previous = colour;
}

check('Smallest step in the tonal ladder', minGap, 4, ' L*');

assert('Buildings are darker than the ground they cast onto',
  lightness(BUILDING) < lightness(GROUND),
  'a shadow instrument needs the ground as its mid-tone stage, with the ' +
  'building mass below it and sunlight above');

/* ==========================================================================
   3. THE CHASSIS IS UNTOUCHED
   The whole point of the inversion was to gain contrast WITHOUT lightening
   the interface. If the chassis has drifted, the fix has become a redesign.
   ========================================================================== */

section('3. CHASSIS UNCHANGED');

assert('Page background is still the original deep navy',
  CHASSIS.toUpperCase() === '#08111B',
  `found ${CHASSIS}`);

assert('The map ground sits above the chassis void',
  lightness(GROUND) > lightness(CHASSIS),
  'the chart must read as a lit surface inside a dark instrument');

const frameStep = lightness(GROUND) - lightness(CHASSIS);
check('Chart reads as distinct from its frame', frameStep, 6, ' L*');

/* The chart must not be so bright that it stops being a night instrument. */
assert('Sunlit ground stays below L* 45 (still a dark chart)',
  lightness(GROUND_LIT) < 45,
  `sunlit ground is L*=${lightness(GROUND_LIT).toFixed(1)}`);

/* ==========================================================================
   4. VECTORS STAY READABLE OVER BOTH STATES
   The sun vector, the moon vector and the reticle are drawn on top of ground
   that may be lit or shadowed. They must survive both.
   ========================================================================== */

section('4. OVERLAY LEGIBILITY OVER BOTH GROUND STATES');

const overlays = [
  ['sun vector    ', token('nova-cyan-bright')],
  ['moon vector   ', token('nova-ivory')],
  ['boundary lines', token('nova-orange')],
  ['reticle       ', token('nova-cyan-bright')]
];

for (const [name, colour] of overlays) {
  const onLit = contrast(colour, GROUND_LIT);
  const onShade = contrast(colour, GROUND_SHADED);
  const worst = Math.min(onLit, onShade);
  console.log(`       ${name} ${colour}  on lit ${onLit.toFixed(2)}  on shadow ${onShade.toFixed(2)}`);
  check(`  ${name.trim()} worst-case contrast`, worst, 3, ' : 1');
}

/* ==========================================================================
   5. THE ESTIMATED-HEIGHT MARKER MUST REMAIN VISIBLE
   It is the honesty signal. If it disappears against the new ground, the
   instrument stops disclosing which shadows rest on a guess.
   ========================================================================== */

section('5. HONESTY MARKER');

const footprint = token('lumen-footprint');
const orange = token('nova-orange');

check('Estimated-height outline against lit ground',
  contrast(orange, GROUND_LIT), 2, ' : 1');
check('Estimated-height outline against building mass',
  contrast(orange, BUILDING), 3, ' : 1');
check('Measured-height outline is distinguishable from ground',
  contrast(footprint, GROUND), 1.25, ' : 1');

assert('The two outline colours are clearly different from each other',
  contrast(orange, footprint) > 1.8,
  'a viewer must be able to tell a guessed building from a surveyed one');

/* ==========================================================================
   6. THE ENGINE ACTUALLY PAINTS LIGHT
   A palette that measures well is worthless if the renderer reverted to
   filling shadows.
   ========================================================================== */

section('6. RENDERER PAINTS LIGHT, NOT SHADOW');

/* The flood must cover the buffer's own backing store, in device pixels,
   rather than a cached CSS-pixel size. A cached size that goes stale produces
   a wash that stops partway down the chart along a crisp horizontal line —
   which reads as a broken shadow engine rather than as a sizing fault. */
assert('Buffer is flooded across its whole backing store before cutting',
  /fillRect\(0, 0, this\.buffer\.width, this\.buffer\.height\)/.test(shadowSrc),
  'coverage must be a property of the canvas, not of a remembered number');

assert('Silhouettes are erased, not filled',
  shadowSrc.includes("'destination-out'"));

assert('Composite happens once, at a single alpha',
  (shadowSrc.match(/globalAlpha = LIGHT_ALPHA/g) || []).length === 1);

assert('Roofs are restored after the shadows are cut',
  shadowSrc.includes('visibleBuildings') &&
  /source-over[\s\S]{0,600}visibleBuildings/.test(shadowSrc));

assert('No shadow colour survives in the renderer',
  !/colours\.shadow/.test(shadowSrc),
  'shadow is the absence of the wash, not a colour');

assert('Sun below the horizon paints nothing',
  /sunAltitude <= 0[\s\S]{0,200}night: true/.test(shadowSrc));

/* ==========================================================================
   RESULT
   ========================================================================== */

section('RESULT');
console.log(`${checks - failures} passed, ${failures} failed, ${checks} total`);
if (failures > 0) {
  console.log('\nCONTRAST UNVERIFIED. The chart may be unreadable.');
  process.exit(1);
}
console.log('\nCONTRAST VERIFIED. Light and shadow are perceptually separable.');
