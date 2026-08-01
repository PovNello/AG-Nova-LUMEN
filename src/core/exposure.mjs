/* ==========================================================================
   L.U.M.E.N. — CORE / EXPOSURE
   The daily solar exposure profile.

   ---------------------------------------------------------------------------
   THE QUESTION
   ---------------------------------------------------------------------------
   Everything else in this tool answers "where is the sun". This module
   answers the question a photographer actually asks:

       If I stand HERE, when does the light reach me?

   The shadow layer answers that visually for one instant. This answers it
   numerically for the whole day, which is what turns a visualiser into a
   planner. It is the reason the project is worth building.

   ---------------------------------------------------------------------------
   METHOD
   ---------------------------------------------------------------------------
   Sample the day at a fixed interval. At each sample, if the sun is above the
   horizon, cast a single ray from the pin along the sun's bearing and ask
   whether any building rises high enough to interrupt it:

       a building at horizontal distance d obstructs the sun at altitude alt
       when its height exceeds d * tan(alt)

   That is one multiply and one comparison per candidate building, after a
   bounding-box rejection. A hundred and forty-four samples against a few
   hundred neighbours is nothing; the whole profile computes faster than the
   frame it is drawn in.

   Recomputed when the pin or the date changes. Not while scrubbing.
   ========================================================================== */

import { getSunPosition } from './astro.mjs';
import { bearingToENU, rayPolygonDistance, pointInPolygon } from './geometry.mjs';
import { neighbourhood } from './buildings.mjs';

/* Sampling interval, minutes. Ten gives 144 samples per day: fine enough that
   a golden hour window is never missed, coarse enough to stay instant. */
export const SAMPLE_MINUTES = 10;

/* How far out to look for obstructions, metres.

   Derived rather than guessed: a 60 m building — taller than almost anything
   in a European city centre — casts about 690 m of shadow at 5 degrees of sun
   altitude. Below that altitude the light is so weak and so reddened that the
   distinction between lit and shaded stops being useful. 1200 m carries a
   comfortable margin without dragging half a city into the loop. */
export const NEIGHBOURHOOD_RADIUS_M = 1200;

export const STATE = {
  NIGHT: 0,     /* sun below the horizon                    */
  SHADED: 1,    /* sun up, but something is in the way       */
  SUNLIT: 2     /* direct light reaches the pin              */
};

/**
 * Compute the exposure profile for one local day at one point.
 *
 * @param {Object} opts
 * @param {number} opts.lat
 * @param {number} opts.lng
 * @param {Date}   opts.dayStart   absolute instant of local midnight
 * @param {Array}  opts.buildings  prepared footprints from core/buildings
 * @param {Object} opts.sunTimes   output of getSunTimes, for window tagging
 * @param {string} opts.zone
 * @returns {{samples:Uint8Array, windows:Array, totals:Object, obstructed:boolean}}
 */
export function computeExposure(opts) {
  const { lat, lng, dayStart, buildings } = opts;

  const near = neighbourhood(buildings, lng, lat, NEIGHBOURHOOD_RADIUS_M);

  /* Standing inside a building is fully obstructed by definition. Worth
     detecting explicitly: otherwise the ray escapes through a wall and the
     profile claims full sun inside a courtyard. */
  let inside = false;
  for (const b of near) {
    if (pointInPolygon(0, 0, b.poly)) { inside = true; break; }
  }

  const count = Math.ceil(1440 / SAMPLE_MINUTES);
  const samples = new Uint8Array(count);
  const altitudes = new Float32Array(count);

  const base = dayStart.valueOf();

  for (let i = 0; i < count; i++) {
    const instant = new Date(base + i * SAMPLE_MINUTES * 60000);
    const sun = getSunPosition(instant, lat, lng);
    altitudes[i] = sun.altitude;

    if (sun.altitude <= 0) {
      samples[i] = STATE.NIGHT;
      continue;
    }

    if (inside) {
      samples[i] = STATE.SHADED;
      continue;
    }

    samples[i] = isObstructed(near, sun.azimuth, sun.altitude)
      ? STATE.SHADED
      : STATE.SUNLIT;
  }

  const windows = extractWindows(samples, opts.zone, dayStart);
  const totals = summarise(samples);

  return {
    samples,
    altitudes,
    windows,
    totals,
    obstructed: totals.shadedMinutes > 0,
    inside,
    neighbourCount: near.length
  };
}

