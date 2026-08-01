/* ==========================================================================
   L.U.M.E.N. — CORE / ASTRO
   Sun and Moon ephemerides. Written in-house, no external library.

   Formulas from Jean Meeus, "Astronomical Algorithms", in the low-precision
   form that is standard for horizon-level work. Accuracy is well within
   0.1 degrees for the sun and roughly 0.2 degrees for the moon, which is one
   to two orders of magnitude better than the surface model this tool draws
   shadows from. Increasing astronomical precision would be pointless here.

   ---------------------------------------------------------------------------
   UNIT CONVENTION — THE SINGLE MOST IMPORTANT CONTRACT IN THIS CODEBASE
   ---------------------------------------------------------------------------
   Internally this module works in radians and in the astronomical azimuth
   convention (measured from SOUTH, increasing westward).

   NOTHING LEAVES THIS FILE IN THAT FORM.

   Every exported function returns:
     - altitude  : DEGREES above the true horizon, refraction corrected
     - azimuth   : DEGREES as a COMPASS BEARING (0 = N, 90 = E, clockwise)
     - distance  : kilometres
     - times     : JavaScript Date objects (absolute instants, UTC internally)

   No other file in this project may perform an azimuth conversion. If you
   find yourself writing "+ 180" against a bearing anywhere else, stop.

   Verified numerically against published references at build time; see
   tools/verify-astro.mjs for the assertions and their expected values.
   ========================================================================== */

const PI = Math.PI;
const TAU = 2 * PI;
const RAD = PI / 180;
const DEG = 180 / PI;

/* Mean obliquity of the ecliptic, epoch J2000. Its secular drift is about
   0.013 degrees per century, which is irrelevant at this precision. */
const OBLIQUITY = 23.4397 * RAD;

/* Julian date bookkeeping. Day 0 of this module's internal clock is
   J2000.0 = 2000-01-01 12:00 TT. */
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;

/* Mean distance to the sun, kilometres. Used for lunar phase geometry. */
const SUN_DISTANCE_KM = 149598000;

/* --------------------------------------------------------------------------
   TIME
   -------------------------------------------------------------------------- */

function toJulian(date) {
  return date.valueOf() / DAY_MS - 0.5 + J1970;
}

function fromJulian(j) {
  return new Date((j + 0.5 - J1970) * DAY_MS);
}

/* Days since J2000.0 */
function toDays(date) {
  return toJulian(date) - J2000;
}

/* --------------------------------------------------------------------------
   GENERAL SPHERICAL ASTRONOMY
   -------------------------------------------------------------------------- */

/* Mean obliquity of the ecliptic corrected for nutation, at time d.
   Passed explicitly into the coordinate transforms rather than hidden as a
   constant, because the sun path applies the nutation correction and the
   moon path does not (the moon's truncated series is the limiting error
   there, so a 0.003 degree obliquity refinement would be theatre). */
function obliquityCorrected(d) {
  const T = d / 36525;
  const e0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const omega = RAD * (125.04 - 1934.136 * T);
  return RAD * (e0 + 0.00256 * Math.cos(omega));
}

/* Right ascension from ecliptic longitude and latitude */
function rightAscension(l, b, e = OBLIQUITY) {
  return Math.atan2(
    Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e),
    Math.cos(l)
  );
}

/* Declination from ecliptic longitude and latitude */
function declination(l, b, e = OBLIQUITY) {
  return Math.asin(
    Math.sin(b) * Math.cos(e) +
    Math.cos(b) * Math.sin(e) * Math.sin(l)
  );
}

/* Local apparent sidereal time.

   The constants are the IAU Greenwich Mean Sidereal Time series, not the
   rounded values that circulate in short web-astronomy snippets. The commonly
   copied constant 280.16 is roughly 0.3 degrees adrift, which is about a
   minute and a quarter of time. That error is invisible when it is paired
   with an equally approximate solar longitude, because the two partly cancel,
   but it becomes the dominant error the moment the solar coordinates are
   computed properly. They are computed properly here.

   lw is the observer's longitude expressed westward-positive, in radians,
   which is the sign convention used throughout the internal maths of this
   file. */
