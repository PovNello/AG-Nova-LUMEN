# Colour and contrast

Why the chart looks the way it does, and the one decision that must not be
undone by accident.

Enforced by `tools/verify-contrast.mjs`, which reads the real palette out of
the real files and measures it. Run it after touching any colour.

---

## The rule

**The instrument paints light. It does not paint shadow.**

There is no shadow colour anywhere in this codebase. The chart's ground is
dark; sunlit areas receive a warm ivory wash; and shadow is simply ground the
wash never reached.

If you find yourself adding a `--lumen-shadow` token, stop and read on.

---

## What went wrong in v1.0

The blueprint specified that shadow should be drawn in `--nova-space`, with
this reasoning:

> Shadow is the absence of light, therefore structure, not an accent. Spends
> none of the 5% accent budget.

Elegant, and wrong. `--nova-space` is `#08111B`, and the map's ground colour
was **also** `#08111B`.

```
lit ground        #08111B    L* = 4.8
shadowed ground   #08111B    L* = 4.8
contrast ratio    1.000 : 1
```

Painting a colour onto itself is a no-op. On open ground — a street, a piazza,
precisely where a photographer needs the answer — the shadow was not faint. It
was absent.

It appeared to work only because shadows falling on *buildings* were visible,
buildings then being 10.8 L\* lighter than the ground. The one place the tool
was asked about was the one place it said nothing.

**Nor could it be fixed by darkening.** At L\* 4.8 the ground was 1.4 points
from absolute black. There was no dynamic range left underneath it.

---

## The three changes

### 1. The ground was raised to mid-scale

`#08111B` → `#152A42`, from L\* 4.8 to L\* 16.5.

The ground is the stage. Everything happens on it, so it needs room both above
and below: room below for nothing at all, as it turns out, and room above for
sunlight.

The **chassis is untouched**. The page background, the panels, the header and
the console are identical to v1.0. Only the chart's ground plane moved, which
is why the instrument does not read as having been lightened.

### 2. The tonal hierarchy was inverted

Buildings went from *lighter* than the ground to *darker*: `#16283C` → `#0B1725`.

A normal dark basemap makes buildings glow as volumes above a black void. For
a shadow instrument that is backwards. The city should read as **solid mass**
— the thing casting — sitting below the surface being cast upon.

### 3. The renderer flipped sign

The offscreen buffer is flooded with the wash at full opacity, silhouettes are
**erased** from it with `destination-out`, and the result is composited once at
a single alpha.

Overlap semantics survive the inversion for free: erasing the same pixel twice
erases it once, which is exactly the union behaviour overlapping shadows
require. Still no polygon-union library.

Roofs are painted back after the cut. The swept hull necessarily contains the
footprint, so the erase step removes the roof along with the shadow — and in
plan view a roof under open sky is the brightest surface on screen, not a
shadowed one. Restoring it is what makes buildings read as dark masses with lit
lids.

---

## The measured ladder

Every surface the eye must separate, in order:

| Surface | Colour | L\* | Step |
|---|---|---|---|
| building in shadow | `#0B1725` | 7.4 | — |
| ground in shadow | `#152A42` | 16.5 | +9.2 |
| building roof, lit | `#2F363C` | 22.2 | +5.6 |
| ground, sunlit | `#374654` | 29.0 | +6.8 |
| minor road, lit | `#435665` | 35.6 | +6.6 |
| major road, lit | `#4E6678` | 42.0 | +6.4 |

**Lit versus shadowed ground: 12.4 L\*, ratio 1.50:1.** From 0.0 and 1.00:1.

The steps are deliberately even. A ladder with one large gap and several tiny
ones reads as two groups rather than six levels.

---

## Why ivory and not white

`--lumen-light` is `#DCCFAA`, the palette's knowledge-and-warmth accent.

Pure white reads as a screen artefact: a blown highlight, a selection overlay,
something the interface did. A warm off-white reads as light falling on a
surface, which is what it is meant to be. It also ties the chart to the brand
without printing a logo on it.

---

## Why not a light theme

It was considered seriously and rejected for three reasons, in order of weight:

1. **The console stays dark.** A white map welded to a navy terminal reads as
   two interfaces stitched together, not as a chart inside an instrument.
   Making it cohere would mean lightening everything, which discards the
   identity the project exists to express.
2. **It fixes the problem by accident.** Shadows become visible because a pale
   background happens to have headroom, not because the relationship between
   light and shadow was designed. The inversion designs it.
3. **It forecloses the next idea.** A warm wash whose colour tracks solar
   altitude — amber at grazing incidence, cold white at noon — only works on a
   dark ground. On paper white it reads as a stain.

**One caveat, honestly stated.** Outdoors at dawn, screen glare destroys the
bottom of the tonal scale, and the first ten to fifteen L\* effectively cease
to exist. This instrument is built to be used in the street.

The answer is not a light theme but a **high-ambient mode**: a switch that
raises the ground and strengthens the wash, affecting the chart alone. Real
field instruments have exactly this, for exactly this reason. Deferred, not
dismissed.

---

## Changing colours safely

- The authoritative map palette lives in `assets/style/lumen-dark.json`. A JSON
  style sheet cannot read CSS variables, so `--lumen-ground` and
  `--lumen-building` in `01-tokens.css` are **reference copies**. Change both.
- Run `node tools/verify-contrast.mjs` afterwards. It checks the perceptual
  step, the whole ladder, chassis drift, overlay legibility over both ground
  states, the visibility of the honesty marker, and that the renderer is still
  painting light rather than shadow.
- Every check in that harness has been mutation-tested: the original defect was
  reintroduced and the harness confirmed to fail. A check that passes but would
  not have caught the bug is worse than no check, because it reassures.
