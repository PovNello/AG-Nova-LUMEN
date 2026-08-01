/* ==========================================================================
   L.U.M.E.N. — CORE / GEOMETRY
   Projection, screen-space maths, convex hull, ray casting.

   No external geometry library. Everything here is a few dozen lines of
   trigonometry that will still compile in twenty years.

   ---------------------------------------------------------------------------
   WHY SCREEN SPACE
   ---------------------------------------------------------------------------
   Shadows could be computed as geodesic offsets in longitude and latitude and
   then handed to the map to project. That is the "correct" approach and it is
   also needlessly slow, because it does the expensive work per vertex per
   frame while the user drags a slider.

   Instead every building footprint is converted ONCE, on extraction, into
   normalised Web Mercator coordinates in the unit square. From then on,
   turning a footprint into pixels is two multiplies and an add. Scrubbing the
   chronometer only changes a single offset vector shared by every building.

   This is valid only while the map is north-up and unpitched, which is why
   rotation and pitch are permanently disabled. See render/map.mjs.
   ========================================================================== */

const RAD = Math.PI / 180;

/* Circumference of the earth at the equator, metres. */
export const EARTH_CIRCUMFERENCE = 40075016.686;

/* MapLibre works in 512 pixel tiles, so the world is 512 * 2^zoom pixels
   across. Every constant below follows from that one fact. */
export const TILE_SIZE = 512;

/* --------------------------------------------------------------------------
   PROJECTION
   -------------------------------------------------------------------------- */

/**
 * Longitude and latitude to normalised Web Mercator, both axes in [0, 1].
 * Origin is the top-left of the world, y increasing southward, which matches
 * screen coordinates and saves a sign flip later.
 */
export function toMercator(lng, lat) {
  const x = (lng + 180) / 360;
  const s = Math.sin(lat * RAD);
  /* Clamp near the poles: Mercator diverges and MapLibre does not render
     there anyway. */
  const clamped = Math.max(-0.9999, Math.min(0.9999, s));
  const y = 0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI);
  return { x, y };
}

/** Inverse of toMercator. */
export function fromMercator(x, y) {
  const lng = x * 360 - 180;
  const n = Math.PI * (1 - 2 * y);
  const lat = Math.atan(Math.sinh(n)) / RAD;
  return { lng, lat };
}

/**
 * The affine transform from normalised Mercator to CSS pixels for the current
 * view. Computed once per frame, applied to every vertex.
 *
 * @param {{lng:number, lat:number}} center  map centre
 * @param {number} zoom
 * @param {number} width   canvas CSS width
 * @param {number} height  canvas CSS height
 */
export function viewTransform(center, zoom, width, height) {
  const worldSize = TILE_SIZE * Math.pow(2, zoom);
  const c = toMercator(center.lng, center.lat);
  return {
    scale: worldSize,
    offsetX: width / 2 - c.x * worldSize,
    offsetY: height / 2 - c.y * worldSize
  };
}

/** Apply a view transform to a normalised Mercator point. */
export function project(mx, my, t) {
  return {
    x: mx * t.scale + t.offsetX,
    y: my * t.scale + t.offsetY
  };
}

/**
 * Ground metres per CSS pixel at a given latitude and zoom.
 *
 * Web Mercator stretches with latitude, so this is not a single number for
 * the whole viewport. It is evaluated per building rather than once for the
 * map centre: the cost is one cosine and it removes a systematic error that
 * would otherwise reach several per cent across a full-screen view at high
 * latitudes.
 */
export function metresPerPixel(lat, zoom) {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * RAD) /
         (TILE_SIZE * Math.pow(2, zoom));
}

/* --------------------------------------------------------------------------
   LOCAL TANGENT PLANE
   For the exposure profile, which reasons about real distances from the pin
   rather than about pixels. Accurate to well under a metre over the couple of
   kilometres this tool ever looks at.
   -------------------------------------------------------------------------- */

const M_PER_DEG_LAT = 111320;

