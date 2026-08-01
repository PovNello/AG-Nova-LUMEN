# Agent briefing — L.U.M.E.N.

Context for an AI assistant working on this repository. Read this before
touching anything. Symlink or copy as `CLAUDE.md` / `GEMINI.md` as needed.

---

## What this is

An instrument of N.O.V.A. OS, the fictional operating system of AG Nova
Industries — a one-person creative exploration laboratory. The fiction is real
in the sense that it governs every design decision; the tool underneath is a
genuine, working solar and lunar planning instrument for photographers.

Both halves matter. A change that makes it more useful but breaks the voice is
a bad change. So is the reverse.

---

## Hard rules

1. **No build step. Ever.** Plain HTML, vanilla CSS, vanilla ES modules. If a
   proposed change requires a bundler, a transpiler or a framework, the answer
   is no. Propose something else.

2. **No new dependency without justifying it in `docs/VENDOR.md`**, including
   what it would cost to remove it again. The current count is two, and both
   are argued for in writing.

3. **No raw values outside `assets/css/01-tokens.css`.** No hex colour, font
   stack, spacing value or duration anywhere else. `tools/verify-wiring.mjs`
   enforces this and will fail the build.

4. **The map stays north-up and unpitched.** `bearing: 0`, `pitch: 0`, rotation
   and pitch gestures disabled. This is a correctness requirement, not a
   preference: the shadow engine projects in screen space, which is only valid
   for an unrotated orthographic view. Re-enabling either gesture silently
   invalidates every shadow while leaving the map looking fine.

5. **Every external URL lives in `src/config/services.js`.** Nowhere else.

6. **All four verification harnesses must pass** before anything ships:
   ```
   node tools/verify-astro.mjs
   node tools/verify-geometry.mjs
   node tools/verify-wiring.mjs
   node tools/verify-contrast.mjs
   ```

7. **The chart paints LIGHT, never shadow.** There is no shadow colour. The
   ground is dark, sunlit areas get a warm wash, and shadow is bare ground
   showing through. If you are adding a `--lumen-shadow` token, read
   `docs/COLOUR.md` first — v1.0 did exactly that and shipped shadows with a
   contrast ratio of 1.000:1.

8. **On the chart, buildings are DARKER than the ground.** Inverted relative
   to a normal dark basemap, deliberately: the ground is the stage that
   shadows are drawn on and needs headroom above it, while buildings are the
   solid masses doing the casting.

9. **Motion is a layer.** Deleting `04-animations.css` must leave a fully
   functional static instrument.

---

## Aesthetic law

Starfield Constellation / NASA-punk. A **civilian exploration console**, not a
military command centre and not a cyberpunk terminal.

**Never:** rounded corners, soft shadows, glow, `text-shadow`, gradient fills
on controls, green terminal text, large empty hero sections, marketing CTAs.

**Always:** chamfered corners via `clip-path`, structural borders, matte
surfaces, dense monospace data, low-contrast secondary information, mechanical
press feedback (travel down, lose the bottom lip, gain an inner shadow).

Colour is **semantic and not interchangeable**:

| Token | Means | Used for |
|---|---|---|
| `--nova-cyan` | alive and operating | live telemetry, the sun vector, sunlit exposure |
| `--nova-cyan-bright` | look here now | one or two things per screen. the reticle, the clock |
| `--nova-orange` | in progress / warning | estimated heights, golden hour, sunrise/sunset bearings |
| `--nova-ivory` | knowledge / archive | N.O.V.A.'s voice, the moon |
| `--nova-danger` | genuine failure only | never decorative |
| `--lumen-light` | sunlight on the chart | the wash painted over sunlit ground and roofs |

Roughly 80% structure and text, 15% ivory, 5% cyan and orange combined. If
everything is cyan it reads as generic UI.

---

## N.O.V.A.'s voice

Any text signed `N.O.V.A.` is written by the ship's intelligence: third person,
clinical, precise, quietly unimpressed by the captain's decisions but never
disrespectful. She documents rather than editorialises, and the humour is dry
and structural rather than jokey.

