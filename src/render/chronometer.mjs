/* ==========================================================================
   L.U.M.E.N. — RENDER / CHRONOMETER
   The signature control. A 24 hour scrubber that is also a readout.

   ---------------------------------------------------------------------------
   WHY IT IS BUILT RATHER THAN STYLED
   ---------------------------------------------------------------------------
   The track is not decoration. It is painted with the actual twilight bands
   for the selected date and location, so the operator can see the shape of
   the day before touching anything: how long the golden hour is, how far
   apart the two ends of the day sit, whether there is any night at all.

   A native range input cannot do that. But a native range input is still
   there, underneath, carrying keyboard and assistive technology support. The
   painted surface is a skin over a real control, never a replacement for one.
   ========================================================================== */

import { formatMinutes } from '../core/time.mjs';
import { minutesOfDay } from '../core/time.mjs';

/* Phases of the day, from darkest outward. Painted in this order so each band
   overwrites the one before it, which means the boundaries never need to be
   computed as intervals: only as a sequence of nested spans. */
const BANDS = [
  { from: 'nightEnd',      to: 'night',        cls: 'astro'   },
  { from: 'nauticalDawn',  to: 'nauticalDusk', cls: 'nautical' },
  { from: 'dawn',          to: 'dusk',         cls: 'civil'   },
  { from: 'sunrise',       to: 'sunset',       cls: 'day'     }
];

export class Chronometer {
  constructor(root, { onChange }) {
    this.root = root;
    this.onChange = onChange;

    this.input = root.querySelector('[data-chrono-input]');
    this.track = root.querySelector('[data-chrono-track]');
    this.thumb = root.querySelector('[data-chrono-thumb]');
    this.readout = root.querySelector('[data-chrono-readout]');
    this.ticksHost = root.querySelector('[data-chrono-ticks]');
    this.bandHost = root.querySelector('[data-chrono-bands]');
    this.markerHost = root.querySelector('[data-chrono-markers]');

    this.buildTicks();
    this.wire();
  }

  buildTicks() {
    if (!this.ticksHost) return;
    this.ticksHost.innerHTML = '';

    for (let h = 0; h <= 24; h++) {
      const tick = document.createElement('span');
      tick.className = 'lumen-chrono__tick';
      if (h % 6 === 0) tick.classList.add('is-major');
      tick.style.left = (h / 24 * 100) + '%';

      if (h % 6 === 0 && h < 24) {
        const label = document.createElement('span');
        label.className = 'lumen-chrono__tick-label';
        label.textContent = String(h).padStart(2, '0');
        tick.appendChild(label);
      }

      this.ticksHost.appendChild(tick);
    }
  }

  wire() {
    if (!this.input) return;

    this.input.addEventListener('input', () => {
      this.onChange(Number(this.input.value));
    });

    /* Clicking anywhere on the painted track should move the thumb there.
       The native input already does this, but only within its own hit area;
       widening it to the whole band strip makes the control feel like a
       physical slot rather than a thin line. */
    const seek = e => {
      const rect = this.track.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      this.onChange(Math.round(ratio * 1439));
    };

    let dragging = false;

    this.track.addEventListener('pointerdown', e => {
      dragging = true;
      this.track.setPointerCapture(e.pointerId);
      seek(e);
    });

    this.track.addEventListener('pointermove', e => {
      if (dragging) seek(e);
    });

    this.track.addEventListener('pointerup', e => {
      dragging = false;
      try { this.track.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    this.track.addEventListener('pointercancel', () => { dragging = false; });
  }

  /** Move the thumb and the readout. Called on every tick, so keep it cheap. */
  renderTick(s) {
    const ratio = s.minutes / 1439;

    if (this.input && Number(this.input.value) !== s.minutes) {
      this.input.value = String(s.minutes);
    }

    if (this.thumb) {
      this.thumb.style.left = (ratio * 100) + '%';
    }

    if (this.readout) {
      this.readout.textContent = formatMinutes(s.minutes);
    }

    if (this.input) {
      this.input.setAttribute('aria-valuetext', formatMinutes(s.minutes));
    }
  }

  /**
   * Repaint the twilight bands and the event markers for a new day or a new
   * location. Not called while scrubbing.
   */
  renderDay(s) {
    if (!s.sunTimes) return;
    this.paintBands(s);
    this.paintMarkers(s);
  }

  paintBands(s) {
    if (!this.bandHost) return;
    this.bandHost.innerHTML = '';

    for (const band of BANDS) {
      const from = minutesOfDay(s.zone, s.sunTimes[band.from]);
      const to = minutesOfDay(s.zone, s.sunTimes[band.to]);

      /* A missing event means the phase never begins or never ends on this
         date. Polar summer, polar winter, or simply a high latitude in June.
         Skipping the band is correct: the band beneath it already covers the
         whole span, which is exactly what "it never got dark" looks like. */
      if (from === null || to === null) continue;
      if (to <= from) continue;

      const el = document.createElement('span');
      el.className = `lumen-chrono__band is-${band.cls}`;
      el.style.left = (from / 1440 * 100) + '%';
      el.style.width = ((to - from) / 1440 * 100) + '%';
      this.bandHost.appendChild(el);
    }
  }

  paintMarkers(s) {
    if (!this.markerHost) return;
    this.markerHost.innerHTML = '';

    const marks = [
      { key: 'sunrise',       cls: 'sun',    label: 'SUNRISE' },
      { key: 'solarNoon',     cls: 'noon',   label: 'SOLAR NOON' },
      { key: 'goldenHour',    cls: 'golden', label: 'GOLDEN HOUR' },
      { key: 'sunset',        cls: 'sun',    label: 'SUNSET' },
      { key: 'goldenHourEnd', cls: 'golden', label: 'GOLDEN HOUR END' }
    ];

    for (const m of marks) {
      const minutes = minutesOfDay(s.zone, s.sunTimes[m.key]);
      if (minutes === null) continue;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `lumen-chrono__marker is-${m.cls}`;
      btn.style.left = (minutes / 1440 * 100) + '%';
      btn.title = `${m.label} ${formatMinutes(minutes)}`;
      btn.setAttribute('aria-label', `Jump to ${m.label}, ${formatMinutes(minutes)}`);

      /* Snap-to-event. Precisely hitting sunrise by dragging a thumb across
         1440 positions on a phone is not realistic, so every marker is also
         a target. */
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onChange(minutes);
      });

      this.markerHost.appendChild(btn);
    }
  }
}
