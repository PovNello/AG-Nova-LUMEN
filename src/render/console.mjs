/* ==========================================================================
   L.U.M.E.N. — RENDER / CONSOLE
   Telemetry readouts, event timeline, exposure profile, surface model.

   Every value the instrument reports is real text in the DOM. Nothing is
   canvas-only. A screen reader can read it, and the operator can select and
   copy any figure straight into a note.
   ========================================================================== */

import { compassLabel } from '../core/astro.mjs';
import {
  formatClock, formatUTC, formatMinutes, formatDuration,
  offsetLabel, minutesOfDay
} from '../core/time.mjs';
import { STATE } from '../core/exposure.mjs';
import { MIN_SHADOW_ZOOM } from '../core/buildings.mjs';

const EM_DASH = '\u2014';

/* The daily timeline, in the order the day actually happens. Grouped so the
   morning and evening halves read as mirror images, which is how a
   photographer thinks about a day. */
const TIMELINE = [
  { key: 'nightEnd',      label: 'ASTRONOMICAL DAWN', tone: 'muted'  },
  { key: 'nauticalDawn',  label: 'NAUTICAL DAWN',     tone: 'muted'  },
  { key: 'dawn',          label: 'CIVIL DAWN',        tone: 'muted'  },
  { key: 'sunrise',       label: 'SUNRISE',           tone: 'cyan'   },
  { key: 'goldenHourEnd', label: 'GOLDEN HOUR END',   tone: 'orange' },
  { key: 'solarNoon',     label: 'SOLAR NOON',        tone: 'cyan'   },
  { key: 'goldenHour',    label: 'GOLDEN HOUR START', tone: 'orange' },
  { key: 'sunset',        label: 'SUNSET',            tone: 'cyan'   },
  { key: 'dusk',          label: 'CIVIL DUSK',        tone: 'muted'  },
  { key: 'nauticalDusk',  label: 'NAUTICAL DUSK',     tone: 'muted'  },
  { key: 'night',         label: 'ASTRONOMICAL DUSK', tone: 'muted'  }
];

export class Console {
  constructor(root) {
    this.root = root;
    this.el = {};

    /* Bind every element carrying a data-field once, rather than querying the
       document on every tick. */
    for (const node of root.querySelectorAll('[data-field]')) {
      this.el[node.dataset.field] = node;
    }

    this.timelineHost = root.querySelector('[data-timeline]');
    this.windowHost = root.querySelector('[data-windows]');
    this.exposureBar = root.querySelector('[data-exposure-bar]');

    this.timelineRows = null;
    this.exposureSegments = null;
  }

  set(field, value) {
    const node = this.el[field];
    if (node && node.textContent !== value) node.textContent = value;
  }

  setClass(field, cls) {
    const node = this.el[field];
    if (!node) return;
    node.className = cls;
  }

  /* ------------------------------------------------------------------------
     LIVE READOUTS — updated on every chronometer tick
     ------------------------------------------------------------------------ */

  renderTick(s) {
    this.set('clock', formatMinutes(s.minutes));
    this.set('clockUtc', formatUTC(s.instant));

    if (s.sun) {
      const up = s.sun.altitude > 0;
      this.set('sunAz', `${s.sun.azimuth.toFixed(1)}\u00B0`);
      this.set('sunAzLabel', compassLabel(s.sun.azimuth));
      this.set('sunAlt', `${s.sun.altitude.toFixed(1)}\u00B0`);
      this.set('sunState', up ? 'ABOVE HORIZON' : 'BELOW HORIZON');
      this.setClass('sunAlt',
        'nova-data__value ' + (up ? 'nova-data__value--nominal' : ''));

      /* Shadow length for a notional two metre subject: the figure a
         photographer can actually picture. Meaningless below the horizon. */
      if (up) {
        const ratio = 1 / Math.tan(s.sun.altitude * Math.PI / 180);
        this.set('shadowRatio', `${(ratio * 2).toFixed(1)} M PER 2 M`);
      } else {
        this.set('shadowRatio', EM_DASH);
      }
    }

    if (s.moon && s.moonIllumination) {
      const up = s.moon.altitude > 0;
      this.set('moonAz', `${s.moon.azimuth.toFixed(1)}\u00B0`);
      this.set('moonAzLabel', compassLabel(s.moon.azimuth));
      this.set('moonAlt', `${s.moon.altitude.toFixed(1)}\u00B0`);
      this.set('moonState', up ? 'ABOVE HORIZON' : 'BELOW HORIZON');
      this.set('moonPhase', s.moonIllumination.name);
      this.set('moonFraction', `${(s.moonIllumination.fraction * 100).toFixed(0)}%`);
      this.set('moonDistance', `${Math.round(s.moon.distance).toLocaleString('en-GB')} KM`);
    }

    this.highlightTimeline(s);
    this.highlightExposure(s);
  }

  /* ------------------------------------------------------------------------
     PIN AND ZONE
     ------------------------------------------------------------------------ */