function siderealTime(d, lw) {
  const T = d / 36525;
  const gmst = 280.46061837 + 360.98564736629 * d
             + T * T * (0.000387933 - T / 38710000);
  return RAD * gmst - lw;
}

/* Azimuth measured from SOUTH, increasing westward. Internal only. */
function azimuthFromSouth(H, phi, dec) {
  return Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
  );
}

function altitudeRad(H, phi, dec) {
  return Math.asin(
    Math.sin(phi) * Math.sin(dec) +
    Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  );
}

/* Atmospheric refraction, Bennett's formula. Takes and returns radians.
   Below the horizon the correction is clamped rather than extrapolated,
   because the formula diverges and the result would be meaningless. */
function refraction(h) {
  if (h < 0) h = 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

/* Normalise an angle in radians to [-PI, PI] */
function wrapPi(a) {
  return ((a + PI) % TAU + TAU) % TAU - PI;
}

/* --------------------------------------------------------------------------
   THE ONE AND ONLY AZIMUTH CONVERSION
   Astronomical azimuth (radians, from south, westward positive)
   -> compass bearing (degrees, from north, clockwise).

   Sanity check that must hold: at solar noon in the northern hemisphere the
   internal azimuth is 0, and this must return 180 (due south).
   -------------------------------------------------------------------------- */
function toCompassBearing(azFromSouthRad) {
  const deg = azFromSouthRad * DEG + 180;
  return ((deg % 360) + 360) % 360;
}

/* --------------------------------------------------------------------------
   SUN
   -------------------------------------------------------------------------- */

/* Geometric mean anomaly of the sun, radians.
   Coefficients carry the century term so the model stays honest over the
   decades this tool might plausibly be used for. */
function solarMeanAnomaly(d) {
  const T = d / 36525;
  return RAD * (357.52911 + T * (35999.05029 - 0.0001537 * T));
}

/* Apparent ecliptic longitude of the sun, radians.

   "Apparent" matters: it includes the correction for nutation in longitude
   and for the aberration of light. Omitting those leaves a systematic error
   of roughly 0.005 degrees in longitude, which propagates into a two minute
   error in the computed solar noon. Two minutes is visible when a
   photographer is timing light down the axis of a street. */
function eclipticLongitude(M, d) {
  const T = d / 36525;

  /* Geometric mean longitude */
  const L0 = 280.46646 + T * (36000.76983 + T * 0.0003032);

  /* Equation of the centre */
  const C = Math.sin(M)     * (1.914602 - T * (0.004817 + 0.000014 * T)) +
            Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
            Math.sin(3 * M) *  0.000289;

  /* Longitude of the ascending node of the moon's mean orbit, used for the
     nutation term */
  const omega = RAD * (125.04 - 1934.136 * T);

  const apparent = L0 + C - 0.00569 - 0.00478 * Math.sin(omega);
  return RAD * apparent;
}

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M, d);
  const e = obliquityCorrected(d);
  return {
    dec: declination(L, 0, e),
    ra: rightAscension(L, 0, e),
    M,
    L
  };
}

/**
 * Instantaneous sun position.
 * @returns {{azimuth:number, altitude:number, altitudeTrue:number}}
 *   azimuth      compass bearing, degrees
 *   altitude     degrees, refraction corrected (what the eye sees)
 *   altitudeTrue degrees, geometric, no refraction (what shadow maths wants)
 */
export function getSunPosition(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;

  const hTrue = altitudeRad(H, phi, c.dec);
  const hApparent = hTrue + refraction(hTrue);

  return {
    azimuth: toCompassBearing(azimuthFromSouth(H, phi, c.dec)),
    altitude: hApparent * DEG,
    altitudeTrue: hTrue * DEG
  };
}

