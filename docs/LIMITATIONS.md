# L.U.M.E.N. — Model Limitations

This document is the long form of the panel shown inside the instrument. It exists because a tool that draws confident shadows on top of guessed data, and does not say so, is worse than one that draws nothing.

Nothing here is a defect to be fixed later. These are the boundaries of the model as designed. Where a limitation *could* reasonably be lifted, that is noted.

---

## 1. The surface model

### 1.1 Heights are volunteered, not surveyed

Building geometry and heights come from OpenStreetMap by way of OpenMapTiles vector tiles. A large and highly variable share of buildings carry no height information at all. Coverage is excellent in parts of Germany and the Netherlands, patchy in most of Italy, and close to absent in much of the world.

**What the tool does about it.** Where no usable height exists, one storey — 3.1 m — is assumed. That figure is the convention used across this problem domain, chosen so results are comparable with other tools rather than merely different.

**What makes this instrument different.** Those buildings are outlined in orange on the chart and counted separately in the `SURFACE MODEL` panel, which reports a confidence figure. When confidence is 40%, six shadows in ten are resting on an assumption, and the operator can see that before believing any of them.

### 1.2 Provenance is inferred, not read

The vector tile format carries a height value but **not** where that value came from. It is impossible to read from the tile whether a figure was surveyed, derived from a storey count, or supplied as a schema default.

Provenance is therefore inferred by heuristic, in `src/core/buildings.mjs`:

| Observation | Classified as |
|---|---|
| height above one storey, not a round storey multiple | `MEASURED` — almost certainly a surveyed `height` tag |
| height at or below 3.2 m | `ESTIMATED` — almost certainly a default standing in for missing data |
| storey count present, no height | `MEASURED` — a real observation, but a coarse one |
| nothing at all | `ESTIMATED` |

This is a good heuristic, not a fact. A genuine single-storey building will be misclassified as estimated, which errs towards under-confidence. That is the right direction to be wrong in.

**If the tile provider is ever changed, revisit this function first.** A different schema will populate heights differently and the thresholds will no longer mean what they mean today.

### 1.3 Roofs are flat lids

Every structure is treated as a vertical extrusion of its footprint to a single height. Pitched roofs, domes, spires, setbacks and parapets are not modelled. A church casts the shadow of a box.

### 1.4 Courtyards are ignored

Only the outer ring of each footprint is used. A building with a hole in the middle casts a solid shadow. Handling interior rings would require the polygon boolean operations this design deliberately avoids, for a difference that is invisible at street level.

---

## 2. The shadow projection

### 2.1 Flat ground is assumed

Shadows are projected onto a **horizontal plane at the base of each building**. On level urban ground this is accurate. On a slope it is not: the error grows with the gradient and with the shadow length.

Bologna is fine. San Francisco is not. Perugia and Assisi, notably, are not.

Correcting this properly requires projecting each shadow polygon onto a terrain model, which is a different engine — see §5.

### 2.2 Overlapping footprints use a convex hull

The silhouette a building throws is computed as the convex hull of its footprint and the same footprint translated away from the sun. For a rectangular building this is exact. For an L-shaped or U-shaped building it slightly **overstates** the shadow, filling the notch.

The alternative is a true polygon union, which needs a robust boolean geometry library and a great deal of care with degenerate input. Given that the input heights are frequently guessed to the nearest storey, hull approximation is nowhere near the dominant error.

### 2.3 Only what is on the chart casts a shadow

Buildings outside the visible viewport are not loaded and therefore do not cast shadows into it. A tower two streets beyond the edge of the screen will not darken the spot you are inspecting.

**Mitigation:** zoom out to bring more structures into the calculation, then zoom back in. The same limitation applies to ShadeMap and to every viewport-bounded implementation.

### 2.4 Shadows are switched off below zoom 15

The building layer is not present in the vector tiles at wider zooms. Rather than draw shadows from nothing, the engine disables itself and the console says so.

### 2.5 Grazing incidence is clamped

As the sun approaches the horizon, shadow length tends to infinity. Below 1.5° of altitude, length is clamped to 4 km and the readout is flagged `GRAZING INCIDENCE`. Drawings in that regime are truncated, and the flat-ground assumption has long since stopped holding anyway.

