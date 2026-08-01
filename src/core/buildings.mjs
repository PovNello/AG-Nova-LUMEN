/* ==========================================================================
   L.U.M.E.N. — CORE / BUILDINGS
   Surface model extraction, height inference and confidence accounting.

   ---------------------------------------------------------------------------
   WHERE THE GEOMETRY COMES FROM
   ---------------------------------------------------------------------------
   Not from an API call. The buildings are already on screen: the vector tiles
   the map is rendering contain the footprints and their heights, and MapLibre
   will hand them over through queryRenderedFeatures.

   The alternative — querying Overpass for a bounding box — would mean a
   second network service, a second failure mode, and leaning on a community
   instance that explicitly asks applications not to use it as a backend.
   Reading what is already in memory costs nothing and cannot rate-limit us.

   ---------------------------------------------------------------------------
   THE HONESTY PROBLEM
   ---------------------------------------------------------------------------
   OpenStreetMap building heights are volunteered, and a large share of
   buildings carry no height at all. Every tool in this space silently
   substitutes a default and draws a confident shadow on top of a guess.

   L.U.M.E.N. substitutes the same default, because there is nothing better to
   do, and then says so. Estimated buildings are marked in the interface and
   counted in a confidence figure. That disclosure is the feature.
   ========================================================================== */

import { toMercator, toLocalENU, EARTH_CIRCUMFERENCE } from './geometry.mjs';

/* --------------------------------------------------------------------------
   CONSTANTS
   -------------------------------------------------------------------------- */

/* Assumed height of a single storey, metres. Also the fallback for a building
   with no height information whatsoever. 3.1 m is the convention used across
   this problem domain; keeping the same figure makes results comparable with
   other tools rather than merely different. */
export const STOREY_HEIGHT_M = 3.1;

/* Below this zoom the building layer is not present in the vector tiles at
   all, so shadows are switched off rather than silently drawn from nothing. */
export const MIN_SHADOW_ZOOM = 15;

/* Hard ceiling on the number of footprints processed in one pass. Reached
   only in very dense cities at wide zoom. When it bites, the interface says
   so instead of quietly truncating. */
export const MAX_BUILDINGS = 4000;

/* Any tile height at or below this is treated as a schema default rather than
   a surveyed value. See the note in LIMITATIONS.md: vector tiles do not carry
   provenance, so this threshold is a heuristic, and it is labelled as one. */
const DEFAULT_HEIGHT_SENTINEL = 3.2;

export const CONFIDENCE = {
  MEASURED: 'MEASURED',
  ESTIMATED: 'ESTIMATED'
};

/* --------------------------------------------------------------------------
   EXTRACTION
   -------------------------------------------------------------------------- */

/**
 * Pull the building set for the current viewport out of the map.
 *
 * @param {maplibregl.Map} map
 * @param {string[]} layerIds  the style layers that carry building polygons
 * @returns {{buildings:Array, stats:Object}}
 */
export function extractBuildings(map, layerIds) {
  const zoom = map.getZoom();

  if (zoom < MIN_SHADOW_ZOOM) {
    return {
      buildings: [],
      stats: emptyStats({ belowZoom: true, zoom })
    };
  }

  let features;
  try {
    features = map.queryRenderedFeatures({ layers: layerIds });
  } catch (e) {
    /* The layer may not exist yet during style load. Not an error worth
       surfacing to the operator; the next idle event will retry. */
    return { buildings: [], stats: emptyStats({ zoom }) };
  }

  const buildings = [];
  const seen = new Set();

  let measured = 0;
  let estimated = 0;
  let truncated = false;

  for (const f of features) {
    if (buildings.length >= MAX_BUILDINGS) {
      truncated = true;
      break;
    }

    /* Vector tiles clip features at tile edges, so one building can arrive
       two or three times. Projecting it twice would darken its shadow and
       skew the confidence count. */
    const key = featureKey(f);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }

    const height = inferHeight(f.properties);
    if (height.confidence === CONFIDENCE.MEASURED) measured++;
    else estimated++;

    const rings = collectRings(f.geometry);
    for (const ring of rings) {
      const prepared = prepareRing(ring);
      if (!prepared) continue;
      buildings.push({
        height: height.metres,
        base: height.base,
        confidence: height.confidence,
        ...prepared
      });
    }
  }

  const total = measured + estimated;

  return {
    buildings,
    stats: {
      total,
      measured,
      estimated,
      confidence: total > 0 ? measured / total : 0,
      truncated,
      belowZoom: false,
      zoom
    }
  };
}

function emptyStats(extra) {
  return {
    total: 0, measured: 0, estimated: 0, confidence: 0,
    truncated: false, belowZoom: false, zoom: 0, ...extra
  };
}

function featureKey(f) {
  if (f.id !== undefined && f.id !== null) return `i${f.id}`;
  const p = f.properties || {};
  if (p.osm_id !== undefined) return `o${p.osm_id}`;
  return null;
}

