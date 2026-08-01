#!/usr/bin/env node
/* ==========================================================================
   L.U.M.E.N. — WIRING VERIFICATION
   Run:  node tools/verify-wiring.mjs

   There is no build step and no type checker, which is a deliberate trade:
   the project stays readable and will still run in a decade. The cost is that
   a renaming mistake between the markup and the modules produces no error at
   all — just a readout that quietly never updates.

   This harness closes that gap. It reads index.html and the source tree as
   text and checks that the two agree about:

     - every data-field the console writes to exists in the markup
     - every data-field in the markup is written by something
     - every data-action and data-toggle has a handler
     - every CSS class used in JS is defined in a stylesheet
     - every stylesheet and module referenced by index.html exists on disk
     - the style layer the shadow engine queries exists in the map style

   It is not a substitute for opening the page. It is a substitute for opening
   the page and not noticing.
   ========================================================================== */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;

function ok(label) {
  checks++;
  console.log(`[PASS] ${label}`);
}

function fail(label, detail) {
  checks++;
  failures++;
  console.log(`[FAIL] ${label}`);
  if (detail) console.log(`       ${detail}`);
}

function expect(label, condition, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

function section(t) {
  console.log('\n' + '='.repeat(88) + '\n' + t + '\n' + '='.repeat(88));
}

/* -------------------------------------------------------------------------- */

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor' || name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const sourceFiles = walk(join(ROOT, 'src'));
const cssFiles = walk(join(ROOT, 'assets', 'css'));

const jsText = sourceFiles.map(f => readFileSync(f, 'utf8')).join('\n');
const cssText = cssFiles.map(f => readFileSync(f, 'utf8')).join('\n');

const unique = a => [...new Set(a)];
const matchAll = (text, re) => unique([...text.matchAll(re)].map(m => m[1]));

/* ==========================================================================
   1. REFERENCED FILES EXIST
   ========================================================================== */

section('1. FILES REFERENCED BY index.html');

const localRefs = [
  ...html.matchAll(/(?:href|src)="((?!https?:|\/\/|#)[^"]+)"/g)
].map(m => m[1]);

const missing = localRefs.filter(r => !existsSync(join(ROOT, r)));
const vendorRefs = localRefs.filter(r => r.startsWith('assets/vendor/'));
const nonVendorMissing = missing.filter(r => !r.startsWith('assets/vendor/'));

expect(
  `All ${localRefs.length - vendorRefs.length} non-vendor references resolve`,
  nonVendorMissing.length === 0,
  nonVendorMissing.join(', ')
);

console.log(`       ${vendorRefs.length} vendor reference(s) expected to be`);
console.log('       absent until tools/fetch-vendor.mjs has been run:');
for (const v of vendorRefs) console.log(`         ${v}`);

/* ---------------------------------------------------------------------------
   COVERAGE, THE OTHER DIRECTION

   Checking that every referenced file exists is only half the contract, and
   it is the half that never fails. The half that DOES fail is a stylesheet
   that exists on disk and is never linked: no error, no warning, no missing
   asset in the network panel — just a page rendering with a third of its
   rules absent.

   That happened. 03-components.css and 04-animations.css were written,
   verified, and never linked. The whole component vocabulary was missing, and
   the most visible symptom was the header mark expanding to fill the screen,
   because an SVG with a viewBox and no intrinsic size fills its container.

   Both directions are checked from here on.
   --------------------------------------------------------------------------- */

const cssOnDisk = readdirSync(join(ROOT, 'assets', 'css'))
  .filter(f => f.endsWith('.css'));

const cssLinked = localRefs
  .filter(r => r.startsWith('assets/css/'))
  .map(r => r.split('/').pop());

const unlinkedCss = cssOnDisk.filter(f => !cssLinked.includes(f));

expect(
  `Every stylesheet on disk is linked by index.html (${cssOnDisk.length} files)`,
  unlinkedCss.length === 0,
  'never linked: ' + unlinkedCss.join(', ')
);

/* Load order matters: tokens must come first, or every var() resolves to
   nothing on first paint. */
expect('Tokens are the first stylesheet loaded',
  cssLinked[0] === '01-tokens.css',
  'first is: ' + cssLinked[0]);

/* Same check for modules. An orphaned module is dead code that still passes
   every other test in this file. */