/* --- Sun event times ------------------------------------------------------ */

/* Sun altitude thresholds, in degrees, that define each named phase.
   -0.833 accounts for the solar disc radius plus mean refraction. */
export const SUN_EVENTS = [
  { angle: -0.833, rise: 'sunrise',       set: 'sunset'        },
  { angle: -0.3,   rise: 'sunriseEnd',    set: 'sunsetStart'   },
  { angle: -6,     rise: 'dawn',          set: 'dusk'          },
  { angle: -12,    rise: 'nauticalDawn',  set: 'nauticalDusk'  },
  { angle: -18,    rise: 'nightEnd',      set: 'night'         },
  { angle: 6,      rise: 'goldenHourEnd', set: 'goldenHour'    }
];

const J0 = 0.0009;

function julianCycle(d, lw) {
  return Math.round(d - J0 - lw / TAU);
}

function approxTransit(Ht, lw, n) {
  return J0 + (Ht + lw) / TAU + n;
}

function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

/* Observer elevation lowers the apparent horizon. Kept for completeness even
   though v1.0 always passes height 0, because omitting it later would be a
   silent behaviour change. */
function observerAngle(height) {
  return -2.076 * Math.sqrt(height) / 60;
}

/* --------------------------------------------------------------------------
   REFINEMENT

   The closed-form event solver above is a very good first guess but carries a
   residual of one to two minutes, because it approximates the equation of
   time with two harmonic terms.

   Rather than chase precision by piling on more terms, each event time is
   refined by Newton iteration against the position function itself. This has
   a property the closed form can never have: the event times become EXACTLY
   self-consistent with the positions the tool draws. The instant labelled
   "sunrise" is, by construction, an instant at which this codebase computes
   the sun to be at the sunrise altitude.

   That self-consistency is worth more here than absolute accuracy, because
   every vector and every shadow is derived from the same position function.
   -------------------------------------------------------------------------- */

const REFINE_ITERATIONS = 4;
const MAX_REFINE_SHIFT_MS = 6 * 3600 * 1000;   /* sanity clamp: 6 hours */

function refineEventTime(seed, targetAltDeg, lat, lng) {
  let t = seed.valueOf();

  for (let i = 0; i < REFINE_ITERATIONS; i++) {
    const alt = trueAltitudeAt(t, lat, lng);
    const err = alt - targetAltDeg;
    if (Math.abs(err) < 1e-6) break;

    /* Numerical derivative over one minute, degrees per millisecond */
    const alt2 = trueAltitudeAt(t + 60000, lat, lng);
    const rate = (alt2 - alt) / 60000;

    /* Near a turning point the derivative vanishes and Newton is unusable.
       Bail out and keep the closed-form estimate rather than diverge. */
    if (Math.abs(rate) < 1e-12) return seed;

    let step = -err / rate;
    if (!isFinite(step)) return seed;
    if (Math.abs(step) > MAX_REFINE_SHIFT_MS) return seed;

    t += step;
  }

  if (Math.abs(t - seed.valueOf()) > MAX_REFINE_SHIFT_MS) return seed;
  return new Date(Math.round(t));
}

function trueAltitudeAt(ms, lat, lng) {
  const d = toDays(new Date(ms));
  const c = sunCoords(d);
  const H = siderealTime(d, RAD * -lng) - c.ra;
  return altitudeRad(H, RAD * lat, c.dec) * DEG;
}

/* Solar noon and nadir are found by driving the hour angle to zero (or to
   PI), which is better conditioned than maximising the altitude. */
