/* ==========================================================================
   L.U.M.E.N. — ASTRO VERIFICATION HARNESS
   Run:  node tools/verify-astro.mjs

   The ephemeris module is written in-house, so it cannot be trusted on the
   strength of "it looks right on the map". This harness checks it three ways:

     1. Against physics that must hold by definition (equinox geometry,
        solstice declination, solar noon symmetry).
     2. Against an INDEPENDENT implementation of the NOAA solar position
        algorithm, written from a different source using different
        intermediate quantities. Two independent algorithms agreeing to a
        fraction of a degree is strong evidence both are correct.
     3. Against the internal consistency of the event solver (the computed
        sunrise instant must actually place the sun at -0.833 degrees).

   Any failure here means shadows will be drawn in the wrong direction.
   Do not ship on a red result.
   ========================================================================== */

import {
  getSunPosition, getSunTimes,
  getMoonPosition, getMoonIllumination, getMoonTimes,
  compassLabel
} from '../src/core/astro.mjs';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

let failures = 0;
let checks = 0;

function check(label, actual, expected, tolerance, unit = '') {
  checks++;
  const delta = Math.abs(actual - expected);
  const ok = delta <= tolerance;
  if (!ok) failures++;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(
    `[${status}] ${label.padEnd(52)} ` +
    `got ${actual.toFixed(4)}${unit}  exp ${expected.toFixed(4)}${unit}  ` +
    `d=${delta.toFixed(4)} tol=${tolerance}`
  );
}