const entry = readFileSync(join(ROOT, 'src', 'app.mjs'), 'utf8');
const reachable = new Set(['app.mjs']);

function follow(file, text) {
  for (const m of text.matchAll(/from\s+'([^']+\.mjs)'/g)) {
    const name = m[1].split('/').pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const found = sourceFiles.find(f => f.endsWith('/' + name));
    if (found) follow(found, readFileSync(found, 'utf8'));
  }
}
follow('app.mjs', entry);

const orphanModules = sourceFiles
  .filter(f => f.endsWith('.mjs'))
  .map(f => f.split('/').pop())
  .filter(f => !reachable.has(f));

expect(
  `Every module is reachable from app.mjs (${reachable.size} reached)`,
  orphanModules.length === 0,
  'orphaned: ' + orphanModules.join(', ')
);

/* ==========================================================================
   2. DATA FIELDS
   ========================================================================== */

section('2. TELEMETRY FIELD BINDINGS');

const htmlFields = matchAll(html, /data-field="([^"]+)"/g);
const jsFields = unique([
  ...matchAll(jsText, /this\.set\('([^']+)'/g),
  ...matchAll(jsText, /this\.setClass\('([^']+)'/g),
  ...matchAll(jsText, /this\.el\.([A-Za-z]+)/g)
]);

const writtenButAbsent = jsFields.filter(f => !htmlFields.includes(f));
const presentButUnwritten = htmlFields.filter(f => !jsFields.includes(f));

expect(
  `Every field written by the console exists in the markup (${jsFields.length} written)`,
  writtenButAbsent.length === 0,
  'written but not in HTML: ' + writtenButAbsent.join(', ')
);

expect(
  `Every field in the markup is written by something (${htmlFields.length} present)`,
  presentButUnwritten.length === 0,
  'in HTML but never written: ' + presentButUnwritten.join(', ')
);

/* ==========================================================================
   3. ACTIONS AND TOGGLES
   ========================================================================== */

section('3. CONTROL BINDINGS');

const htmlActions = matchAll(html, /data-action="([^"]+)"/g);
const jsActions = matchAll(jsText, /^\s*'([a-z-]+)':\s/gm);

const unhandled = htmlActions.filter(a => !jsText.includes(`'${a}'`));
expect(
  `Every data-action has a handler (${htmlActions.length} actions)`,
  unhandled.length === 0,
  'no handler for: ' + unhandled.join(', ')
);

const htmlToggles = matchAll(html, /data-toggle="([^"]+)"/g);
const stateText = readFileSync(join(ROOT, 'src', 'core', 'state.mjs'), 'utf8');
const badToggles = htmlToggles.filter(t => !stateText.includes(t));
expect(
  `Every data-toggle names a real state key (${htmlToggles.length} toggles)`,
  badToggles.length === 0,
  'not in state: ' + badToggles.join(', ')
);

const htmlCollapses = matchAll(html, /data-collapse="([^"]+)"/g);
const badCollapses = htmlCollapses.filter(id => !html.includes(`id="${id}"`));
expect(
  `Every data-collapse points at a real element (${htmlCollapses.length})`,
  badCollapses.length === 0,
  'no such id: ' + badCollapses.join(', ')
);

/* Hooks the modules query for, which must exist in the markup */
const hooks = [
  'data-console', 'data-chrono', 'data-chrono-input', 'data-chrono-track',
  'data-chrono-thumb', 'data-chrono-readout', 'data-chrono-ticks',
  'data-chrono-bands', 'data-chrono-markers', 'data-timeline',
  'data-windows', 'data-exposure-bar', 'data-date-input', 'data-date-label',
  'data-search-form', 'data-status'
];

const missingHooks = hooks.filter(h => !html.includes(h));
expect(
  `All ${hooks.length} structural hooks present in the markup`,
  missingHooks.length === 0,
  'missing: ' + missingHooks.join(', ')
);

expect('Chart container #chart exists', html.includes('id="chart"'));

/* ==========================================================================
   4. CSS CLASSES SET FROM JAVASCRIPT
   ========================================================================== */

section('4. CLASSES APPLIED BY JAVASCRIPT');

/* Class names that JS attaches at runtime and therefore never appear in the
   markup. If one is not defined in a stylesheet, the state it represents is
   invisible to the operator. */
