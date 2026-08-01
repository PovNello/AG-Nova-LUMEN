# L.U.M.E.N.

**Light & Urban Mapping for Ephemeris Navigation**
An instrument of N.O.V.A. OS · AG Nova Industries

---

## What it is

A free web instrument that answers one question:

> If I stand at this exact spot at this exact time, what will the light be doing?

Not "where is the sun in the sky", which any ephemeris library answers, but whether the light actually **reaches the ground where you intend to stand**, given the buildings around you.

It computes sun and moon positions for any place, date and hour; the full sequence of twilight and golden hour events; and it projects the shadows of real buildings onto the map, live, as you scrub through the day.

No account. No install. No tracking. No cookies.

---

## Getting it running

```bash
# 1. Fetch the pinned third-party libraries into assets/vendor/
node tools/fetch-vendor.mjs

# 2. Serve the project root over HTTP.
#    It must be HTTP, not file:// — ES modules and fetch require an origin.
python -m http.server 8080

# 3. Open http://localhost:8080
```

That is the whole build process. There isn't one.

### Verifying it before you trust it

```bash
node tools/verify-astro.mjs      # ephemerides vs an independent NOAA implementation
node tools/verify-geometry.mjs   # projection, hull, ray casting, exposure scenarios
node tools/verify-wiring.mjs     # markup/module/stylesheet contracts
node tools/verify-contrast.mjs   # perceptual separability of light and shadow
node tools/verify-all.mjs        # runs all verifications
```

All four must pass. See **Verification** below for what they actually prove.

---

## Architecture

Plain HTML, vanilla CSS, vanilla ES modules. No framework, no bundler, no build step, no `node_modules` at runtime. Every third-party file is version-pinned and vendored under `assets/vendor/`.

This is not nostalgia. It is a maintenance decision: a file committed to a repository cannot change under you, and a tool with no build step still runs in ten years.

```
lumen/
├── index.html                  the whole interface
├── assets/
│   ├── css/
│   │   ├── 01-tokens.css       the only place a raw value may appear
│   │   ├── 02-base.css         reset and document defaults
│   │   ├── 03-components.css   shared N.O.V.A. OS hardware vocabulary
│   │   ├── 04-animations.css   all motion. delete it and nothing breaks
│   │   ├── 10-lumen-layout.css instrument shell
│   │   ├── 11-lumen-map.css    overlays, reticle, MapLibre overrides
│   │   ├── 12-lumen-console.css chronometer and telemetry
│   │   └── 13-lumen-responsive.css
│   ├── style/lumen-dark.json   hand-written OpenMapTiles style
│   └── vendor/                 fetched, never committed
├── src/
│   ├── config/services.js      EVERY external URL, in one file
│   ├── core/
│   │   ├── astro.mjs           sun and moon ephemerides, written in-house
│   │   ├── time.mjs            timezone resolution and wall-clock arithmetic
│   │   ├── geometry.mjs        projection, hull, ray casting
│   │   ├── buildings.mjs       surface model extraction and confidence
│   │   ├── exposure.mjs        the daily solar exposure profile
│   │   └── state.mjs           one object, one notification path
│   ├── render/
│   │   ├── map.mjs             MapLibre setup and celestial vectors
│   │   ├── shadows.mjs         the projection engine
│   │   ├── console.mjs         telemetry binding
│   │   └── chronometer.mjs     the 24 hour scrubber
│   └── app.mjs                 wiring only
├── tools/                      fetch and verification harnesses
└── docs/
    ├── COLOUR.md               why the chart paints light and not shadow
    ├── LIMITATIONS.md          what this instrument does not know
    └── VENDOR.lock             what is actually in assets/vendor/
```

### The two work budgets

Everything the interface shows is a pure function of one state object. Two kinds of change are kept strictly apart, because they cost very different amounts:

| | Trigger | Work | Frequency |
|---|---|---|---|
| **TICK** | the chronometer moved | sun and moon position, vectors, shadow redraw | up to 60/s under a thumb, coalesced into one animation frame |
| **SURVEY** | pin, date or building set changed | event times, full exposure profile | deliberate operator action |

Conflating the two is how a slider becomes treacle.

### Why MapLibre and not Leaflet

Leaflet cannot hand you building footprints from its tiles. Using it would force a second network service — Overpass — purely to fetch geometry that is already sitting in memory, on a community instance whose documentation explicitly asks applications not to use it as a backend.

MapLibre is a rendering engine, not an application framework. It draws; it does not dictate the architecture. The rest of the codebase is unaware of it outside `render/map.mjs`.

---

## Dependencies

Three network services, all keyless, and three vendored files.

| Service | Purpose | If it disappears |
|---|---|---|
| **OpenFreeMap** vector tiles | basemap *and* building footprints and heights | change one constant in `src/config/services.js` |
| **OpenFreeMap** glyphs | map label fonts | labels vanish, everything else works |
| **Nominatim** | place name search | search fails, click and GPS still work |

| Vendored | Version | Licence | Why it cannot be avoided |
|---|---|---|---|
| MapLibre GL JS | pinned in `tools/fetch-vendor.mjs` | BSD-3-Clause | the only practical route to building geometry without a second service |
| tz-lookup | pinned | CC0-1.0 | no browser API maps coordinates to a timezone |

Astronomy and geometry have **no** dependencies. Both are written here.

### Recovery, if the tiles stop