She is **not** a chirpy assistant. She does not use exclamation marks. She does
not say "oops".

Example, from the limitations panel — match this register:

> The surface model beneath this projection was assembled from volunteer
> cartography. It is generous, uneven, and in places openly imaginative. Where
> a structure declined to state its height, one storey has been assumed on its
> behalf, and the resulting shadow has been drawn with the same confidence as
> every other, because the renderer has no vocabulary for doubt. The interface
> does. Attend to the orange outlines.

---

## Where things live

| To change | Edit |
|---|---|
| any colour, font, spacing, duration | `assets/css/01-tokens.css` |
| ephemeris maths | `src/core/astro.mjs` — then rerun `verify-astro` |
| shadow projection | `src/render/shadows.mjs` and `src/core/geometry.mjs` |
| height inference or confidence | `src/core/buildings.mjs` |
| exposure profile | `src/core/exposure.mjs` |
| timezone behaviour | `src/core/time.mjs` |
| map appearance | `assets/style/lumen-dark.json` |
| tile or geocoder provider | `src/config/services.js` |
| what the instrument admits it cannot do | `docs/LIMITATIONS.md` and the panel in `index.html` |

---

## Traps that have already been hit once

Recorded so they are not hit again.

- **The 512 pixel tile convention.** MapLibre's world is `512 * 2^zoom` pixels
  across, so its zoom 16 equals the more commonly quoted 256-pixel zoom 17. The
  figure "1.688 m/px at zoom 16, latitude 45" that appears everywhere online is
  for 256 pixel tiles. Using it halves every shadow while looking plausible.

- **Sidereal time constants.** The widely copied `280.16` is about 0.3° adrift
  — roughly 75 seconds of time. It partly cancels against an equally rough
  solar longitude, which is why it survives in short code snippets, but it
  becomes the dominant error the moment the solar coordinates are computed
  properly. Use the full IAU GMST series, which this codebase does.

- **Negative lookahead after `\s*` in JavaScript regex.** `\s*(?!x)` does not
  mean "the value is not x". The star backtracks to zero width and the
  assertion is tested against the whitespace. Capture the value and compare it.

- **Azimuth conventions.** Astronomical azimuth is measured from south,
  increasing westward. Everything outside `astro.mjs` uses compass bearings.
  There is exactly one conversion function. Do not write another.

- **Timezone is a property of an instant, not of a zone.** Rome is +60 in
  January and +120 in July. Code that caches one offset per zone breaks twice a
  year.

---

## Deferred by design

Not forgotten, not blocked, deliberately out of scope for v1:

- terrain and mountain shadows
- horizon obstruction correction to sunrise and sunset
- shoot-alignment search ("when is the sun on this bearing")
- tree canopy, roof geometry, augmented reality, weather

The code is structured so these can be added without a rewrite: the astronomy,
obstruction and rendering layers are separate, and a second obstruction source
can join the first.

Do not add them unprompted.

---

## Post-v1.0 fixes, and what they taught

Two bugs shipped in v1.0. Both are recorded here because neither looked like
what it was, and both are now guarded by `tools/verify-wiring.mjs`.

### 1. Two stylesheets were never linked

`03-components.css` and `04-animations.css` existed, were correct, and were
absent from `index.html`. No error, no warning, no missing asset — just a page
rendering without its entire component vocabulary.

The visible symptom was a **full-screen logo**, because an inline SVG with a
`viewBox` and no intrinsic `width`/`height` expands to fill its container when
the CSS that sizes it is missing.

**Guards added:** every stylesheet on disk must be linked; tokens must load
first; every module must be reachable from `app.mjs`; inline SVGs must declare
intrinsic dimensions.

**Lesson:** checking that every reference resolves is the half that never
fails. Check the other direction too.

### 2. Overlays sized from the map canvas instead of the container

