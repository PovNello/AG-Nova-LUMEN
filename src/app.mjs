/* ==========================================================================
   L.U.M.E.N. — APPLICATION
   Wiring only. No astronomy, no geometry, no formatting happens here.

   ---------------------------------------------------------------------------
   THE TWO WORK BUDGETS
   ---------------------------------------------------------------------------
   TICK    the chronometer moved. Sun and moon positions, vectors, shadows.
           Runs up to sixty times a second under a thumb, coalesced into one
           animation frame. Nothing expensive is permitted here.

   SURVEY  the pin, the date, the timezone or the building set changed. Event
           times and the whole exposure profile. Runs on deliberate operator
           action and is allowed to take a few milliseconds.

   Keeping these apart is the difference between a slider that feels like
   hardware and one that feels like a web page.
   ========================================================================== */

import {
  getSunPosition, getMoonPosition, getMoonIllumination,
  getSunTimes, getMoonTimes
} from './core/astro.mjs';

import {
  registerZoneResolver, zoneFor, wallToInstant, localDayStart,
  instantToWall, minutesOfDay, formatDate, isoDateToWall, wallToISODate,
  DEVICE_ZONE
} from './core/time.mjs';

import * as state from './core/state.mjs';
import { CHANGE } from './core/state.mjs';
import { extractBuildings, MIN_SHADOW_ZOOM } from './core/buildings.mjs';
import { computeExposure, tagGoldenWindows } from './core/exposure.mjs';
import { ChartView } from './render/map.mjs';
import { ShadowLayer } from './render/shadows.mjs';
import { Console } from './render/console.mjs';
import { Chronometer } from './render/chronometer.mjs';
import { SERVICES, DEFAULT_VIEW, BUILDING_LAYERS } from './config/services.js';

/* -------------------------------------------------------------------------- */

let chart, shadows, panel, chrono;
let tickQueued = false;
let surveyTimer = null;

boot();

async function boot() {
  /* The timezone resolver is optional. If the data file is missing the tool
     still runs, but every time on screen becomes the device's idea of the
     time, and that must be said out loud rather than assumed away. */
  if (typeof window.tzlookup === 'function') {
    registerZoneResolver(window.tzlookup);
  }

  panel = new Console(document.querySelector('[data-console]'));

  chrono = new Chronometer(document.querySelector('[data-chrono]'), {
    onChange: setMinutes
  });

  chart = new ChartView(document.getElementById('chart'), {
    onPin: setPin,
    onIdle: onMapIdle,
    onMove: onMapMove
  });

  /* The shadow layer measures and observes the chart container itself. It
     asks for a redraw when it resizes rather than being driven from outside. */
  shadows = new ShadowLayer(document.getElementById('chart'), scheduleTick);

  wireControls();

  /* Initial position: a shared link wins, then the default view. Geolocation
     is never requested unprompted; it is a button. */
  const shared = state.fromHash(location.hash);
  const start = {
    lat: shared?.lat ?? DEFAULT_VIEW.lat,
    lng: shared?.lng ?? DEFAULT_VIEW.lng,
    zoom: shared?.zoom ?? DEFAULT_VIEW.zoom
  };

  const zone = zoneFor(start.lat, start.lng);
  const now = new Date();
  const wall = instantToWall(zone.zone, now);

  state.set({
    lat: start.lat,
    lng: start.lng,
    zoom: start.zoom,
    center: { lng: start.lng, lat: start.lat },
    zone: zone.zone,
    zoneResolved: zone.resolved,
    year: shared?.year ?? wall.year,
    month: shared?.month ?? wall.month,
    day: shared?.day ?? wall.day,
    minutes: shared?.minutes ?? wall.minutes,
    shadowsEnabled: shared?.shadowsEnabled ?? true
  }, []);

  chart.jumpTo(start.lng, start.lat, start.zoom);

  chart.onceReady(() => {
    document.body.classList.add('is-ready');
    resize();
    survey();
    state.setStatus(
      zone.resolved
        ? 'TELEMETRY ONLINE'
        : 'TIMEZONE LOOKUP UNAVAILABLE \u00B7 USING DEVICE ZONE',
      zone.resolved ? 'ok' : 'warn',
      zone.resolved ? 3500 : 12000
    );
  });

  window.addEventListener('resize', resize);
  registerSubscribers();
  syncDateInput();
}

/* --------------------------------------------------------------------------
   SUBSCRIBERS
   -------------------------------------------------------------------------- */