  renderLocation(s) {
    this.set('lat', formatCoord(s.lat, 'N', 'S'));
    this.set('lng', formatCoord(s.lng, 'E', 'W'));
    this.set('zone', s.zone.replace(/_/g, ' ').toUpperCase());
    this.set('offset', s.instant ? offsetLabel(s.zone, s.instant) : EM_DASH);

    /* A degraded timezone is not a footnote. If the pin's real zone could not
       be resolved, every time on screen is the device's idea of the time, and
       the operator has to know that before they plan a journey around it. */
    const warn = this.el.zoneWarning;
    if (warn) {
      warn.hidden = s.zoneResolved;
    }
  }

  /* ------------------------------------------------------------------------
     EVENT TIMELINE
     ------------------------------------------------------------------------ */

  renderTimeline(s) {
    if (!this.timelineHost) return;

    if (!this.timelineRows) {
      this.timelineHost.innerHTML = '';
      this.timelineRows = new Map();

      for (const ev of TIMELINE) {
        const row = document.createElement('div');
        row.className = 'nova-data__row lumen-event';

        const label = document.createElement('span');
        label.className = 'nova-data__label';
        label.textContent = ev.label;

        const value = document.createElement('span');
        value.className = 'nova-data__value lumen-event__time';

        row.append(label, value);
        this.timelineHost.appendChild(row);
        this.timelineRows.set(ev.key, { row, value, tone: ev.tone });
      }

      /* Moon events sit below a rule: they belong to the same day but to a
         different body, and merging them into the solar sequence would imply
         an ordering that does not exist. */
      const sep = document.createElement('div');
      sep.className = 'lumen-event-separator';
      sep.textContent = 'LUNAR';
      this.timelineHost.appendChild(sep);

      for (const [key, label] of [['moonrise', 'MOONRISE'], ['moonset', 'MOONSET']]) {
        const row = document.createElement('div');
        row.className = 'nova-data__row lumen-event lumen-event--lunar';
        const l = document.createElement('span');
        l.className = 'nova-data__label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'nova-data__value lumen-event__time';
        row.append(l, v);
        this.timelineHost.appendChild(row);
        this.timelineRows.set(key, { row, value: v, tone: 'ivory' });
      }
    }

    for (const ev of TIMELINE) {
      const entry = this.timelineRows.get(ev.key);
      const t = s.sunTimes ? s.sunTimes[ev.key] : null;
      entry.value.textContent = t ? formatClock(s.zone, t) : EM_DASH;
      entry.row.classList.toggle('is-absent', !t);
    }

    const mt = s.moonTimes || {};
    const riseEntry = this.timelineRows.get('moonrise');
    const setEntry = this.timelineRows.get('moonset');

    if (mt.alwaysUp) {
      riseEntry.value.textContent = 'ALWAYS UP';
      setEntry.value.textContent = 'ALWAYS UP';
    } else if (mt.alwaysDown) {
      riseEntry.value.textContent = 'NEVER RISES';
      setEntry.value.textContent = 'NEVER RISES';
    } else {
      riseEntry.value.textContent = mt.rise ? formatClock(s.zone, mt.rise) : EM_DASH;
      setEntry.value.textContent = mt.set ? formatClock(s.zone, mt.set) : EM_DASH;
    }
  }

  /**
   * Mark which phase of the day the chronometer is currently sitting in.
   * A single highlight, moving as the operator scrubs.
   */
  highlightTimeline(s) {
    if (!this.timelineRows || !s.sunTimes) return;

    let activeKey = null;
    let bestDelta = Infinity;

    for (const ev of TIMELINE) {
      const t = s.sunTimes[ev.key];
      if (!t) continue;
      const m = minutesOfDay(s.zone, t);
      if (m === null) continue;
      const delta = s.minutes - m;
      /* The most recent event that has already happened. */
      if (delta >= 0 && delta < bestDelta) {
        bestDelta = delta;
        activeKey = ev.key;
      }
    }

    for (const [key, entry] of this.timelineRows) {
      entry.row.classList.toggle('is-current', key === activeKey);
    }
  }

  /* ------------------------------------------------------------------------
     SURFACE MODEL
     ------------------------------------------------------------------------ */

  renderSurfaceModel(s) {
    const st = s.buildingStats;

    if (!st || st.belowZoom) {
      this.set('structures', EM_DASH);
      this.set('measured', EM_DASH);
      this.set('estimated', EM_DASH);
      this.set('confidence', EM_DASH);
      this.set('modelState', `ZOOM IN TO ${MIN_SHADOW_ZOOM} FOR SURFACE DATA`);
      this.setClass('modelState', 'nova-panel__state lumen-model-state is-idle');
      return;
    }

    this.set('structures', String(st.total));
    this.set('measured', String(st.measured));
    this.set('estimated', String(st.estimated));
    this.set('confidence', `${Math.round(st.confidence * 100)}%`);

    if (st.truncated) {
      this.set('modelState', 'STRUCTURE LIMIT REACHED \u00B7 ZOOM IN');
      this.setClass('modelState', 'nova-panel__state lumen-model-state is-warning');
    } else if (st.total === 0) {
      this.set('modelState', 'NO STRUCTURES IN VIEW');
      this.setClass('modelState', 'nova-panel__state lumen-model-state is-idle');
    } else {
      this.set('modelState', 'SURFACE MODEL ACQUIRED');
      this.setClass('modelState', 'nova-panel__state lumen-model-state is-ok');
    }
  }