`resize()` read the MapLibre canvas size — stale at boot, before the canvas had
grown to fill its container — sized the shadow surface from it, pinned that
size inline, and only then resized the map. Nothing re-synchronised afterwards.

One mistake, two symptoms, neither resembling a sizing problem:

- the surface was shorter than the map, so shadows were **clipped along a
  clean horizontal line** with nothing drawn below it;
- `viewTransform` centres on `height / 2`, so a stale height displaced every
  shadow **upward by half the discrepancy** — a plausible offset with no error
  anywhere to find.

**Fixed by:** measuring the container rather than the canvas, observing it with
a `ResizeObserver`, letting CSS `inset: 0` own the displayed size, and
re-checking in `render()`.

**Guards added:** `getSize` must not read `getCanvas()`; the shadow layer must
use a `ResizeObserver`; it must re-check before drawing; it must not set inline
canvas dimensions.

**Lesson, first attempt:** have both surfaces measure the same element rather
than passing the size between them.

**That lesson was wrong.** See below.

### 2b. The same bug, second occurrence — two clocks

The v1.1 fix had both overlays measure the container independently: the vector
layer through `map.getSize()`, the shadow layer through its own
`ResizeObserver`. Two measurements, taken at two different moments, equal only
by luck.

They drifted, and the shadow wash again covered only the upper portion of the
chart with a clean horizontal cut, displaced upward by half the difference —
while the vectors sat perfectly placed beside it. It looked like broken
geometry, not like a sizing fault, for the second time.

**The correct lesson:** do not make the measurement more reliable. Make there
be only one. `app.paintOverlays()` now reads `chart.getSize()` **once per
frame** and hands the identical pair to both layers. `ShadowLayer` no longer
touches the DOM at all; its `ResizeObserver` only requests a redraw and
decides nothing.

Coverage was additionally made independent of any remembered number: the flood
and the clear both operate in device pixels across the canvas's own backing
store, so a partial wash is no longer expressible.

**Guards added:** the shadow layer must not read `clientWidth`/`clientHeight`;
`render()` must take explicit dimensions; the flood must target
`buffer.width`/`buffer.height`; and `chart.getSize()` must appear exactly once
in `app.mjs`. All mutation-tested.

**The general rule, now stated properly:** when two things must agree on a
coordinate system, shared state is not the problem — *duplicated derivation*
is. One reader, many consumers.

### Both guards are mutation-tested

Each new check was verified by reintroducing the original defect and confirming
the harness fails. A check that passes but would not have caught the bug is
worse than no check, because it is reassuring.


### 3. Shadows were invisible on open ground

Shipped in v1.0. The shadow fill colour was `--nova-space` `#08111B`; the map's
ground colour was also `#08111B`. Contrast ratio **1.000:1** — painting a
colour onto itself.

Shadows appeared to work only because they were visible where they fell on
buildings, which were lighter than the ground. On streets and squares, the one
place the tool is asked about, there was nothing.

Darkening was not an option either: at L\* 4.8 the ground was 1.4 points from
absolute black. The bottom of the scale was spent.

**Fixed by inverting the whole model** — see `docs/COLOUR.md`. Ground raised to
mid-scale, buildings pushed below it, and the renderer flipped from filling
shadows to flooding light and erasing shadows out of it. Result: 12.4 L\* of
separation, with the chassis untouched.

**Guard added:** `tools/verify-contrast.mjs`, 23 checks, reading the real
palette from the real files.

**Lesson:** a visual system has numeric contracts. "Does it look right" is not
a test, least of all against a dark palette, where the eye adapts and two or
three L\* of difference can seem present when it is not there at all. If two
tones must be distinguishable, measure the distance between them.

### 4. The verification harness itself was not portable

Reported on Windows: **every module in the project listed as orphaned.**

Nothing was wrong with the project. `verify-wiring.mjs` was splitting
filesystem paths on `'/'`. On Windows `join()` emits backslashes, so
`split('/')` returned the whole path and every comparison failed.