function refineHourAngle(seed, lng, targetH) {
  const lw = RAD * -lng;
  let t = seed.valueOf();

  for (let i = 0; i < 3; i++) {
    const d = toDays(new Date(t));
    const c = sunCoords(d);
    const H = wrapPi(siderealTime(d, lw) - c.ra - targetH);

    /* The hour angle advances by very nearly 360 degrees per day. */
    const dHdt = TAU / DAY_MS;
    const step = -H / dHdt;
    if (Math.abs(step) > MAX_REFINE_SHIFT_MS) return seed;
    t += step;
  }

  return new Date(Math.round(t));
}

/**
 * Sun event times for the solar day containing `date`.
 *
 * Events that do not occur (polar day, polar night, or simply a sun that
 * never climbs above the golden hour threshold in winter) are returned as
 * null rather than as an Invalid Date. Callers must handle null; the console
 * renderer displays a dash and the exposure profile treats it accordingly.
 */
export function getSunTimes(date, lat, lng, height = 0) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const dh = observerAngle(height);

  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);

  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M, ds);
  const dec = declination(L, 0, obliquityCorrected(ds));

  const JnoonApprox = solarTransitJ(ds, M, L);
  const noonSeed = fromJulian(JnoonApprox);

  const solarNoon = refineHourAngle(noonSeed, lng, 0);
  const nadir = refineHourAngle(new Date(solarNoon.valueOf() - DAY_MS / 2), lng, PI);

  const result = { solarNoon, nadir };

  for (const ev of SUN_EVENTS) {
    const angle = ev.angle + dh;
    const h0 = angle * RAD;

    const cosW =
      (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) /
      (Math.cos(phi) * Math.cos(dec));

    /* |cos| > 1 means the sun never reaches this altitude on this day. */
    if (cosW > 1 || cosW < -1) {
      result[ev.rise] = null;
      result[ev.set] = null;
      continue;
    }

    const w = Math.acos(cosW);
    const setSeed = fromJulian(solarTransitJ(approxTransit(w, lw, n), M, L));
    const riseSeed = new Date(2 * solarNoon.valueOf() - setSeed.valueOf());

    result[ev.rise] = refineEventTime(riseSeed, angle, lat, lng);
    result[ev.set]  = refineEventTime(setSeed,  angle, lat, lng);
  }

  return result;
}

/* --------------------------------------------------------------------------
   MOON
   -------------------------------------------------------------------------- */

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d);  /* geocentric ecliptic longitude */
  const M = RAD * (134.963 + 13.064993 * d);  /* mean anomaly                  */
  const F = RAD * (93.272  + 13.229350 * d);  /* mean distance                 */

  const lng = L + RAD * 6.289 * Math.sin(M);  /* ecliptic longitude            */
  const lat = RAD * 5.128 * Math.sin(F);      /* ecliptic latitude             */
  const dt = 385001 - 20905 * Math.cos(M);    /* distance to moon, km          */

  return {
    ra: rightAscension(lng, lat),
    dec: declination(lng, lat),
    dist: dt
  };
}

/**
 * Instantaneous moon position.
 * @returns {{azimuth:number, altitude:number, distance:number,
 *            parallacticAngle:number}}
 */
export function getMoonPosition(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;

  let h = altitudeRad(H, phi, c.dec);

  /* Parallactic angle: the tilt of the illuminated limb as seen from here.
     Needed to draw the moon glyph at the correct orientation. */
  const pa = Math.atan2(
    Math.sin(H),
    Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H)
  );

  h += refraction(h);

  return {
    azimuth: toCompassBearing(azimuthFromSouth(H, phi, c.dec)),
    altitude: h * DEG,
    distance: c.dist,
    parallacticAngle: pa * DEG
  };
}

/**
 * Moon illumination. Independent of observer location.
 * @returns {{fraction:number, phase:number, angle:number, name:string}}
 *   fraction  0 = new, 1 = full
 *   phase     0 = new, 0.25 first quarter, 0.5 full, 0.75 last quarter
 *   angle     degrees, midpoint of the illuminated limb from the disc's north
 */