const runtimeClasses = unique([
  ...matchAll(jsText, /classList\.(?:add|toggle|remove)\('([a-z-]+)'/g),
  ...matchAll(jsText, /className = '([a-z- ]+)'/g).flatMap(c => c.split(/\s+/)),
  ...matchAll(jsText, /className = 'lumen-[a-z-]+ ' \+ ([a-z]+)/g).map(() => null)
].filter(Boolean));

const undefinedClasses = runtimeClasses.filter(c => {
  if (!c) return false;
  return !cssText.includes('.' + c);
});

expect(
  `Every runtime class is defined in CSS (${runtimeClasses.length} classes)`,
  undefinedClasses.length === 0,
  'not styled: ' + undefinedClasses.join(', ')
);

/* Template-literal classes need a separate sweep */
const templateClasses = unique([
  ...matchAll(jsText, /class="?(lumen-[a-z_-]+)/g),
  ...matchAll(jsText, /`(lumen-[a-z-]+)__/g)
]);
const undefinedTemplates = templateClasses.filter(c => !cssText.includes('.' + c));
expect(
  'Template-built class names are styled',
  undefinedTemplates.length === 0,
  'not styled: ' + undefinedTemplates.join(', ')
);

/* ==========================================================================
   5. DESIGN SYSTEM COMPLIANCE
   The golden rule of N.O.V.A. OS: no raw values outside the tokens file.
   ========================================================================== */

section('5. DESIGN SYSTEM COMPLIANCE');

const nonTokenCss = cssFiles.filter(f => !f.endsWith('01-tokens.css'));

/* Three documented exceptions, and no others:

     1. The chronometer twilight bands. Opaque tints that exist only here and
        have no meaning anywhere else in the system.
     2. #0a1420, the hard bottom lip under every pressed control. Inherited
        verbatim from the parent system's .nova-key.
     3. The print stylesheet. Paper is white and ink is black; a deep navy
        token is not merely wrong there, it is unreadable. */
let inPrintBlock = false;
let printDepth = 0;
const rawColours = [];

for (const f of nonTokenCss) {
  const text = readFileSync(f, 'utf8');
  inPrintBlock = false;

  for (const line of text.split('\n')) {
    /* Brace counting, not "the next closing brace". A media query contains
       nested rules, each with its own closing brace, so the naive version
       leaves the block on the first nested rule and then reports everything
       after it. */
    if (/@media\s+print/.test(line)) { inPrintBlock = true; printDepth = 0; }
    if (inPrintBlock) {
      printDepth += (line.match(/\{/g) || []).length;
      printDepth -= (line.match(/\}/g) || []).length;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (inPrintBlock) continue;

    const m = /#[0-9a-fA-F]{3,8}\b/.exec(line);
    if (m && !line.includes('lumen-chrono__band') && !line.includes('#0a1420')) {
      rawColours.push(`${f.split('/').pop()}: ${trimmed}`);
    }

    if (inPrintBlock && printDepth <= 0) inPrintBlock = false;
  }
}

expect(
  'No undocumented raw hex colours outside the tokens file',
  rawColours.length === 0,
  rawColours.slice(0, 6).join('\n       ')
);

/* Capture the declared VALUE rather than trying to express "not zero" as a
   lookahead. A negative lookahead after \s* is unreliable, because the star
   backtracks to zero width and the assertion is then tested against the
   space instead of the value. Reading the value and comparing it is both
   correct and obvious. */
const radii = [...cssText.matchAll(/border-radius:\s*([^;}]+)/g)]
  .map(m => m[1].trim())
  .filter(v => !/^0[a-z%]*$/.test(v));

expect('No rounded corners (border-radius is only ever used to remove one)',
  radii.length === 0, radii.join(', '));

expect('No text-shadow (this system has no glow)',
  !/text-shadow:/.test(cssText));

/* Gradients are permitted as structural TEXTURE and forbidden as decorative
   FILL. The distinction is not stylistic hair-splitting:

     texture   the body's faint atmosphere, the machined grid inside a panel,
               the CRT scanline pattern. These are repeating or full-bleed
               and describe a surface.
     fill      a smooth colour ramp across a button or a card. This is the
               SaaS look the design philosophy explicitly rules out.

   Repeating gradients and background-image are texture by construction.
   Anything else painting a plain `background` with a ramp is a fill. */
/* Capture and inspect. NOT a negative lookahead after \s* — that is the
   third time in this file the same trap has come up, so it is worth stating
   plainly: in JavaScript regex, `\s*(?!x)` does not mean "the value is not
   x". The star backtracks to zero width and the assertion is tested against
   the whitespace, which is never x, so the pattern always matches. Read the
   value into a capture group and compare it like a normal person. */
const decorativeGradients = [...cssText.matchAll(/(?:background|background-color):([^;}]+)/g)]
  .map(m => m[1].trim())
  .filter(v => v.includes('gradient') && !v.startsWith('repeating-'));

expect('No gradient fills on controls',
  decorativeGradients.length === 0,
  decorativeGradients.join(' | ').slice(0, 160));

/* ==========================================================================
   6. MAP STYLE CONTRACT
   The shadow engine queries a named style layer. A rename in one place and
   not the other produces no error: just a map with no shadows on it, forever.
   ========================================================================== */

section('6. MAP STYLE CONTRACT');

const style = JSON.parse(readFileSync(join(ROOT, 'assets', 'style', 'lumen-dark.json'), 'utf8'));
const services = readFileSync(join(ROOT, 'src', 'config', 'services.js'), 'utf8');

const declaredLayers = /BUILDING_LAYERS\s*=\s*\[([^\]]+)\]/.exec(services)[1]
  .split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);

const styleLayerIds = style.layers.map(l => l.id);
const orphanLayers = declaredLayers.filter(l => !styleLayerIds.includes(l));

expect(
  `Every queried building layer exists in the style (${declaredLayers.join(', ')})`,
  orphanLayers.length === 0,
  'not in style: ' + orphanLayers.join(', ')
);

for (const id of declaredLayers) {
  const layer = style.layers.find(l => l.id === id);
  expect(`Layer "${id}" reads the building source-layer`,
    layer && layer['source-layer'] === 'building');
}

expect('Style declares a vector source', 
  Object.values(style.sources).some(s => s.type === 'vector'));

expect('Style declares a glyph endpoint', typeof style.glyphs === 'string');

/* Every URL in the style must also be declared in services.js, so that the
   "one file to change providers" promise is actually true. */
const styleJson = JSON.stringify(style);
const styleUrls = unique([...styleJson.matchAll(/https?:\/\/[^"]+/g)].map(m => m[0]));
const undeclared = styleUrls.filter(u => {
  const host = new URL(u.replace(/\{[^}]+\}/g, 'x')).host;
  return !services.includes(host);
});
expect(
  'Every host used by the style also appears in services.js',
  undeclared.length === 0,
  undeclared.join(', ')
);

/* ==========================================================================
   7. THE NORTH-UP LOCK
   The shadow projection is only valid on an unrotated, unpitched map. This is
   the single assumption that, if broken, invalidates everything the tool
   draws while still looking entirely plausible.
   ========================================================================== */

section('7. PROJECTION VALIDITY LOCKS');

const mapText = readFileSync(join(ROOT, 'src', 'render', 'map.mjs'), 'utf8');

for (const lock of [
  ['dragRotate: false', 'drag-rotate disabled'],
  ['pitchWithRotate: false', 'pitch-with-rotate disabled'],
  ['touchPitch: false', 'touch pitch disabled'],
  ['disableRotation()', 'touch and keyboard rotation disabled']
]) {
  expect(`Map lock: ${lock[1]}`, mapText.includes(lock[0]));
}

expect('Map is constructed with bearing 0', /bearing:\s*0/.test(mapText));
expect('Map is constructed with pitch 0', /pitch:\s*0/.test(mapText));

/* ---------------------------------------------------------------------------
   OVERLAY SIZING

   The second failure worth encoding. Overlays project against a width and a
   height; if that pair does not match the map's own, the result is not a
   visibly broken layer but a DISPLACED one — shifted by half the
   discrepancy, and clipped along a clean straight edge. It looks like a
   geometry bug and it is not.

   The rule: every overlay measures the CONTAINER, and the shadow surface
   observes it rather than waiting to be told.
   --------------------------------------------------------------------------- */

const shadowText = readFileSync(join(ROOT, 'src', 'render', 'shadows.mjs'), 'utf8');

expect('Overlay size is measured from the container, not the map canvas',
  /container\.clientWidth/.test(mapText),
  'map.getSize() must not read map.getCanvas()');

expect('getSize does not read the map canvas',
  !/getCanvas\(\)[\s\S]{0,120}clientWidth/.test(mapText));

expect('The shadow surface observes its container',
  shadowText.includes('ResizeObserver') && shadowText.includes('syncSize'));

expect('The shadow surface re-checks its size before drawing',
  /render\([\s\S]{0,900}this\.syncSize\(\)/.test(shadowText));

expect('The shadow surface does not pin its own CSS dimensions',
  !/canvas\.style\.(width|height)\s*=/.test(shadowText),
  'display size must come from CSS inset:0, not inline styles');

const shadowCss = readFileSync(join(ROOT, 'assets', 'css', '11-lumen-map.css'), 'utf8');
expect('Overlays are pinned to the container by CSS',
  /\.lumen-shadow-canvas[\s\S]{0,200}inset:\s*0/.test(shadowCss));

/* ---------------------------------------------------------------------------
   INTRINSIC SIZING OF INLINE SVG

   An SVG with a viewBox and no width/height attribute expands to fill its
   container when CSS is unavailable or fails to load. On a header mark that
   turns a 26 pixel logo into a full-screen one. Cheap to bound, so bound it.
   --------------------------------------------------------------------------- */

const inlineSvgs = [...html.matchAll(/<svg[^>]*>/g)].map(m => m[0]);
const unboundedSvgs = inlineSvgs.filter(tag =>
  tag.includes('viewBox') && !(/\bwidth=/.test(tag) && /\bheight=/.test(tag))
);

expect(`Inline SVGs declare intrinsic dimensions (${inlineSvgs.length} found)`,
  unboundedSvgs.length === 0,
  `${unboundedSvgs.length} SVG(s) would fill their container without CSS`);

/* ==========================================================================
   8. ACCESSIBILITY FLOOR
   ========================================================================== */

section('8. ACCESSIBILITY');

expect('Document declares a language', /<html lang="[a-z]{2}"/.test(html));
expect('A skip link is present', html.includes('nova-skip-link'));
expect('The chronometer has a real range input',
  /type="range"/.test(html));
expect('The chronometer input is labelled',
  html.includes('for="chrono-input"'));
expect('The date input is labelled', html.includes('for="date-input"'));
expect('The search input is labelled', html.includes('for="search-input"'));

const iconOnlyButtons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
  .filter(m => {
    const inner = m[1];
    const hasText = /[A-Z]{2,}/.test(inner.replace(/<[^>]+>/g, ''));
    const hasSrOnly = inner.includes('nova-sr-only');
    const hasLabel = /aria-label=/.test(m[0]);
    const hasTitle = /title=/.test(m[0]);
    return !hasText && !hasSrOnly && !hasLabel && !hasTitle;
  });

expect('Every button has an accessible name',
  iconOnlyButtons.length === 0,
  `${iconOnlyButtons.length} unlabelled button(s)`);

expect('Decorative overlays are hidden from assistive technology',
  mapText.includes("setAttribute('aria-hidden', 'true')"));

/* ==========================================================================
   9. ANIMATION IS A LAYER, NOT A DEPENDENCY
   ========================================================================== */

section('9. MOTION LAYER');

const anim = readFileSync(join(ROOT, 'assets', 'css', '04-animations.css'), 'utf8');
expect('Reduced-motion block present', anim.includes('prefers-reduced-motion'));

const layoutCss = cssFiles
  .filter(f => !f.endsWith('04-animations.css'))
  .map(f => readFileSync(f, 'utf8')).join('\n');

expect('No @keyframes outside the animation layer',
  !/@keyframes/.test(layoutCss.replace(/nova-scanlines-pulse[\s\S]{0,200}/g, '')),
  'motion has leaked into a structural stylesheet');

/* ==========================================================================
   RESULT
   ========================================================================== */

section('RESULT');
console.log(`${checks - failures} passed, ${failures} failed, ${checks} total`);
if (failures > 0) {
  console.log('\nWIRING UNVERIFIED.');
  process.exit(1);
}
console.log('\nWIRING VERIFIED.');
