/* ==========================================================================
   L.U.M.E.N. — CORE / STATE
   One object, one notification path, no framework.

   ---------------------------------------------------------------------------
   THE MODEL
   ---------------------------------------------------------------------------
   Everything the interface displays is a pure function of the state below.
   Renderers subscribe; they never talk to each other and they never hold
   their own copies of anything.

   Two kinds of change are distinguished, because they cost very different
   amounts of work:

     TICK    the chronometer moved. Sun position changes, shadows are redrawn.
             Happens sixty times a second while a thumb is on the slider, so
             nothing expensive may run here.

     SURVEY  the pin, the date or the building set changed. The exposure
             profile and the event timeline are recomputed. Happens on
             deliberate operator action, so it may take a few milliseconds.

   Conflating the two is how a slider becomes treacle.
   ========================================================================== */

import { DEFAULT_VIEW } from '../config/services.js';

export const CHANGE = {
  TICK: 'tick',
  SURVEY: 'survey',
  BUILDINGS: 'buildings',
  VIEW: 'view',
  STATUS: 'status'
};

const state = {
  /* Telemetry pin */
  lng: DEFAULT_VIEW.lng,
  lat: DEFAULT_VIEW.lat,

  /* Map view. Tracked separately from the pin: the operator can pan away from
     the pin to inspect shadows elsewhere without losing their subject. */
  center: { lng: DEFAULT_VIEW.lng, lat: DEFAULT_VIEW.lat },
  zoom: DEFAULT_VIEW.zoom,

  /* Wall-clock selection at the pin. month is 0-based. */
  year: 0, month: 0, day: 0,
  minutes: 0,

  /* Resolved timezone for the pin */
  zone: 'UTC',
  zoneResolved: false,

  /* Derived, recomputed by the application on the appropriate change */
  sun: null,
  moon: null,
  moonIllumination: null,
  sunTimes: null,
  moonTimes: null,
  dayStart: null,
  instant: null,

  /* Surface model */
  buildings: [],
  buildingStats: null,
  exposure: null,

  /* Operator toggles */
  shadowsEnabled: true,
  footprintsEnabled: true,

  /* Transient interface state */
  status: null,
  locating: false
};

const subscribers = new Map();

/** Read-only view of the state. Treat the returned object as frozen. */
export function get() {
  return state;
}

/**
 * Subscribe to one class of change.
 * @param {string} channel  one of CHANGE
 * @param {Function} fn
 */
export function on(channel, fn) {
  if (!subscribers.has(channel)) subscribers.set(channel, new Set());
  subscribers.get(channel).add(fn);
  return () => subscribers.get(channel).delete(fn);
}

/**
 * Mutate the state and notify.
 *
 * @param {Object} patch
 * @param {string|string[]} channels  which subscriber sets to wake
 */
export function set(patch, channels) {
  Object.assign(state, patch);
  emit(channels);
}

export function emit(channels) {
  const list = Array.isArray(channels) ? channels : [channels];
  for (const ch of list) {
    const subs = subscribers.get(ch);
    if (!subs) continue;
    for (const fn of subs) {
      try {
        fn(state);
      } catch (err) {
        /* A broken renderer must not take the rest of the instrument down
           with it. Report and carry on. */
        console.error(`[lumen] subscriber failed on "${ch}"`, err);
      }
    }
  }
}

/* --------------------------------------------------------------------------
   STATUS LINE
   Short operator-facing messages. Not errors thrown into the console where
   nobody will see them.
   -------------------------------------------------------------------------- */

let statusTimer = null;

export function setStatus(text, kind = 'info', holdMs = 5000) {
  clearTimeout(statusTimer);
  set({ status: text ? { text, kind } : null }, CHANGE.STATUS);
  if (text && holdMs > 0) {
    statusTimer = setTimeout(() => set({ status: null }, CHANGE.STATUS), holdMs);
  }
}

/* --------------------------------------------------------------------------
   URL STATE

   The address bar is the only persistence this tool has. No accounts, no
   local database, no cookies. A link is a saved plan, and it survives being
   pasted into a message to somebody else.
   -------------------------------------------------------------------------- */

const HASH_VERSION = '1';

export function toHash() {
  const p = new URLSearchParams();
  p.set('v', HASH_VERSION);
  p.set('at', `${state.lat.toFixed(6)},${state.lng.toFixed(6)}`);
  p.set('z', state.zoom.toFixed(2));
  p.set('d', `${state.year}-${pad(state.month + 1)}-${pad(state.day)}`);
  p.set('t', String(Math.round(state.minutes)));
  if (!state.shadowsEnabled) p.set('sh', '0');
  return '#' + p.toString();
}

/**
 * Parse a shared link. Returns null when there is nothing usable, so the
 * caller can fall back to the default view without special cases.
 *
 * Deliberately tolerant: a truncated or hand-edited link should degrade to a
 * sensible view rather than to an error page.
 */
export function fromHash(hash) {
  if (!hash || hash.length < 2) return null;

  const p = new URLSearchParams(hash.slice(1));
  const out = {};

  const at = p.get('at');
  if (at) {
    const [lat, lng] = at.split(',').map(Number);
    if (isFinite(lat) && isFinite(lng) &&
        Math.abs(lat) <= 85 && Math.abs(lng) <= 180) {
      out.lat = lat;
      out.lng = lng;
    }
  }

  const z = Number(p.get('z'));
  if (isFinite(z) && z >= 1 && z <= 22) out.zoom = z;

  const d = p.get('d');
  if (d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (m) {
      out.year = +m[1];
      out.month = +m[2] - 1;
      out.day = +m[3];
    }
  }

  const t = Number(p.get('t'));
  if (isFinite(t) && t >= 0 && t < 1440) out.minutes = Math.round(t);

  if (p.get('sh') === '0') out.shadowsEnabled = false;

  return Object.keys(out).length ? out : null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/* Writing to the address bar on every slider tick would flood the browser's
   history and stutter the scrub. Coalesce. */
let hashTimer = null;

export function scheduleHashSync() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const hash = toHash();
    if (location.hash !== hash) {
      history.replaceState(null, '', hash);
    }
  }, 400);
}