/* --------------------------------------------------------------------------
   HEIGHT INFERENCE
   -------------------------------------------------------------------------- */

/**
 * Best available height for a footprint, plus how much to trust it.
 *
 * The OpenMapTiles schema exposes render_height, populated from the OSM
 * height and building:levels tags with a fallback. Critically, the tile does
 * NOT record which of those it used. So provenance has to be inferred, and
 * the inference is a heuristic:
 *
 *   - A height that is not a whole number of storeys almost certainly came
 *     from a surveyed `height` tag.
 *   - A height at or below one storey is almost certainly the schema default
 *     standing in for missing data.
 *   - Anything else came from building:levels, which is a real observation
 *     but a coarse one, and is counted as measured.
 *
 * If the tile source is ever swapped, revisit this function first.
 */
export function inferHeight(props = {}) {
  const raw = firstNumber(
    props.render_height,
    props.height,
    props['building:height']
  );

  const base = firstNumber(props.render_min_height, props.min_height) || 0;

  if (raw === null || !isFinite(raw) || raw <= 0) {
    const levels = firstNumber(props.levels, props['building:levels']);
    if (levels !== null && levels > 0) {
      return {
        metres: levels * STOREY_HEIGHT_M,
        base,
        confidence: CONFIDENCE.MEASURED
      };
    }
    return {
      metres: STOREY_HEIGHT_M,
      base,
      confidence: CONFIDENCE.ESTIMATED
    };
  }

  if (raw <= DEFAULT_HEIGHT_SENTINEL) {
    return { metres: raw, base, confidence: CONFIDENCE.ESTIMATED };
  }

  return { metres: raw, base, confidence: CONFIDENCE.MEASURED };
}

function firstNumber(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (isFinite(n)) return n;
  }
  return null;
}

/* --------------------------------------------------------------------------
   GEOMETRY PREPARATION
   -------------------------------------------------------------------------- */

function collectRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') {
    /* Outer ring only. Courtyards do not meaningfully change a shadow
       silhouette and handling them would require the polygon union this
       design deliberately avoids. */
    return geometry.coordinates.length ? [geometry.coordinates[0]] : [];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates
      .map(poly => poly[0])
      .filter(Boolean);
  }
  return [];
}

/**
 * Convert a lng/lat ring into the flat, normalised Mercator form the renderer
 * consumes, and record the centroid latitude so the shadow length can be
 * scaled correctly for this building rather than for the map centre.
 *
 * Done ONCE per extraction. Per-frame work is then a multiply and an add per
 * vertex, which is what keeps the chronometer smooth.
 */
function prepareRing(ring) {
  const n = ring.length;
  if (n < 3) return null;

  const merc = new Float64Array(n * 2);
  let sumLat = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const lng = ring[i][0];
    const lat = ring[i][1];
    const m = toMercator(lng, lat);
    merc[i * 2] = m.x;
    merc[i * 2 + 1] = m.y;
    sumLat += lat;
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.x > maxX) maxX = m.x;
    if (m.y > maxY) maxY = m.y;
  }

  return {
    merc,
    lngLat: ring,
    centroidLat: sumLat / n,
    bbox: { minX, minY, maxX, maxY }
  };
}

/* --------------------------------------------------------------------------
   NEIGHBOURHOOD SELECTION — for the exposure profile
   -------------------------------------------------------------------------- */

/**
 * Buildings within `radiusM` of a point, converted into a local east/north
 * frame in metres. The exposure profile reasons about real distances, not
 * pixels, so it needs a different representation from the renderer.
 *
 * A cheap bounding-box rejection runs first; only survivors get the full
 * per-vertex conversion.
 */
export function neighbourhood(buildings, lng, lat, radiusM) {
  const origin = toMercator(lng, lat);

  /* Radius expressed in normalised Mercator units.
     Mercator x spans the full equatorial circumference over [0, 1], and the
     projection is conformal, so a single figure serves both axes: one metre
     of ground at latitude phi occupies 1 / (C * cos phi) units, and the
     radius in units is therefore radiusM / (C * cos phi). */
  const cosLat = Math.cos(lat * Math.PI / 180);
  const r = radiusM / (EARTH_CIRCUMFERENCE * Math.max(cosLat, 1e-6));

  const out = [];

  for (const b of buildings) {
    if (b.bbox.maxX < origin.x - r || b.bbox.minX > origin.x + r) continue;
    if (b.bbox.maxY < origin.y - r || b.bbox.minY > origin.y + r) continue;

    const ring = b.lngLat;
    const poly = new Float64Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      const p = toLocalENU(ring[i][0], ring[i][1], lng, lat);
      poly[i * 2] = p.e;
      poly[i * 2 + 1] = p.n;
    }

    out.push({ poly, height: b.height, base: b.base });
  }

  return out;
}