function registerSubscribers() {
  state.on(CHANGE.TICK, s => {
    panel.renderTick(s);
    chrono.renderTick(s);
    paintOverlays(s);
  });

  state.on(CHANGE.SURVEY, s => {
    panel.renderLocation(s);
    panel.renderTimeline(s);
    panel.renderExposure(s);
    chrono.renderDay(s);
    syncDateInput();
  });

  state.on(CHANGE.BUILDINGS, s => {
    panel.renderSurfaceModel(s);
    panel.renderExposure(s);
  });

  state.on(CHANGE.STATUS, s => {
    const el = document.querySelector('[data-status]');
    if (!el) return;
    if (!s.status) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent = s.status.text;
    el.className = 'lumen-status is-' + s.status.kind;
  });
}

/* --------------------------------------------------------------------------
   THE TICK PATH — cheap, frequent
   -------------------------------------------------------------------------- */

function setMinutes(minutes) {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  const s = state.get();
  if (s.minutes === clamped) return;

  state.set({ minutes: clamped }, []);
  scheduleTick();
  state.scheduleHashSync();
}

/**
 * Coalesce every tick request into a single animation frame. Dragging a
 * slider fires far more input events than there are frames to draw, and
 * recomputing per event is how a scrub turns to treacle.
 */
function scheduleTick() {
  if (tickQueued) return;
  tickQueued = true;
  requestAnimationFrame(() => {
    tickQueued = false;
    recomputeInstant();
    state.emit(CHANGE.TICK);
  });
}

function recomputeInstant() {
  const s = state.get();
  const instant = wallToInstant(s.zone, s.year, s.month, s.day, s.minutes);

  state.set({
    instant,
    sun: getSunPosition(instant, s.lat, s.lng),
    moon: getMoonPosition(instant, s.lat, s.lng),
    moonIllumination: getMoonIllumination(instant)
  }, []);
}

/**
 * Redraw both overlays from a SINGLE measurement of the chart.
 *
 * The size is read once, here, and handed to the vector layer and the shadow
 * layer together. Neither is allowed to measure anything itself.
 *
 * This is the whole point. Two overlays projecting the same geography with
 * independently obtained viewport dimensions will eventually be given
 * different numbers — during layout, on a device pixel ratio change, on a
 * font load — and when that happens the result does not look like a sizing
 * fault. It looks like the map is lying: shadows displaced upward by half the
 * difference, clipped along a clean horizontal edge, with the vectors still
 * perfectly placed beside them.
 *
 * One measurement, one truth.
 */
function paintOverlays(s) {
  if (!chart) return;

  const size = chart.getSize();
  if (!size.width || !size.height) return;

  chart.drawVectors(s, size);

  if (!shadows) return;

  const belowZoom = chart.getZoom() < MIN_SHADOW_ZOOM;

  if (!s.shadowsEnabled || belowZoom || !s.sun) {
    shadows.clear();
    return;
  }

  shadows.render({
    buildings: s.buildings,
    center: chart.getCenter(),
    zoom: chart.getZoom(),
    width: size.width,
    height: size.height,
    sunAzimuth: s.sun.azimuth,
    sunAltitude: s.sun.altitude,
    showFootprints: s.footprintsEnabled
  });
}

/* --------------------------------------------------------------------------
   THE SURVEY PATH — expensive, deliberate
   -------------------------------------------------------------------------- */

function survey() {
  const s = state.get();

  const dayStart = localDayStart(s.zone, s.year, s.month, s.day);
  const noonish = new Date(dayStart.valueOf() + 12 * 3600000);

  const sunTimes = getSunTimes(noonish, s.lat, s.lng);
  const moonTimes = getMoonTimes(dayStart, s.lat, s.lng);

  /* Bearing of the sun at the moment it crosses the horizon. These are the
     operational limits drawn on the chart, and they are computed from the
     event instants rather than approximated, so they stay correct at high
     latitudes where the sun skims the horizon for hours. */
  const sunriseAzimuth = sunTimes.sunrise
    ? getSunPosition(sunTimes.sunrise, s.lat, s.lng).azimuth : null;
  const sunsetAzimuth = sunTimes.sunset
    ? getSunPosition(sunTimes.sunset, s.lat, s.lng).azimuth : null;

  state.set({ dayStart, sunTimes, moonTimes, sunriseAzimuth, sunsetAzimuth }, []);

  recomputeInstant();
  recomputeExposure();

  state.emit([CHANGE.SURVEY, CHANGE.TICK]);
}