Two symptoms, one cause:

- the module traversal stopped after `app.mjs`'s direct imports, because the
  file lookup never matched — hence "10 reached" instead of 11, with
  `geometry.mjs` (imported only indirectly) never visited;
- the orphan list printed full Windows paths instead of filenames, which is
  what made it obvious in hindsight and invisible at first glance.

**The distinction that matters.** Two kinds of string look alike:

| | Separator | Split on `/`? |
|---|---|---|
| **web paths** — `index.html` refs, import specifiers | always `/`, by spec | yes — use `urlName()` |
| **filesystem paths** — anything from `join()` | platform | never — use `fileName()` |

`fileName` is a one-argument wrapper around `basename` on purpose:
Node's `basename` takes an optional second `suffix` argument, so mapping it
over an array hands it the index and throws.

**Guards added:** the tools now scan themselves for `split('/')` on
filesystem-path variables and for bare mapping of `basename`; and the
traversal asserts it reached every module on disk, so a broken walk reports
itself as a walk fault rather than as a structural one.

**Two things worth carrying forward.**

A source-scanning check that contains the string it searches for will find
itself. The first version of the `basename` guard failed on its own regex
literal, then on its own doc comment. Build such patterns at runtime and skip
comment lines.

And more importantly: **a verification tool that cries wolf is worse than no
tool**, because the next genuine failure gets waved away. The harnesses are
now verified too.


### 5. The canvas is a replaced element — the actual root cause

Symptom, reported across three revisions: the sunlight wash covered only the
top-left portion of the chart, sometimes described as "only the top half",
sometimes "only the left half", **sometimes entirely correct**, and it changed
with browser zoom. The vector layer was always right.

Every earlier fix addressed a real but secondary fault (stale canvas size in
v1.0, duplicated measurement in v1.1) and none of them touched the cause.

**The cause.** `position: absolute; inset: 0` stretches an ordinary element to
fill its containing block. It does **not** stretch a REPLACED element — canvas,
img, video, svg with intrinsic dimensions. For those, CSS resolves the used
width from the element's intrinsic size and then resolves the over-constrained
`left`/`right` pair by discarding one.

A canvas's intrinsic size is its **backing store**: the `width` and `height`
attributes. Those are set to `container x devicePixelRatio`, the standard
recipe for a crisp canvas. So:

| devicePixelRatio | canvas laid out at | visible fraction |
|---|---|---|
| 1 | container size | 100% — looks perfect |
| 1.5 | 1.5x container | 67% |
| 2 | 2x container | **50% wide, 50% tall — top-left quarter** |

Browser zoom changes the device pixel ratio, so the visible fraction changed
with zoom. That is the entire "random" behaviour.

**The tell was in the stylesheet all along.** The vector layer carried
`width: 100%; height: 100%` and never showed the fault. The canvas did not.
Two overlays, same positioning, one correct — the asymmetry was the answer.

**Fixed by** declaring explicit dimensions on both overlays in
`11-lumen-map.css`, plus inline CSS-pixel sizing in `syncSize()` as defence in
depth if the stylesheet fails to load.

**A guard actively caused harm here.** v1.1 added a check asserting *"the
shadow surface does not pin its own CSS dimensions"*, on the reasoning that
stylesheets own layout and JavaScript should not interfere. Sound for ordinary
elements, wrong for replaced ones. That check did not merely fail to catch the
bug — **it forbade the fix**, and it was mutation-tested, so it looked
trustworthy.

**Lessons.**

1. A canvas has two sizes: the backing store in device pixels, and the display
   box in CSS pixels. Both must be set. Setting only one is a bug that a 1x
   display will hide from you completely.
2. When one of two near-identical components works, diff them before
   theorising. The `width: 100%` on the SVG was visible in the same six lines
   of CSS the whole time.
3. Mutation testing proves a guard fires. It cannot prove the guard is
   asserting something true. A wrong invariant, well tested, is a locked door
   in front of the fix.