/** Metres east and north of an origin. */
export function toLocalENU(lng, lat, originLng, originLat) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(originLat * RAD);
  return {
    e: (lng - originLng) * mPerDegLng,
    n: (lat - originLat) * M_PER_DEG_LAT
  };
}

/** Bounding box in degrees that encloses a radius in metres about a point. */
export function boundsForRadius(lng, lat, radiusM) {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos(lat * RAD));
  return {
    minLng: lng - dLng, maxLng: lng + dLng,
    minLat: lat - dLat, maxLat: lat + dLat
  };
}

/* --------------------------------------------------------------------------
   CONVEX HULL — Andrew's monotone chain
   -------------------------------------------------------------------------- */

/**
 * Convex hull of a set of {x, y} points, counter-clockwise in screen
 * coordinates. O(n log n).
 *
 * A building footprint and its translated copy do not in general have a
 * convex union, so filling the hull slightly overstates the shadow on
 * L-shaped or U-shaped buildings. The alternative is a full polygon union,
 * which needs a robust boolean library and a great deal of care with
 * degenerate geometry. For a tool whose input heights are frequently guessed
 * to the nearest storey, hull approximation is far from the dominant error.
 * It is documented in LIMITATIONS.md rather than hidden.
 */
export function convexHull(points) {
  const n = points.length;
  if (n < 3) return points.slice();

  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o, a, b) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 &&
           cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 &&
           cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/* --------------------------------------------------------------------------
   RAY CASTING — used by the exposure profile
   -------------------------------------------------------------------------- */

/**
 * Distance from the origin to the nearest intersection of a ray with a closed
 * polygon, or null if the ray misses.
 *
 * Ray starts at (0, 0) and travels along the unit vector (dx, dy).
 * Polygon is a flat array of local ENU coordinates: [e0, n0, e1, n1, ...].
 *
 * If the origin is inside the polygon, returns 0: standing inside a building
 * counts as fully obstructed, which is the physically sensible answer.
 */
export function rayPolygonDistance(dx, dy, poly) {
  let best = Infinity;
  const len = poly.length;

  for (let i = 0; i < len; i += 2) {
    const ax = poly[i];
    const ay = poly[i + 1];
    const bx = poly[(i + 2) % len];
    const by = poly[(i + 3) % len];

    /* Solve  t * (dx, dy) = A + u * (B - A)  for t >= 0 and u in [0, 1] */
    const ex = bx - ax;
    const ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;      /* parallel */

    const t = (ax * ey - ay * ex) / denom;
    if (t < 0) continue;                         /* behind the observer */

    const u = Math.abs(ex) > Math.abs(ey)
      ? (t * dx - ax) / ex
      : (t * dy - ay) / ey;
    if (u < 0 || u > 1) continue;                /* misses the segment */

    if (t < best) best = t;
  }

  return best === Infinity ? null : best;
}

/** Even-odd point-in-polygon test on a flat ENU coordinate array. */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  const len = poly.length;

  for (let i = 0, j = len - 2; i < len; j = i, i += 2) {
    const xi = poly[i],     yi = poly[i + 1];
    const xj = poly[j],     yj = poly[j + 1];
    const intersects = (yi > py) !== (yj > py) &&
                       px < (xj - xi) * (py - yi) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

/* --------------------------------------------------------------------------
   BEARINGS
   -------------------------------------------------------------------------- */

/**
 * Unit vector for a compass bearing in the local east/north frame.
 * 0 = north, 90 = east, clockwise. This is the ONLY place in the codebase
 * that turns a bearing into a direction; see the contract in astro.mjs.
 */
export function bearingToENU(bearingDeg) {
  const r = bearingDeg * RAD;
  return { e: Math.sin(r), n: Math.cos(r) };
}

/**
 * Screen-space unit vector for a compass bearing. y grows downward on a
 * canvas, hence the negated north component.
 */
export function bearingToScreen(bearingDeg) {
  const r = bearingDeg * RAD;
  return { x: Math.sin(r), y: -Math.cos(r) };
}

/** Smallest absolute difference between two bearings, degrees. */
export function bearingDelta(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}
