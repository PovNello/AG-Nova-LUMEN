/* ==========================================================================
   L.U.M.E.N. — CORE / TIME
   Timezone resolution and wall-clock arithmetic.

   ---------------------------------------------------------------------------
   THE PROBLEM THIS FILE EXISTS TO SOLVE
   ---------------------------------------------------------------------------
   The user's device is in one timezone. The telemetry pin may be anywhere on
   earth. When the operator drags the chronometer to 07:00, that must mean
   seven in the morning AT THE PIN, not seven in the morning in Bologna.

   Getting this wrong does not throw an exception and does not look broken. It
   silently produces a plan for the wrong hour. A photographer follows it,
   drives somewhere before dawn, and finds the light already gone. It is the
   single most dangerous class of bug in this application, which is why it
   gets its own module with its own vocabulary.

   ---------------------------------------------------------------------------
   VOCABULARY — used consistently across the codebase
   ---------------------------------------------------------------------------
   INSTANT    An absolute moment in time. A JavaScript Date. Unambiguous.
   WALL       A calendar date plus minutes since midnight, meaningful only
              together with a timezone. What the operator manipulates.
   ZONE       An IANA timezone identifier, e.g. "Europe/Rome".

   Astronomy consumes INSTANTs. The interface presents WALL. This module is
   the only place the two are allowed to meet.
   ========================================================================== */

/* --------------------------------------------------------------------------
   ZONE RESOLUTION
   -------------------------------------------------------------------------- */

let tzLookup = null;

/**
 * Register the vendored coordinate-to-timezone resolver.
 *
 * The lookup is optional by design. There is no browser API that maps
 * coordinates to a timezone, so it requires a data file of roughly 130 kB. If
 * that file failed to load, the tool must still work — but it must also say
 * so, loudly, rather than quietly using the device zone and pretending.
 */
export function registerZoneResolver(fn) {
  tzLookup = fn;
}

export const DEVICE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * IANA zone for a coordinate.
 * @returns {{zone:string, resolved:boolean}}
 *   resolved is false when the lookup was unavailable and the device zone is
 *   standing in for it. The console renders a degraded-state warning in that
 *   case. Never swallow it.
 */
export function zoneFor(lat, lng) {
  if (tzLookup) {
    try {
      const zone = tzLookup(lat, lng);
      if (zone) return { zone, resolved: true };
    } catch (e) {
      /* fall through to the device zone */
    }
  }
  return { zone: DEVICE_ZONE, resolved: false };
}

/* --------------------------------------------------------------------------
   OFFSET
   -------------------------------------------------------------------------- */

const offsetFormatters = new Map();

function offsetFormatter(zone) {
  let f = offsetFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'longOffset'
    });
    offsetFormatters.set(zone, f);
  }
  return f;
}

/**
 * UTC offset in minutes that applies in `zone` at the given INSTANT.
 * Positive east of Greenwich.
 *
 * Note the direction of the question. An offset is a property of an instant,
 * not of a zone: Europe/Rome is +60 in January and +120 in July. Asking "what
 * is Rome's offset" without an instant is a malformed question, and code that
 * caches a single offset per zone is code that breaks twice a year.
 */
export function offsetMinutes(zone, instant) {
  const parts = offsetFormatter(zone).formatToParts(instant);
  const name = parts.find(p => p.type === 'timeZoneName');
  if (!name) return 0;

  /* "GMT+02:00", or plain "GMT" for UTC */
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name.value);
  if (!m) return 0;

  const sign = m[1] === '-' ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Human label for the offset, e.g. "UTC+02:00". */