function assert(label, condition) {
  checks++;
  if (!condition) failures++;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}`);
}

function section(t) {
  console.log('\n' + '='.repeat(96));
  console.log(t);
  console.log('='.repeat(96));
}

/* ==========================================================================
   INDEPENDENT REFERENCE: NOAA SOLAR POSITION ALGORITHM
   Deliberately written from the NOAA formulation, which uses the equation of
   time and true solar time rather than sidereal time and right ascension.
   Different intermediates, different failure modes.
   ========================================================================== */

function noaaSunPosition(date, lat, lng) {
  const jd = date.valueOf() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;

  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
            Math.sin(3 * M * RAD) * 0.000289;

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliq = 23 + (26 + ((21.448 - T * (46.815 + T * (0.00059 - T * 0.001813)))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * RAD);

  const decl = Math.asin(Math.sin(obliqCorr * RAD) * Math.sin(appLong * RAD)) * DEG;

  const y = Math.tan(obliqCorr / 2 * RAD) ** 2;
  const eqTime = 4 * DEG * (
    y * Math.sin(2 * L0 * RAD) -
    2 * e * Math.sin(M * RAD) +
    4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
    0.5 * y * y * Math.sin(4 * L0 * RAD) -
    1.25 * e * e * Math.sin(2 * M * RAD)
  );

  /* Minutes past UTC midnight */
  const minutesUTC =
    date.getUTCHours() * 60 + date.getUTCMinutes() +
    date.getUTCSeconds() / 60 + date.getUTCMilliseconds() / 60000;

  let trueSolarTime = (minutesUTC + eqTime + 4 * lng) % 1440;
  if (trueSolarTime < 0) trueSolarTime += 1440;

  let ha = trueSolarTime / 4 - 180;
  if (ha < -180) ha += 360;

  const zenith = Math.acos(
    Math.sin(lat * RAD) * Math.sin(decl * RAD) +
    Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(ha * RAD)
  ) * DEG;

  const elevation = 90 - zenith;

  /* NOAA azimuth: from north, clockwise */
  let azimuth;
  const denom = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
  if (Math.abs(denom) > 1e-9) {
    let c = (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(decl * RAD)) / denom;
    c = Math.max(-1, Math.min(1, c));
    azimuth = Math.acos(c) * DEG;
    if (ha > 0) azimuth = mod360(azimuth + 180);
    else azimuth = mod360(540 - azimuth);
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }

  return { azimuth, elevation, declination: decl, eqTime };
}

function mod360(x) {
  return ((x % 360) + 360) % 360;
}

/* Smallest signed difference between two bearings, degrees */
function bearingDelta(a, b) {
  let d = ((a - b + 540) % 360) - 180;
  return Math.abs(d);
}

/* ==========================================================================
   1. CROSS-VALIDATION AGAINST NOAA
   ========================================================================== */

section('1. SUN POSITION vs INDEPENDENT NOAA IMPLEMENTATION');

const SITES = [
  { name: 'Bologna, IT',      lat:  44.4949, lng:  11.3426 },
  { name: 'Magione, IT',      lat:  43.1428, lng:  12.2036 },
  { name: 'Reykjavik, IS',    lat:  64.1466, lng: -21.9426 },
  { name: 'Singapore, SG',    lat:   1.3521, lng: 103.8198 },
  { name: 'Ushuaia, AR',      lat: -54.8019, lng: -68.3030 },
  { name: 'Sydney, AU',       lat: -33.8688, lng: 151.2093 },
  { name: 'Anchorage, US',    lat:  61.2181, lng:-149.9003 }
];

const INSTANTS = [
  '2026-03-20T09:00:00Z',
  '2026-06-21T12:00:00Z',
  '2026-08-01T15:30:00Z',
  '2026-09-23T06:00:00Z',
  '2026-12-21T13:45:00Z',
  '2027-02-14T04:20:00Z'
];

let worstAlt = 0;
let worstAz = 0;

for (const site of SITES) {
  for (const iso of INSTANTS) {
    const date = new Date(iso);
    const mine = getSunPosition(date, site.lat, site.lng);
    const noaa = noaaSunPosition(date, site.lat, site.lng);

    const dAlt = Math.abs(mine.altitudeTrue - noaa.elevation);
    worstAlt = Math.max(worstAlt, dAlt);

    /* Azimuth is ill-conditioned when the sun is near the zenith or far below
       the horizon; only compare when the geometry is meaningful. */
    if (noaa.elevation > -10 && noaa.elevation < 85) {
      const dAz = bearingDelta(mine.azimuth, noaa.azimuth);
      worstAz = Math.max(worstAz, dAz);
    }
  }
}

check('Worst altitude disagreement across 42 samples', worstAlt, 0, 0.02, ' deg');
check('Worst azimuth disagreement across 42 samples',  worstAz, 0, 0.02, ' deg');

/* One fully printed sample so a human can eyeball it */
const sampleDate = new Date('2026-08-01T15:30:00Z');
const sMine = getSunPosition(sampleDate, 44.4949, 11.3426);
const sNoaa = noaaSunPosition(sampleDate, 44.4949, 11.3426);
console.log('\n  Sample readout, Bologna 2026-08-01 15:30 UTC');
console.log(`    L.U.M.E.N.  az ${sMine.azimuth.toFixed(3)}  alt ${sMine.altitudeTrue.toFixed(3)}  (${compassLabel(sMine.azimuth)})`);
console.log(`    NOAA        az ${sNoaa.azimuth.toFixed(3)}  alt ${sNoaa.elevation.toFixed(3)}`);

/* ==========================================================================
   2. GEOMETRY THAT MUST HOLD BY DEFINITION
   ========================================================================== */

section('2. INVARIANTS OF SPHERICAL GEOMETRY');

/* 2a. At an equinox, sunrise is due east and sunset due west everywhere.
       Tolerance is a degree or so: the "equinox" instant is not exactly at
       local sunrise, and the -0.833 disc/refraction offset shifts the
       bearing slightly. */
const equinox = new Date('2026-03-20T12:00:00Z');
for (const site of [SITES[0], SITES[3], SITES[5]]) {
  const t = getSunTimes(equinox, site.lat, site.lng);
  const riseAz = getSunPosition(t.sunrise, site.lat, site.lng).azimuth;
  const setAz  = getSunPosition(t.sunset,  site.lat, site.lng).azimuth;
  check(`Equinox sunrise bearing, ${site.name}`, riseAz, 90,  1.5, ' deg');
  check(`Equinox sunset  bearing, ${site.name}`, setAz, 270, 1.5, ' deg');
}

/* 2b. Solar noon altitude at an equinox equals 90 - |latitude| */
for (const site of [SITES[0], SITES[2], SITES[4]]) {
  const t = getSunTimes(equinox, site.lat, site.lng);
  const noonAlt = getSunPosition(t.solarNoon, site.lat, site.lng).altitudeTrue;
  check(`Equinox noon altitude, ${site.name}`, noonAlt, 90 - Math.abs(site.lat), 0.6, ' deg');
}

/* 2c. Solstice declination reaches the obliquity of the ecliptic */
const junSol = new Date('2026-06-21T09:00:00Z');
const decSol = new Date('2026-12-21T15:00:00Z');
check('June solstice declination',     noaaSunPosition(junSol, 0, 0).declination,  23.44, 0.05, ' deg');
check('December solstice declination', noaaSunPosition(decSol, 0, 0).declination, -23.44, 0.05, ' deg');

/* 2d. In the northern hemisphere the sun is due south at solar noon */
const noonBologna = getSunTimes(new Date('2026-08-01T12:00:00Z'), 44.4949, 11.3426).solarNoon;
check('Solar noon bearing is due south, Bologna',
      getSunPosition(noonBologna, 44.4949, 11.3426).azimuth, 180, 0.05, ' deg');

/* 2e. In the southern hemisphere it is due north */
const noonSydney = getSunTimes(new Date('2026-08-01T02:00:00Z'), -33.8688, 151.2093).solarNoon;
const azSydney = getSunPosition(noonSydney, -33.8688, 151.2093).azimuth;
check('Solar noon bearing is due north, Sydney',
      Math.min(azSydney, 360 - azSydney), 0, 0.05, ' deg');

/* ==========================================================================
   3. EVENT SOLVER SELF-CONSISTENCY
   The instant reported as "sunrise" must actually place the sun at the
   altitude that defines sunrise. This catches sign errors and off-by-one-day
   bugs in the Julian cycle that a visual check would never reveal.
   ========================================================================== */

section('3. EVENT SOLVER SELF-CONSISTENCY');

const EVENT_ANGLES = {
  sunrise: -0.833, sunset: -0.833,
  dawn: -6,        dusk: -6,
  nauticalDawn: -12, nauticalDusk: -12,
  nightEnd: -18,   night: -18,
  goldenHourEnd: 6, goldenHour: 6
};

let worstEvent = 0;
let eventCount = 0;

for (const site of SITES) {
  for (const iso of ['2026-03-20T12:00:00Z', '2026-08-01T12:00:00Z', '2026-12-21T12:00:00Z']) {
    const times = getSunTimes(new Date(iso), site.lat, site.lng);
    for (const [name, angle] of Object.entries(EVENT_ANGLES)) {
      const t = times[name];
      if (!t || isNaN(t.valueOf())) continue;
      const alt = getSunPosition(t, site.lat, site.lng).altitudeTrue;
      worstEvent = Math.max(worstEvent, Math.abs(alt - angle));
      eventCount++;
    }
  }
}

console.log(`  ${eventCount} event instants resolved and re-evaluated`);
check('Worst event-altitude reconstruction error', worstEvent, 0, 0.001, ' deg');

/* 3b. Ordering must be sane */
const bt = getSunTimes(new Date('2026-08-01T12:00:00Z'), 44.4949, 11.3426);
assert('Bologna Aug: nightEnd < dawn < sunrise < solarNoon < sunset < dusk',
  bt.nightEnd < bt.dawn && bt.dawn < bt.sunrise &&
  bt.sunrise < bt.solarNoon && bt.solarNoon < bt.sunset &&
  bt.sunset < bt.dusk);

/* 3c. Polar night: Reykjavik in late December has no golden hour end */
const rvk = getSunTimes(new Date('2026-12-21T12:00:00Z'), 64.1466, -21.9426);
assert('Reykjavik 21 Dec: golden hour never reached (null, not NaN)',
  rvk.goldenHourEnd === null);
assert('Reykjavik 21 Dec: sunrise still occurs', rvk.sunrise instanceof Date);

/* 3d. Polar day: Anchorage in June never reaches astronomical night */
const anc = getSunTimes(new Date('2026-06-21T12:00:00Z'), 61.2181, -149.9003);
assert('Anchorage 21 Jun: astronomical night never begins (null)',
  anc.night === null);

/* ==========================================================================
   4. MOON
   ========================================================================== */

section('4. MOON');

/* 4a. Known full moons. Illuminated fraction must be essentially 1.
       Reference instants from published lunation tables. */
const FULL_MOONS = [
  '2026-01-03T10:03:00Z',
  '2026-06-29T23:57:00Z',
  '2026-12-24T01:28:00Z'
];
for (const iso of FULL_MOONS) {
  const ill = getMoonIllumination(new Date(iso));
  check(`Full moon fraction ${iso.slice(0, 10)}`, ill.fraction, 1, 0.02);
}

/* 4b. Known new moons. Fraction must be essentially 0. */
const NEW_MOONS = [
  '2026-01-18T19:52:00Z',
  '2026-07-14T09:44:00Z',
  '2026-12-09T15:52:00Z'
];
for (const iso of NEW_MOONS) {
  const ill = getMoonIllumination(new Date(iso));
  check(`New moon fraction ${iso.slice(0, 10)}`, ill.fraction, 0, 0.02);
}

/* 4c. Phase must advance monotonically through a synodic month and wrap once */
let wraps = 0;
let prev = getMoonIllumination(new Date('2026-01-01T00:00:00Z')).phase;
for (let i = 1; i <= 29; i++) {
  const p = getMoonIllumination(new Date(Date.UTC(2026, 0, 1 + i))).phase;
  if (p < prev) wraps++;
  prev = p;
}
assert('Moon phase wraps exactly once over 29 days', wraps === 1);

/* 4d. Moon altitude must stay inside the physically possible range */
let moonOk = true;
for (let i = 0; i < 200; i++) {
  const d = new Date(Date.UTC(2026, 0, 1) + i * 3.7 * 3600000);
  const p = getMoonPosition(d, 44.4949, 11.3426);
  if (p.altitude < -91 || p.altitude > 91) moonOk = false;
  if (p.azimuth < 0 || p.azimuth >= 360) moonOk = false;
  if (p.distance < 350000 || p.distance > 410000) moonOk = false;
}
assert('200 moon samples: altitude, bearing and distance all in range', moonOk);

/* 4e. Moonrise/moonset must bracket a period of positive altitude */
const mt = getMoonTimes(new Date('2026-08-01T00:00:00Z'), 44.4949, 11.3426);
if (mt.rise && mt.set) {
  const riseAlt = getMoonPosition(mt.rise, 44.4949, 11.3426).altitude;
  const setAlt  = getMoonPosition(mt.set,  44.4949, 11.3426).altitude;
  check('Moon altitude at computed moonrise', riseAlt, 0, 0.6, ' deg');
  check('Moon altitude at computed moonset',  setAlt,  0, 0.6, ' deg');
} else {
  console.log('  (no moonrise/moonset on this day at this location)');
}

/* ==========================================================================
   5. THE AZIMUTH CONVENTION CONTRACT
   The one thing that, if wrong, silently rotates every shadow in the tool.
   ========================================================================== */

section('5. COMPASS BEARING CONTRACT');

assert('compassLabel(0) === N',    compassLabel(0) === 'N');
assert('compassLabel(90) === E',   compassLabel(90) === 'E');
assert('compassLabel(180) === S',  compassLabel(180) === 'S');
assert('compassLabel(270) === W',  compassLabel(270) === 'W');
assert('compassLabel(315) === NW', compassLabel(315) === 'NW');

/* Every bearing produced anywhere must be in [0, 360) */
let rangeOk = true;
for (const site of SITES) {
  for (let i = 0; i < 48; i++) {
    const d = new Date(Date.UTC(2026, 7, 1) + i * 1800000);
    const s = getSunPosition(d, site.lat, site.lng);
    const m = getMoonPosition(d, site.lat, site.lng);
    if (!(s.azimuth >= 0 && s.azimuth < 360)) rangeOk = false;
    if (!(m.azimuth >= 0 && m.azimuth < 360)) rangeOk = false;
  }
}
assert('All bearings normalised to [0, 360)', rangeOk);

/* Morning sun must be east of south, afternoon sun west of south */
const morning = getSunPosition(new Date('2026-08-01T06:00:00Z'), 44.4949, 11.3426);
const evening = getSunPosition(new Date('2026-08-01T17:00:00Z'), 44.4949, 11.3426);
assert('Morning sun bearing is easterly (< 180)', morning.azimuth < 180);
assert('Evening sun bearing is westerly (> 180)', evening.azimuth > 180);

/* ==========================================================================
   RESULT
   ========================================================================== */

section('RESULT');
console.log(`${checks - failures} passed, ${failures} failed, ${checks} total`);
if (failures > 0) {
  console.log('\nEPHEMERIS UNVERIFIED. Do not ship.');
  process.exit(1);
}
console.log('\nEPHEMERIS VERIFIED. Shadow projection may rely on these bearings.');