/**
 * Is the direct solar ray from the origin blocked by any neighbour?
 *
 * The ray is cast in the local east/north plane. For each building the
 * nearest intersection distance is found; the building blocks the sun if its
 * roofline is above the ray at that distance.
 */
function isObstructed(near, azimuth, altitude) {
  const dir = bearingToENU(azimuth);
  const tanAlt = Math.tan(altitude * Math.PI / 180);

  for (const b of near) {
    const d = rayPolygonDistance(dir.e, dir.n, b.poly);
    if (d === null || d <= 0) continue;

    /* Height of the sightline where it crosses this footprint. */
    const rayHeight = d * tanAlt;
    if (rayHeight < b.height) return true;
  }

  return false;
}

/* --------------------------------------------------------------------------
   WINDOWS
   -------------------------------------------------------------------------- */

/**
 * Contiguous runs of direct sunlight, as minute ranges within the local day.
 * These are what the operator reads: "the light is on this wall from 07:40
 * until 09:10".
 */
function extractWindows(samples) {
  const windows = [];
  let start = -1;

  for (let i = 0; i < samples.length; i++) {
    const lit = samples[i] === STATE.SUNLIT;

    if (lit && start === -1) start = i;

    if (!lit && start !== -1) {
      windows.push(makeWindow(start, i));
      start = -1;
    }
  }

  if (start !== -1) windows.push(makeWindow(start, samples.length));

  return windows;
}

function makeWindow(startIndex, endIndex) {
  const startMinutes = startIndex * SAMPLE_MINUTES;
  const endMinutes = Math.min(endIndex * SAMPLE_MINUTES, 1440);
  return {
    startMinutes,
    endMinutes,
    durationMinutes: endMinutes - startMinutes
  };
}

function summarise(samples) {
  let sunlit = 0, shaded = 0, night = 0;

  for (const s of samples) {
    if (s === STATE.SUNLIT) sunlit++;
    else if (s === STATE.SHADED) shaded++;
    else night++;
  }

  return {
    sunlitMinutes: sunlit * SAMPLE_MINUTES,
    shadedMinutes: shaded * SAMPLE_MINUTES,
    nightMinutes: night * SAMPLE_MINUTES,
    daylightMinutes: (sunlit + shaded) * SAMPLE_MINUTES
  };
}

/* --------------------------------------------------------------------------
   GOLDEN HOUR INTERSECTION
   -------------------------------------------------------------------------- */

/**
 * Tag the windows that overlap golden hour, because that is what the operator
 * is usually hunting. A four hour window of flat midday light is worth less
 * than twenty minutes at the right end of the day.
 *
 * @param {Array} windows
 * @param {Object} sunTimes  output of getSunTimes
 * @param {Function} toMinutes  instant -> minutes of local day, or null
 */
export function tagGoldenWindows(windows, sunTimes, toMinutes) {
  const morningEnd = toMinutes(sunTimes.goldenHourEnd);
  const eveningStart = toMinutes(sunTimes.goldenHour);
  const sunrise = toMinutes(sunTimes.sunrise);
  const sunset = toMinutes(sunTimes.sunset);

  for (const w of windows) {
    w.golden = false;

    if (sunrise !== null && morningEnd !== null &&
        overlaps(w, sunrise, morningEnd)) w.golden = true;

    if (eveningStart !== null && sunset !== null &&
        overlaps(w, eveningStart, sunset)) w.golden = true;
  }

  return windows;
}

function overlaps(w, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return w.startMinutes < hi && w.endMinutes > lo;
}