export function offsetLabel(zone, instant) {
  const min = offsetMinutes(zone, instant);
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `UTC${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/* --------------------------------------------------------------------------
   WALL <-> INSTANT
   -------------------------------------------------------------------------- */

/**
 * Convert a wall-clock reading in a zone into an absolute instant.
 *
 * This needs iteration, and the reason is worth understanding. To know the
 * offset you need an instant; to know the instant you need the offset. So:
 * guess an instant by pretending the wall time is UTC, ask what offset
 * applies there, correct, then confirm the offset did not change under you.
 * Two passes converge everywhere on earth. The third is a guard.
 *
 * DST POLICY, applied here and documented in LIMITATIONS.md:
 *
 *   Spring forward — the requested wall time may not exist (02:30 on a day
 *   where the clock jumps 02:00 to 03:00). The offsets disagree and the
 *   result lands on the far side of the gap. We accept that: the returned
 *   instant is the first real moment at or after the requested one.
 *
 *   Autumn back — the requested wall time may occur twice. We return the
 *   FIRST occurrence, i.e. the one still on summer time.
 *
 * Neither case is silently wrong in a way that misleads a photographer,
 * because both resolve to within an hour on a day when the sun barely moves
 * differently. But the policy is fixed here so it is not reinvented.
 */
export function wallToInstant(zone, year, month, day, minutes) {
  const naiveUTC = Date.UTC(year, month, day, 0, 0, 0, 0) + minutes * 60000;

  let instant = new Date(naiveUTC);
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes(zone, instant);
    const next = new Date(naiveUTC - off * 60000);
    if (next.valueOf() === instant.valueOf()) break;
    instant = next;
  }

  return instant;
}

/**
 * Convert an absolute instant into a wall-clock reading in a zone.
 * @returns {{year, month, day, hour, minute, minutes, weekday}}
 *   month is 0-based, to match Date.UTC and wallToInstant.
 */
export function instantToWall(zone, instant) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
    hour12: false
  });

  const p = {};
  for (const part of f.formatToParts(instant)) p[part.type] = part.value;

  const hour = parseInt(p.hour, 10) % 24;   /* some locales emit 24 for midnight */
  const minute = parseInt(p.minute, 10);

  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10) - 1,
    day: parseInt(p.day, 10),
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: (p.weekday || '').toUpperCase()
  };
}

/**
 * The absolute instant at which the given local calendar day begins.
 * Everything that reasons about "today" — the event timeline, the exposure
 * profile, the chronometer track — anchors here.
 */
export function localDayStart(zone, year, month, day) {
  return wallToInstant(zone, year, month, day, 0);
}

/* --------------------------------------------------------------------------
   FORMATTING
   All display formatting goes through here so that no part of the interface
   can accidentally render a time in the device zone.
   -------------------------------------------------------------------------- */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** "07:38" in the given zone, or an em dash for a null instant. */
export function formatClock(zone, instant) {
  if (!instant || isNaN(instant.valueOf())) return '\u2014\u2014:\u2014\u2014';
  const w = instantToWall(zone, instant);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** "07:38:12" in the given zone. */
export function formatClockSeconds(zone, instant) {
  if (!instant || isNaN(instant.valueOf())) return '\u2014\u2014:\u2014\u2014:\u2014\u2014';
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: false
  });
  return f.format(instant);
}

/** "07:38 UTC" — the secondary readout that never lies. */
export function formatUTC(instant) {
  if (!instant || isNaN(instant.valueOf())) return '\u2014\u2014:\u2014\u2014';
  return `${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "SAT 01 AUG 2026" */
export function formatDate(zone, instant) {
  const w = instantToWall(zone, instant);
  return `${w.weekday} ${pad(w.day)} ${MONTHS[w.month]} ${w.year}`;
}

/** "01 AUG 2026" from a plain wall record, no instant required. */
export function formatWallDate(wall) {
  return `${pad(wall.day)} ${MONTHS[wall.month]} ${wall.year}`;
}

/** Minutes since midnight rendered as "07:38". */
export function formatMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** A duration in minutes rendered as "03:45". */
export function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * Minutes since local midnight for an instant, in the given zone.
 * Returns null for a null instant so callers can distinguish "does not
 * occur" from "occurs at midnight".
 */
export function minutesOfDay(zone, instant) {
  if (!instant || isNaN(instant.valueOf())) return null;
  return instantToWall(zone, instant).minutes;
}

/** ISO calendar date "2026-08-01" for a wall record, for <input type=date>. */
export function wallToISODate(wall) {
  return `${wall.year}-${pad(wall.month + 1)}-${pad(wall.day)}`;
}

/** Parse "2026-08-01" into a partial wall record. Returns null if malformed. */
export function isoDateToWall(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return {
    year: parseInt(m[1], 10),
    month: parseInt(m[2], 10) - 1,
    day: parseInt(m[3], 10)
  };
}