OpenFreeMap is a small donation-funded project with no service level agreement. That risk is accepted, and contained:

- Every external URL lives in `src/config/services.js` and nowhere else.
- The tile schema is **OpenMapTiles**, a public standard also served by MapTiler, Stadia, and any self-hosted TileServer GL or Protomaps instance.
- Migrating providers is a change to those constants. Nothing else in the codebase knows where tiles come from.
- Worst case, the planet can be downloaded and self-hosted; the project publishes weekly dumps.

If the map is blank, check that first before assuming the tool is broken.

---

## Verification

The instrument computes its own ephemerides rather than importing a library, so "it looks right on the map" is not evidence of anything. A shadow pointing the wrong way looks entirely plausible in an unfamiliar city.

`tools/verify-astro.mjs` — **38 checks**

- Cross-validated against an **independently written NOAA solar position algorithm**, which reaches the same answer through the equation of time and true solar time rather than sidereal time and right ascension. Different intermediates, different failure modes. Worst disagreement across 42 samples spanning seven sites and six dates: **under 0.01°** in both altitude and azimuth.
- Invariants that must hold by definition: equinox sunrise due east, solar noon altitude equal to 90° minus latitude, solstice declination at the obliquity of the ecliptic, sun due south at noon in the north and due north in the south.
- Event solver self-consistency: every instant labelled "sunrise" is re-evaluated and must place the sun at the sunrise altitude. Error: **exactly zero**, because event times are refined by Newton iteration against the same position function the rest of the tool draws from.
- Polar cases: golden hour that never arrives in Reykjavík in December, astronomical night that never begins in Anchorage in June. Both return `null`, not `Invalid Date`.
- Moon phase against known lunation instants; monotonic phase advance; bounded altitude, bearing and distance over 200 samples.

`tools/verify-geometry.mjs` — **59 checks**

- Mercator round trips, view transform, and the metres-per-pixel constant — including an explicit check that the **512 pixel tile convention** is used, not the 256 pixel figure quoted almost everywhere. Getting that wrong halves or doubles every shadow while leaving it looking plausible.
- The critical bearing test: a sun in the south-east must throw a shadow to the north-west.
- Convex hull, ray/polygon intersection, grazing misses, point-in-polygon.
- Constructed exposure scenarios with known answers: an open field is lit from sunrise to sunset; a tall wall due south removes the middle of the day and leaves light at both ends; a wall to the north blocks the low summer sun but not the winter sun; light decreases monotonically as a wall grows and increases as it recedes; standing inside a footprint yields no direct sun; the whole thing mirrors correctly in the southern hemisphere.

`tools/verify-contrast.mjs` — **23 checks**

The chart paints **light**, not shadow: the ground is dark, sunlit areas take a
warm ivory wash, and shadow is bare ground showing through. This harness reads
the actual palette out of the style file and the tokens, composites it the way
the canvas does, and measures the result in CIE L\* and WCAG contrast ratio.

It exists because v1.0 shipped with a shadow colour identical to the ground
colour — a contrast ratio of exactly 1.000:1, invisible on every street in the
world, and passed by every other test. It checks the perceptual step between lit
and shadowed ground, the evenness of the full six-tone ladder, that the chassis
has not drifted, that every overlay stays legible over both ground states, that
the estimated-height marker remains visible, and that the renderer is still
flooding light rather than filling shadow. Every check was mutation-tested
against the original defect.

`tools/verify-wiring.mjs` — **56 checks**

There is no type checker, so a rename between the markup and the modules produces no error at all — just a readout that quietly never updates. This harness reads both as text and checks they agree: every telemetry field written is present and every field present is written; every control has a handler; every runtime CSS class is defined; the map style contains the layer the shadow engine queries; every host used by the style is declared in `services.js`; the north-up and no-pitch locks are still in place; and the design system rules hold — no raw colours outside the tokens file, no rounded corners, no glow, no gradient fills.

It also checks **itself**. The harnesses are cross-platform code and were not,
at first: filesystem paths were split on `/`, which reported every module in
the project as orphaned when run on Windows. A verification tool that raises
false alarms is worse than none, because the next real failure gets dismissed.

---

## What it does not know

Summarised here, in full in [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md), and shown inside the interface itself rather than buried in a footer.

- **Terrain.** A ridge to the east will delay sunrise by an hour and this tool will not mention it.
- **Vegetation.** No trees, no awnings, no scaffolding.
- **Roof geometry.** Every building is a flat-topped extrusion.
- **Sloping ground.** Shadows are projected onto a horizontal plane at each building's base.
- **Buildings outside the visible chart.** Zoom out to bring more into the calculation.
- **Volunteer height data.** A large share of buildings carry no height at all; one storey is assumed on their behalf. Those buildings are outlined in orange and counted in a confidence figure, because a tool that guesses should say so.

---

## Keyboard

| Key | Action |
|---|---|
| `←` `→` | scrub 10 minutes (hold `Shift` for an hour) |
| `↑` `↓` | next / previous day |
| `N` | jump to now |

---

## Sharing

The address bar is the only persistence. A link encodes position, zoom, date and time, and survives being pasted to somebody else. There is no database, no account and nothing stored on a device.

---

## Licence and attribution

Map data © OpenStreetMap contributors. Tiles by OpenFreeMap, schema by OpenMapTiles. Attribution is displayed in the interface and must remain there.

---

*AG Nova Industries — Creative Exploration Laboratory. Staff count: 1.*
