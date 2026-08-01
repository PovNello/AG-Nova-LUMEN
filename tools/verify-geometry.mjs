/* ==========================================================================
   L.U.M.E.N. — GEOMETRY AND EXPOSURE VERIFICATION
   Run:  node tools/verify-geometry.mjs

   The shadow engine cannot be checked by looking at it: a shadow pointing the
   wrong way looks entirely plausible on an unfamiliar map. So the projection
   maths and the obstruction test are exercised here against constructed
   scenarios whose answers are known from first principles.
   ========================================================================== */

import {
  toMercator, fromMercator, viewTransform, project, metresPerPixel,
  convexHull, rayPolygonDistance, pointInPolygon,
  bearingToENU, bearingToScreen, toLocalENU, TILE_SIZE
} from '../src/core/geometry.mjs';

import { computeExposure, STATE, SAMPLE_MINUTES } from '../src/core/exposure.mjs';
import { getSunPosition, getSunTimes } from '../src/core/astro.mjs';
import { inferHeight, CONFIDENCE, STOREY_HEIGHT_M } from '../src/core/buildings.mjs';

let failures = 0, checks = 0;

function check(label, actual, expected, tol, unit = '') {
  checks++;
  const d = Math.abs(actual - expected);
  const ok = d <= tol;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(56)} got ${fmt(actual)}${unit} exp ${fmt(expected)}${unit} d=${fmt(d)}`);
}

function assert(label, cond) {
  checks++;
  if (!cond) failures++;
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}`);
}

function fmt(n) {
  return (Math.abs(n) < 1000 ? n.toFixed(4) : n.toFixed(1)).padStart(10);
}

function section(t) {
  console.log('\n' + '='.repeat(96) + '\n' + t + '\n' + '='.repeat(96));
}

/* ==========================================================================
   1. PROJECTION
   ========================================================================== */

section('1. WEB MERCATOR PROJECTION');

for (const [lng, lat] of [[0, 0], [11.3426, 44.4949], [-149.9, 61.2], [151.2, -33.9]]) {
  const m = toMercator(lng, lat);
  const back = fromMercator(m.x, m.y);
  check(`Round trip lng ${lng}`, back.lng, lng, 1e-9);
  check(`Round trip lat ${lat}`, back.lat, lat, 1e-9);
}

const origin = toMercator(0, 0);
check('Null island maps to the centre of the world, x', origin.x, 0.5, 1e-12);
check('Null island maps to the centre of the world, y', origin.y, 0.5, 1e-12);

assert('Northern latitudes map to smaller y (north is up)',
  toMercator(0, 45).y < toMercator(0, 0).y);
assert('Eastern longitudes map to larger x',
  toMercator(10, 0).x > toMercator(0, 0).x);

/* Metres per pixel: at zoom 0 with 512 px tiles, the equator spans 512 px */
check('Metres per pixel at equator, zoom 0',
  metresPerPixel(0, 0), 40075016.686 / TILE_SIZE, 1e-6);
check('Metres per pixel halves with each zoom level',
  metresPerPixel(45, 15) * 2, metresPerPixel(45, 14), 1e-9);

/* A pinned figure, and a trap worth naming.

   The number quoted everywhere for "zoom 16 at latitude 45" is 1.688 m per
   pixel. That figure assumes 256 pixel tiles, which is the Leaflet and Google
   convention. MapLibre uses 512 pixel tiles, so its world is twice as wide in
   pixels at the same zoom number and the resolution is half: 0.844.

   In other words a MapLibre zoom of 16 shows the same scale as a Leaflet zoom
   of 17. Plugging the wrong constant in here would halve or double every
   shadow in the tool while leaving it looking perfectly plausible. */
check('Metres per pixel at lat 45, zoom 16 (512 px tiles)',
  metresPerPixel(45, 16), 0.8445, 0.001);
check('512 px convention is exactly half the 256 px convention',
  metresPerPixel(45, 16) * 2,
  40075016.686 * Math.cos(45 * Math.PI / 180) / (256 * Math.pow(2, 16)), 1e-9);