Below 0° no shadows are drawn at all. This is an explicit guard, not an accident of the maths.

### 2.6 Mercator distortion

Shadow length is converted from metres to pixels using the scale at **each building's own latitude**, not at the map centre. Across a full-screen view at high latitude the difference reaches several per cent, and using a single figure would show shadows visibly growing towards one edge of the screen.

Residual distortion within a single building footprint is negligible at city zoom levels.

---

## 3. Time

### 3.1 Timezone resolution can degrade

Coordinate-to-timezone lookup requires a vendored data file. If it failed to load, the tool falls back to the device's own timezone and **displays a warning block**, because every time on screen would otherwise be silently wrong for a foreign pin.

This is the single most dangerous failure mode in the application: it does not throw, it does not look broken, it just produces a plan for the wrong hour. Hence the deliberately loud handling.

### 3.2 Daylight saving transitions

Two edge cases have a fixed, documented policy:

- **Spring forward.** The selected wall-clock time may not exist — 02:30 on a day where the clock jumps from 02:00 to 03:00. The returned instant is the first real moment at or after the requested one.
- **Autumn back.** The selected time may occur twice. The **first** occurrence is used, i.e. the one still on summer time.

Neither case can mislead by more than an hour, on a day when the sun's position barely differs across that hour. The policy is fixed in `src/core/time.mjs` so it is not reinvented elsewhere.

### 3.3 Moving the pin preserves the wall clock

Dropping a pin in a different timezone keeps the **selected local time**, not the absolute instant. Looking at 07:00 in Bologna and then pinning Reykjavík gives 07:00 in Reykjavík.

This is intentional. The operator is planning a morning, not converting a timestamp.

---

## 4. Astronomy

The astronomy is **not** the weak link, and it is worth saying so plainly so that attention stays on the surface model where it belongs.

Positions are computed from standard low-precision astronomical series including nutation and aberration corrections, and cross-checked against an independently written NOAA implementation to better than **0.01°**. Event times are refined by Newton iteration against the position function, so they are exactly self-consistent with everything drawn on the chart.

The residual astronomical error is roughly **one part in ten thousand** of the error introduced by a guessed building height.

Two genuine caveats:

- **Atmospheric refraction** uses a standard-atmosphere model. Real refraction near the horizon varies with temperature and pressure and can shift apparent sunrise by tens of seconds.
- **Moon position** uses a truncated lunar series, accurate to roughly 0.2°. Ample for rise, set, phase and bearing; not suitable for occultation prediction.

---

## 5. Not modelled at all

| Missing | Consequence | Could it be added? |
|---|---|---|
| **Terrain and mountains** | A ridge to the east delays sunrise and the tool will not mention it. Landscape photography beyond flat ground is not served. | Yes. A horizon profile sampled from a DEM would answer "when does the sun clear that ridge" and is a natural next module. |
| **Vegetation** | Trees, hedges and canopy are invisible. In a park, results are meaningless. | Not from open data at useful quality. |
| **Awnings, scaffolding, temporary structures** | Not in OSM, not modelled. | No. |
| **Weather and cloud** | Cloud beats this instrument every time. | Out of scope by design. |
| **Reflected and diffuse light** | The model is binary: a point is in direct sun or it is not. Real shade under a bright sky is still bright. | No. Simulating this is a rendering problem, not a geometry one. |
| **Indoor light** | Windows, apertures and interiors are not modelled. | No. |

---

## 6. What "confidence" actually means

The `MODEL CONFIDENCE` figure is the fraction of loaded buildings whose height was classified as measured. It is a **blunt metric** and is labelled as one.

It does not account for:

- whether the measured heights are themselves correct,
- whether the buildings that matter for *your* pin are the measured ones or the estimated ones,
- missing buildings entirely absent from the map.

A confidence of 80% with the one tower that matters marked estimated is worse than 40% with the relevant block well surveyed. Read the orange outlines on the chart, not just the number.

---

*AG Nova Industries — Creative Exploration Laboratory. Staff count: 1.*
