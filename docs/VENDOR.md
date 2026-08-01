# Vendored dependencies

Everything third-party this instrument uses, why it is here, and what it would
cost to remove it.

Run `node tools/fetch-vendor.mjs` to populate `assets/vendor/`. The script
writes `VENDOR.lock` alongside this file recording the exact bytes fetched.

---

## MapLibre GL JS

**Pinned:** see `tools/fetch-vendor.mjs` · **Licence:** BSD-3-Clause

The map renderer, and more importantly the only practical way to read building
footprints and heights out of vector tiles. `queryRenderedFeatures` returns the
geometry already decoded and in memory.

**Why not Leaflet.** Leaflet renders raster or GeoJSON; it cannot hand you the
contents of a vector tile. Building the shadow engine on Leaflet would require
querying Overpass for every viewport — a second network service, a second
failure mode, and a community instance whose own documentation asks
applications not to use it as a backend. Trading a rendering library for a
network dependency is a bad trade.

**What it does not do.** It does not dictate the application architecture. It
is confined to `src/render/map.mjs`; no other module imports it or knows it
exists.

**Cost to remove:** high. Would require a different vector tile renderer with a
feature query API, or reverting to Overpass.

---

## tz-lookup

**Pinned:** see `tools/fetch-vendor.mjs` · **Licence:** CC0-1.0

Maps a coordinate to an IANA timezone identifier.

**Why it cannot be avoided.** There is no browser API for this. `Intl` will
tell you the offset for a zone at an instant, but nothing in the platform will
tell you which zone a point on the earth is in.

Without it, a pin in Reykjavík shows Bologna's times. That does not throw, does
not look broken, and produces a plan for the wrong hour.

**Optional, in a specific sense.** The tool runs without it and falls back to
the device zone, but displays a persistent warning block rather than pretending.

**Cost to remove:** the tool becomes correct only for pins in the operator's own
timezone. Unacceptable for the stated purpose.

---

## Deliberately NOT vendored

| Not used | Why |
|---|---|
| **SunCalc** | The ephemerides are written in-house in `src/core/astro.mjs`. Roughly 200 lines of standard series that will never change, cross-validated against an independent NOAA implementation to better than 0.01°. Writing them removes an entire class of version-drift bug: SunCalc changed its altitude units and refraction handling between major versions, and a silent unit change in a library that feeds a shadow projection is a trap, not a dependency. |
| **turf.js** | Convex hull and ray/polygon intersection are about eighty lines between them, in `src/core/geometry.mjs`. Importing a general-purpose geospatial suite for two functions is not a saving. |
| **proj4** | The only projection needed is Web Mercator, which is four lines. |
| **A polygon boolean library** | Overlapping shadows are merged by the rasteriser: every silhouette is filled at full opacity on an offscreen canvas, then the whole surface is composited once at a single alpha. The union is free. |
| **Any CSS framework** | The design system is the parent project's. |
| **Any UI framework** | One state object and a subscriber map, in `src/core/state.mjs`. |
| **Any build tool** | There is nothing to build. |

---

## Fonts

Loaded from Google Fonts at runtime: Space Grotesk, Inter Tight, IBM Plex Mono.
System fallbacks are declared for all three, so a blocked or slow font service
degrades to a legible interface rather than an invisible one.

Map label glyphs come from the tile provider and are covered in `services.js`.

---

## Policy

- **Exact versions only.** Never a range, never `latest`.
- **Every URL in one file.** `src/config/services.js` for runtime services,
  `tools/fetch-vendor.mjs` for downloads. Nothing else may hard-code a host.
- **Committed lockfile.** `VENDOR.lock` records the sha256 of each file. If a
  checksum stops matching, something changed that you did not change.
- **New dependencies must justify themselves in this file** before being added,
  including what it would cost to remove them again.