/* View transform must put the map centre at the canvas centre */
const t = viewTransform({ lng: 11.3426, lat: 44.4949 }, 16, 800, 600);
const c = toMercator(11.3426, 44.4949);
const centreScreen = project(c.x, c.y, t);
check('Map centre projects to canvas centre, x', centreScreen.x, 400, 1e-6);
check('Map centre projects to canvas centre, y', centreScreen.y, 300, 1e-6);

/* ==========================================================================
   2. BEARINGS
   ========================================================================== */

section('2. BEARING VECTORS');

const n = bearingToENU(0), e = bearingToENU(90), s = bearingToENU(180), w = bearingToENU(270);
check('Bearing 0 points north, north component', n.n, 1, 1e-9);
check('Bearing 0 points north, east component', n.e, 0, 1e-9);
check('Bearing 90 points east, east component', e.e, 1, 1e-9);
check('Bearing 180 points south, north component', s.n, -1, 1e-9);
check('Bearing 270 points west, east component', w.e, -1, 1e-9);

/* On a canvas, y grows downward, so north must be negative y */
const ns = bearingToScreen(0), es = bearingToScreen(90);
check('Screen bearing 0: y is negative (up)', ns.y, -1, 1e-9);
check('Screen bearing 90: x is positive (right)', es.x, 1, 1e-9);

/* THE CRITICAL ONE. Sun in the south-east must throw a shadow to the
   north-west. Get this backwards and every shadow in the tool is wrong. */
const sunBearing = 135;                         /* south-east */
const shadowDir = bearingToScreen((sunBearing + 180) % 360);
assert('Sun in the SE throws a shadow towards the NW (screen x negative)', shadowDir.x < 0);
assert('Sun in the SE throws a shadow towards the NW (screen y negative)', shadowDir.y < 0);

/* ==========================================================================
   3. CONVEX HULL
   ========================================================================== */

section('3. CONVEX HULL');

const square = [
  { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }
];
check('Hull of a square has 4 vertices', convexHull(square).length, 4, 0);

const squarePlusInterior = square.concat([{ x: 5, y: 5 }, { x: 3, y: 7 }]);
check('Interior points are discarded', convexHull(squarePlusInterior).length, 4, 0);

/* A square and its translated copy: the hull is a hexagon */
const shifted = square.map(p => ({ x: p.x + 30, y: p.y + 30 }));
const swept = convexHull(square.concat(shifted));
check('Square swept diagonally yields a hexagon', swept.length, 6, 0);

/* Hull area of a swept square must exceed the footprint area */
check('Swept hull area exceeds footprint area',
  polygonArea(swept) > polygonArea(convexHull(square)) ? 1 : 0, 1, 0);

function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a / 2);
}

/* ==========================================================================
   4. RAY CASTING
   ========================================================================== */

section('4. RAY / POLYGON INTERSECTION');

/* A 20 m square wall centred 100 m due east of the origin */
const wallEast = new Float64Array([
  90, -10,  110, -10,  110, 10,  90, 10
]);

const east = bearingToENU(90);
const west = bearingToENU(270);
const north = bearingToENU(0);

check('Ray due east hits the near face at 90 m',
  rayPolygonDistance(east.e, east.n, wallEast), 90, 1e-6, ' m');

assert('Ray due west misses a building to the east',
  rayPolygonDistance(west.e, west.n, wallEast) === null);

assert('Ray due north misses a building to the east',
  rayPolygonDistance(north.e, north.n, wallEast) === null);

/* Grazing case: a ray aimed just past the corner must miss */
const past = bearingToENU(90 - Math.atan2(11, 90) * 180 / Math.PI);
assert('Ray aimed past the corner misses',
  rayPolygonDistance(past.e, past.n, wallEast) === null);

assert('Point inside the polygon is detected', pointInPolygon(100, 0, wallEast));
assert('Point outside the polygon is not detected', !pointInPolygon(0, 0, wallEast));

/* ==========================================================================
   5. HEIGHT INFERENCE
   ========================================================================== */

section('5. HEIGHT INFERENCE AND CONFIDENCE');

assert('A surveyed height is MEASURED',
  inferHeight({ render_height: 24.5 }).confidence === CONFIDENCE.MEASURED);
assert('A single-storey default height is ESTIMATED',
  inferHeight({ render_height: 3.1 }).confidence === CONFIDENCE.ESTIMATED);