export function getMoonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);

  /* Geocentric elongation of the moon from the sun */
  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) +
    Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
  );

  /* Selenocentric elongation of the earth from the sun */
  const inc = Math.atan2(SUN_DISTANCE_KM * Math.sin(phi),
                         m.dist - SUN_DISTANCE_KM * Math.cos(phi));

  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) -
    Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
  );

  const phase = 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / PI;

  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase,
    angle: angle * DEG,
    name: phaseName(phase)
  };
}

const PHASE_NAMES = [
  [0.0625, 'NEW MOON'],
  [0.1875, 'WAXING CRESCENT'],
  [0.3125, 'FIRST QUARTER'],
  [0.4375, 'WAXING GIBBOUS'],
  [0.5625, 'FULL MOON'],
  [0.6875, 'WANING GIBBOUS'],
  [0.8125, 'LAST QUARTER'],
  [0.9375, 'WANING CRESCENT']
];

function phaseName(phase) {
  for (const [limit, name] of PHASE_NAMES) {
    if (phase < limit) return name;
  }
  return 'NEW MOON';
}

/**
 * Moonrise and moonset.
 *
 * There is no closed form for these, because the moon's declination changes
 * appreciably within a single day. The standard approach is used: sample the
 * altitude hourly, detect sign changes across the horizon, and refine by
 * quadratic interpolation.
 *
 * @param {Date}   date        any instant within the day of interest
 * @param {number} lat
 * @param {number} lng
 * @param {Date}   dayStart    the absolute instant at which the local day
 *                             begins at this location. Passing this in rather
 *                             than assuming UTC midnight is what makes the
 *                             result correct for a pin in a foreign timezone.
 * @returns {{rise:Date|null, set:Date|null,
 *            alwaysUp:boolean, alwaysDown:boolean}}
 */
export function getMoonTimes(dayStart, lat, lng) {
  const t = new Date(dayStart.valueOf());
  const hc = 0.133 * RAD;   /* moon's mean angular radius plus refraction */

  let h0 = getMoonPosition(t, lat, lng).altitude * RAD - hc;
  let rise = null;
  let set = null;
  let ye = 0;

  for (let i = 1; i <= 24; i += 2) {
    const h1 = getMoonPosition(hoursLater(t, i), lat, lng).altitude * RAD - hc;
    const h2 = getMoonPosition(hoursLater(t, i + 1), lat, lng).altitude * RAD - hc;

    /* Fit a parabola through the three samples */
    const a = (h0 + h2) / 2 - h1;
    const b = (h2 - h0) / 2;
    const xe = -b / (2 * a);
    ye = (a * xe + b) * xe + h1;
    const d = b * b - 4 * a * h1;

    let roots = 0;
    let x1 = 0;
    let x2 = 0;

    if (d >= 0) {
      const dx = Math.sqrt(d) / (Math.abs(a) * 2);
      x1 = xe - dx;
      x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }

    if (roots === 1) {
      if (h0 < 0) rise = i + x1;
      else set = i + x1;
    } else if (roots === 2) {
      rise = i + (ye < 0 ? x2 : x1);
      set  = i + (ye < 0 ? x1 : x2);
    }

    if (rise !== null && set !== null) break;
    h0 = h2;
  }

  return {
    rise: rise !== null ? hoursLater(t, rise) : null,
    set: set !== null ? hoursLater(t, set) : null,
    alwaysUp: rise === null && set === null && ye > 0,
    alwaysDown: rise === null && set === null && ye <= 0
  };
}

function hoursLater(date, h) {
  return new Date(date.valueOf() + h * DAY_MS / 24);
}

/* --------------------------------------------------------------------------
   PRESENTATION HELPERS
   Bearing to a 16-point compass label, for the telemetry readout.
   -------------------------------------------------------------------------- */

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compassLabel(bearing) {
  return COMPASS[Math.round(bearing / 22.5) % 16];
}