function recomputeExposure() {
  const s = state.get();

  if (!s.buildings.length || !s.dayStart) {
    state.set({ exposure: null }, []);
    return;
  }

  const exposure = computeExposure({
    lat: s.lat, lng: s.lng,
    dayStart: s.dayStart,
    buildings: s.buildings,
    zone: s.zone
  });

  tagGoldenWindows(exposure.windows, s.sunTimes, t => minutesOfDay(s.zone, t));
  state.set({ exposure }, []);
}

/**
 * The map settled. Re-read the surface model.
 *
 * Debounced rather than immediate: panning fires idle repeatedly, and
 * re-extracting a few thousand footprints on each one is wasted work.
 */
function onMapIdle() {
  clearTimeout(surveyTimer);
  surveyTimer = setTimeout(() => {
    const { buildings, stats } = extractBuildings(chart.map, BUILDING_LAYERS);
    state.set({ buildings, buildingStats: stats }, []);
    recomputeExposure();
    state.emit(CHANGE.BUILDINGS);
    scheduleTick();
  }, 140);
}

function onMapMove() {
  /* Both overlays are anchored to geography, so they follow the map
     continuously rather than snapping when it stops. */
  paintOverlays(state.get());
}

/* --------------------------------------------------------------------------
   OPERATOR ACTIONS
   -------------------------------------------------------------------------- */

function setPin(lng, lat) {
  const s = state.get();
  const zone = zoneFor(lat, lng);

  const patch = { lat, lng, zone: zone.zone, zoneResolved: zone.resolved };

  /* Crossing into a different timezone must preserve the WALL CLOCK the
     operator selected, not the absolute instant. If they were looking at
     07:00 in Bologna and drop a pin in Reykjavik, they want 07:00 there —
     they are planning a morning, not converting a timestamp. */
  if (zone.zone !== s.zone) {
    state.setStatus(`TIMEZONE \u2192 ${zone.zone.replace(/_/g, ' ').toUpperCase()}`, 'info', 5000);
  }

  state.set(patch, []);
  survey();
  state.scheduleHashSync();
}

function setDate(year, month, day) {
  state.set({ year, month, day }, []);
  survey();
  state.scheduleHashSync();
}

function stepDay(delta) {
  const s = state.get();
  const d = new Date(Date.UTC(s.year, s.month, s.day));
  d.setUTCDate(d.getUTCDate() + delta);
  setDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function goToNow() {
  const s = state.get();
  const wall = instantToWall(s.zone, new Date());
  state.set({ year: wall.year, month: wall.month, day: wall.day, minutes: wall.minutes }, []);
  survey();
  state.scheduleHashSync();
  state.setStatus('SYNCHRONISED TO CURRENT INSTANT', 'ok', 2500);
}

function locate() {
  if (!navigator.geolocation) {
    state.setStatus('GEOLOCATION UNSUPPORTED ON THIS DEVICE', 'warn');
    return;
  }

  state.setStatus('ACQUIRING POSITION\u2026', 'info', 15000);

  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude } = pos.coords;
      chart.flyTo(longitude, latitude, Math.max(chart.getZoom(), 16.5));
      setPin(longitude, latitude);
      state.setStatus('POSITION ACQUIRED', 'ok', 2500);
    },
    err => {
      /* Denial is a normal outcome, not a failure. Say what happened and
         leave the two working alternatives obvious. */
      const msg = err.code === err.PERMISSION_DENIED
        ? 'POSITION DENIED \u00B7 PLACE THE PIN MANUALLY'
        : 'POSITION UNAVAILABLE \u00B7 PLACE THE PIN MANUALLY';
      state.setStatus(msg, 'warn', 7000);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

/* --------------------------------------------------------------------------
   GEOCODER
   The most fragile dependency in the project, and the least important.
   Everything it does can also be done by clicking the map.
   -------------------------------------------------------------------------- */

let lastQueryAt = 0;

async function search(query) {
  if (!SERVICES.geocoder.enabled || !query.trim()) return;

  const since = Date.now() - lastQueryAt;
  if (since < SERVICES.geocoder.minIntervalMs) {
    state.setStatus('QUERY RATE LIMITED \u00B7 WAIT A MOMENT', 'warn', 2500);
    return;
  }
  lastQueryAt = Date.now();

  state.setStatus('QUERYING GAZETTEER\u2026', 'info', 10000);

  try {
    const url = new URL(SERVICES.geocoder.url);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(SERVICES.geocoder.limit));

    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const results = await res.json();
    if (!results.length) {
      state.setStatus('NO MATCH FOUND', 'warn', 4000);
      return;
    }

    const hit = results[0];
    const lat = parseFloat(hit.lat);
    const lng = parseFloat(hit.lon);

    chart.flyTo(lng, lat, 16.2);
    setPin(lng, lat);
    state.setStatus((hit.display_name || query).toUpperCase().slice(0, 64), 'ok', 5000);

  } catch (err) {
    state.setStatus('GAZETTEER UNREACHABLE \u00B7 PLACE THE PIN MANUALLY', 'warn', 7000);
  }
}