assert('A missing height falls back to one storey',
  inferHeight({}).metres === STOREY_HEIGHT_M);
assert('A missing height is ESTIMATED',
  inferHeight({}).confidence === CONFIDENCE.ESTIMATED);
assert('Storey count is used when no height is present',
  Math.abs(inferHeight({ levels: 5 }).metres - 5 * STOREY_HEIGHT_M) < 1e-9);
assert('A storey count counts as MEASURED',
  inferHeight({ levels: 5 }).confidence === CONFIDENCE.MEASURED);
assert('A zero height does not produce a zero-height building',
  inferHeight({ render_height: 0 }).metres > 0);

/* ==========================================================================
   6. EXPOSURE — CONSTRUCTED SCENARIOS
   ========================================================================== */

section('6. EXPOSURE PROFILE');

const LAT = 44.4949, LNG = 11.3426;              /* Bologna */
const ZONE = 'Europe/Rome';
const DAY_START = new Date('2026-08-01T00:00:00+02:00');

/* 6a. Open field. No buildings at all: the pin must be lit from sunrise to
       sunset, with no shaded samples whatsoever. */
const open = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, buildings: [], zone: ZONE
});

check('Open field: zero shaded minutes', open.totals.shadedMinutes, 0, 0, ' min');
assert('Open field: exactly one sunlit window', open.windows.length === 1);

/* Daylight duration must match the sunrise-to-sunset interval */
const times = getSunTimes(new Date('2026-08-01T12:00:00+02:00'), LAT, LNG);
const daylightRef = (times.sunset - times.sunrise) / 60000;
check('Open field: daylight matches sunrise to sunset',
  open.totals.daylightMinutes, daylightRef, SAMPLE_MINUTES * 1.5, ' min');

/* 6b. A wall on the south side. In the northern hemisphere the sun passes
       through the south, so a tall wall due south must remove the middle of
       the day and leave light only at the ends. */
const southWall = makeWall({
  centreBearing: 180, distanceM: 20, widthM: 400, depthM: 20, height: 60
});

const blocked = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, buildings: [southWall], zone: ZONE
});

assert('South wall: some of the day is shaded', blocked.totals.shadedMinutes > 0);
assert('South wall: less direct sun than an open field',
  blocked.totals.sunlitMinutes < open.totals.sunlitMinutes);
assert('South wall: solar noon is shaded', sampleAtNoon(blocked) === STATE.SHADED);
assert('South wall: light survives at both ends of the day',
  blocked.windows.length === 2);

/* 6c. A wall to the north.

       Note the season. In August at 44.5 N the sun rises well north of east
       and sets well north of west, so a northern wall genuinely does remove
       the early and late sun. The invariant "a northern wall is harmless"
       only holds in WINTER, when the sun stays in the southern sky all day.
       Both cases are asserted, because getting this backwards would be a
       hemisphere sign error hiding in plain sight. */
const northWall = makeWall({
  centreBearing: 0, distanceM: 20, widthM: 400, depthM: 20, height: 60
});

const augNorth = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, buildings: [northWall], zone: ZONE
});
assert('North wall in August does block the low summer sun',
  augNorth.totals.sunlitMinutes < open.totals.sunlitMinutes);

const WINTER_DAY = new Date('2026-12-15T00:00:00+01:00');
const winterOpen = computeExposure({
  lat: LAT, lng: LNG, dayStart: WINTER_DAY, buildings: [], zone: ZONE
});
const winterNorth = computeExposure({
  lat: LAT, lng: LNG, dayStart: WINTER_DAY, buildings: [northWall], zone: ZONE
});
check('North wall in December: no effect, the sun never goes north',
  winterNorth.totals.sunlitMinutes, winterOpen.totals.sunlitMinutes, 0, ' min');

assert('Winter days are shorter than summer days',
  winterOpen.totals.daylightMinutes < open.totals.daylightMinutes);

/* 6d. Height matters monotonically: a taller wall can never let in more sun */
let previous = Infinity;
let monotonic = true;
for (const h of [5, 10, 20, 40, 80]) {
  const w = makeWall({ centreBearing: 180, distanceM: 20, widthM: 400, depthM: 20, height: h });
  const r = computeExposure({ lat: LAT, lng: LNG, dayStart: DAY_START, buildings: [w], zone: ZONE });
  if (r.totals.sunlitMinutes > previous) monotonic = false;
  previous = r.totals.sunlitMinutes;
}
assert('Direct sun decreases monotonically as the wall grows', monotonic);