  /* ------------------------------------------------------------------------
     EXPOSURE PROFILE
     ------------------------------------------------------------------------ */

  renderExposure(s) {
    const ex = s.exposure;

    if (!this.exposureSegments && this.exposureBar) {
      this.exposureBar.innerHTML = '';
      this.exposureSegments = [];
      const count = 144;
      for (let i = 0; i < count; i++) {
        const seg = document.createElement('span');
        seg.className = 'lumen-exposure__seg';
        this.exposureBar.appendChild(seg);
        this.exposureSegments.push(seg);
      }
    }

    if (!ex) {
      this.set('exposureTotal', EM_DASH);
      this.set('exposureState', 'AWAITING SURFACE MODEL');
      if (this.exposureSegments) {
        for (const seg of this.exposureSegments) seg.className = 'lumen-exposure__seg';
      }
      if (this.windowHost) this.windowHost.innerHTML = '';
      return;
    }

    if (this.exposureSegments) {
      for (let i = 0; i < this.exposureSegments.length; i++) {
        const v = ex.samples[i];
        const cls = v === STATE.SUNLIT ? 'is-sunlit'
                  : v === STATE.SHADED ? 'is-shaded'
                  : 'is-night';
        const seg = this.exposureSegments[i];
        const next = 'lumen-exposure__seg ' + cls;
        if (seg.className !== next && !seg.classList.contains('is-cursor')) {
          seg.className = next;
        }
        seg.dataset.state = cls;
      }
    }

    this.set('exposureTotal', formatDuration(ex.totals.sunlitMinutes));
    this.set('exposureShaded', formatDuration(ex.totals.shadedMinutes));
    this.set('exposureDaylight', formatDuration(ex.totals.daylightMinutes));

    if (ex.inside) {
      this.set('exposureState', 'PIN IS INSIDE A STRUCTURE');
      this.setClass('exposureState', 'lumen-model-state is-warning');
    } else if (!ex.obstructed) {
      this.set('exposureState', 'NO OBSTRUCTION DETECTED');
      this.setClass('exposureState', 'lumen-model-state is-ok');
    } else {
      this.set('exposureState', `${ex.windows.length} DIRECT LIGHT WINDOW${ex.windows.length === 1 ? '' : 'S'}`);
      this.setClass('exposureState', 'lumen-model-state is-ok');
    }

    this.renderWindows(ex);
  }

  renderWindows(ex) {
    if (!this.windowHost) return;
    this.windowHost.innerHTML = '';

    if (!ex.windows.length) {
      const empty = document.createElement('div');
      empty.className = 'nova-empty';
      empty.textContent = 'NO DIRECT LIGHT AT THIS POINT';
      this.windowHost.appendChild(empty);
      return;
    }

    ex.windows.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'lumen-window' + (w.golden ? ' is-golden' : '');

      const id = document.createElement('span');
      id.className = 'lumen-window__id';
      id.textContent = pad(i + 1);

      const range = document.createElement('span');
      range.className = 'lumen-window__range';
      range.textContent =
        `${formatMinutes(w.startMinutes)} \u2013 ${formatMinutes(w.endMinutes)}`;

      const dur = document.createElement('span');
      dur.className = 'lumen-window__dur';
      dur.textContent = formatDuration(w.durationMinutes);

      row.append(id, range, dur);

      if (w.golden) {
        const tag = document.createElement('span');
        tag.className = 'lumen-window__tag';
        tag.textContent = 'GOLDEN';
        row.appendChild(tag);
      }

      this.windowHost.appendChild(row);
    });
  }

  /** Move the cursor mark along the exposure bar as the chronometer scrubs. */
  highlightExposure(s) {
    if (!this.exposureSegments || !s.exposure) return;

    const index = Math.min(
      this.exposureSegments.length - 1,
      Math.floor(s.minutes / 10)
    );

    if (this.exposureCursor === index) return;

    if (this.exposureCursor !== undefined) {
      const prev = this.exposureSegments[this.exposureCursor];
      if (prev) prev.classList.remove('is-cursor');
    }

    const seg = this.exposureSegments[index];
    if (seg) seg.classList.add('is-cursor');
    this.exposureCursor = index;
  }
}

/* -------------------------------------------------------------------------- */

function formatCoord(value, pos, neg) {
  const hemi = value >= 0 ? pos : neg;
  const a = Math.abs(value);
  const deg = Math.floor(a);
  const minFull = (a - deg) * 60;
  const min = Math.floor(minFull);
  const sec = (minFull - min) * 60;
  return `${hemi} ${pad(deg)}\u00B0 ${pad(min)}' ${sec.toFixed(1).padStart(4, '0')}"`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