/* --------------------------------------------------------------------------
   CONTROLS
   -------------------------------------------------------------------------- */

function wireControls() {
  const byAction = {
    'locate': locate,
    'now': goToNow,
    'day-prev': () => stepDay(-1),
    'day-next': () => stepDay(1),
    'zoom-in': () => chart.map.zoomIn(),
    'zoom-out': () => chart.map.zoomOut(),
    'share': copyLink
  };

  for (const [action, fn] of Object.entries(byAction)) {
    for (const el of document.querySelectorAll(`[data-action="${action}"]`)) {
      el.addEventListener('click', fn);
    }
  }

  const dateInput = document.querySelector('[data-date-input]');
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const w = isoDateToWall(dateInput.value);
      if (w) setDate(w.year, w.month, w.day);
    });
  }

  const form = document.querySelector('[data-search-form]');
  if (form) {
    form.addEventListener('submit', e => {
      e.preventDefault();
      const input = form.querySelector('input');
      search(input.value);
      input.blur();
    });
  }

  for (const toggle of document.querySelectorAll('[data-toggle]')) {
    toggle.addEventListener('click', () => {
      const key = toggle.dataset.toggle;
      const s = state.get();
      const next = !s[key];
      state.set({ [key]: next }, []);
      toggle.setAttribute('aria-pressed', String(next));
      scheduleTick();
      state.scheduleHashSync();
    });
    const s = state.get();
    toggle.setAttribute('aria-pressed', String(!!s[toggle.dataset.toggle]));
  }

  for (const panelToggle of document.querySelectorAll('[data-collapse]')) {
    panelToggle.addEventListener('click', () => {
      const target = document.getElementById(panelToggle.dataset.collapse);
      if (!target) return;
      const open = target.hasAttribute('hidden');
      if (open) target.removeAttribute('hidden');
      else target.setAttribute('hidden', '');
      panelToggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* Keyboard: the chronometer is the thing worth reaching without a pointer. */
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea')) return;
    const s = state.get();
    const big = e.shiftKey ? 60 : 10;

    if (e.key === 'ArrowLeft')  { setMinutes(s.minutes - big); e.preventDefault(); }
    if (e.key === 'ArrowRight') { setMinutes(s.minutes + big); e.preventDefault(); }
    if (e.key === 'ArrowUp')    { stepDay(1); e.preventDefault(); }
    if (e.key === 'ArrowDown')  { stepDay(-1); e.preventDefault(); }
    if (e.key === 'n' || e.key === 'N') goToNow();
  });
}

async function copyLink() {
  const url = location.origin + location.pathname + state.toHash();
  try {
    await navigator.clipboard.writeText(url);
    state.setStatus('LINK COPIED TO CLIPBOARD', 'ok', 3000);
  } catch (_) {
    /* Clipboard access is refused in plenty of legitimate contexts. Put the
       address bar in the right state so the operator can copy it themselves
       rather than losing the plan entirely. */
    history.replaceState(null, '', state.toHash());
    state.setStatus('LINK IN ADDRESS BAR \u00B7 COPY MANUALLY', 'info', 6000);
  }
}

function syncDateInput() {
  const el = document.querySelector('[data-date-input]');
  const label = document.querySelector('[data-date-label]');
  const s = state.get();

  if (el) el.value = wallToISODate(s);
  if (label && s.dayStart) label.textContent = formatDate(s.zone, s.dayStart);
}

/**
 * Tell the map its container moved, and redraw.
 *
 * The shadow layer is deliberately NOT resized from here. It observes the
 * container itself and re-synchronises on its own, which removes the
 * ordering hazard this function used to contain: it read the map canvas
 * size, sized the shadow surface from it, and only then let the map grow to
 * fill its container. The shadow surface stayed at the stale size for the
 * lifetime of the page.
 */
function resize() {
  chart.resize();
  scheduleTick();
}