/* 6e. Distance matters: the same wall further away blocks less */
const near = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, zone: ZONE,
  buildings: [makeWall({ centreBearing: 180, distanceM: 15, widthM: 400, depthM: 20, height: 40 })]
});
const far = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, zone: ZONE,
  buildings: [makeWall({ centreBearing: 180, distanceM: 120, widthM: 400, depthM: 20, height: 40 })]
});
assert('A more distant wall blocks less light',
  far.totals.sunlitMinutes > near.totals.sunlitMinutes);

/* 6f. Standing inside a building is fully obstructed */
const enclosing = makeWall({
  centreBearing: 0, distanceM: -50, widthM: 100, depthM: 100, height: 20
});
const indoors = computeExposure({
  lat: LAT, lng: LNG, dayStart: DAY_START, buildings: [enclosing], zone: ZONE
});
assert('Standing inside a footprint is detected', indoors.inside === true);
check('Standing indoors yields no direct sun', indoors.totals.sunlitMinutes, 0, 0, ' min');

/* 6g. Southern hemisphere mirror: in Sydney the blocking wall is to the NORTH */
const SYD = { lat: -33.8688, lng: 151.2093 };
const SYD_DAY = new Date('2026-08-01T00:00:00+10:00');
const sydOpen = computeExposure({
  lat: SYD.lat, lng: SYD.lng, dayStart: SYD_DAY, buildings: [], zone: 'Australia/Sydney'
});
const sydNorth = computeExposure({
  lat: SYD.lat, lng: SYD.lng, dayStart: SYD_DAY, zone: 'Australia/Sydney',
  buildings: [makeWall({ centreBearing: 0, distanceM: 20, widthM: 400, depthM: 20, height: 60, lat: SYD.lat, lng: SYD.lng })]
});
assert('Sydney: a wall to the north blocks the midday sun',
  sydNorth.totals.sunlitMinutes < sydOpen.totals.sunlitMinutes);

/* ==========================================================================
   HELPERS
   ========================================================================== */

/**
 * Build a rectangular slab at a bearing and distance from the pin, expressed
 * in the same prepared form extractBuildings produces.
 */
function makeWall({ centreBearing, distanceM, widthM, depthM, height,
                    lat = LAT, lng = LNG }) {
  const dir = bearingToENU(centreBearing);
  const perp = bearingToENU((centreBearing + 90) % 360);

  const cx = dir.e * distanceM;
  const cy = dir.n * distanceM;

  const corners = [
    [-widthM / 2, 0],
    [ widthM / 2, 0],
    [ widthM / 2, depthM],
    [-widthM / 2, depthM]
  ];

  const M_PER_DEG_LAT = 111320;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);

  const ring = corners.map(([along, out]) => {
    const e = cx + perp.e * along + dir.e * out;
    const nn = cy + perp.n * along + dir.n * out;
    return [lng + e / mPerDegLng, lat + nn / M_PER_DEG_LAT];
  });
  ring.push(ring[0]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const merc = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    const m = toMercator(ring[i][0], ring[i][1]);
    merc[i * 2] = m.x; merc[i * 2 + 1] = m.y;
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }

  return {
    height, base: 0, confidence: CONFIDENCE.MEASURED,
    merc, lngLat: ring, centroidLat: lat,
    bbox: { minX, minY, maxX, maxY }
  };
}

function sampleAtNoon(profile) {
  const noon = getSunTimes(new Date('2026-08-01T12:00:00+02:00'), LAT, LNG).solarNoon;
  const minutes = (noon - DAY_START) / 60000;
  return profile.samples[Math.floor(minutes / SAMPLE_MINUTES)];
}

/* ==========================================================================
   RESULT
   ========================================================================== */

section('RESULT');
console.log(`${checks - failures} passed, ${failures} failed, ${checks} total`);
if (failures > 0) {
  console.log('\nGEOMETRY UNVERIFIED. Do not ship.');
  process.exit(1);
}
console.log('\nGEOMETRY AND EXPOSURE VERIFIED.');
