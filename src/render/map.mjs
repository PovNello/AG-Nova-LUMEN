/* ==========================================================================
   L.U.M.E.N. — RENDER / MAP
   MapLibre setup, the telemetry reticle, and the celestial vectors.

   ---------------------------------------------------------------------------
   THE MAP IS LOCKED NORTH-UP AND FLAT
   ---------------------------------------------------------------------------
   Rotation and pitch are permanently disabled. This is not a stylistic
   preference, it is a correctness requirement: the shadow engine projects
   footprints in screen space, which is only valid for an unrotated,
   unpitched, orthographic view. Re-enabling either gesture silently
   invalidates every shadow on screen.

   It also happens to suit the instrument: this is a plan-view chart, not a
   flythrough.
   ========================================================================== */

import { SERVICES, STYLE_PATH } from '../config/services.js';
import { toMercator, viewTransform, project, bearingToScreen } from '../core/geometry.mjs';

/* Length of the celestial vectors as a fraction of the smaller viewport
   dimension. Long enough to read as a direction, short enough not to imply a
   distance the tool is not claiming. */
const VECTOR_REACH = 0.42;

export class ChartView {
  constructor(container, { onPin, onIdle, onMove }) {
    this.container = container;
    this.onPin = onPin;
    this.onIdle = onIdle;
    this.onMove = onMove;

    this.map = new maplibregl.Map({
      container,
      style: STYLE_PATH,
      center: [0, 0],
      zoom: 2,

      /* The three locks that keep the shadow projection valid. */
      pitch: 0,
      bearing: 0,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false,

      attributionControl: false,
      /* Fractional zoom would make the tile/pixel maths harder to reason
         about for no visible benefit at these scales. */
      renderWorldCopies: true,
      maxZoom: 20,
      minZoom: 2
    });

    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();

    this.buildOverlay();
    this.wireEvents();
  }

  /* ------------------------------------------------------------------------
     OVERLAY
     A single SVG holding the reticle and the vectors. SVG rather than canvas
     because these are a handful of crisp elements that must stay legible on
     any display, and because a screen reader can be told what they are.
     ------------------------------------------------------------------------ */

  buildOverlay() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'lumen-vector-layer');
    svg.setAttribute('aria-hidden', 'true');

    const mk = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };

    /* Boundary vectors first, so the live readings draw on top of them. */
    this.vSunrise = mk('line', { class: 'lumen-vec lumen-vec--boundary' });
    this.vSunset  = mk('line', { class: 'lumen-vec lumen-vec--boundary' });
    this.vShadow  = mk('line', { class: 'lumen-vec lumen-vec--shadow' });
    this.vMoon    = mk('line', { class: 'lumen-vec lumen-vec--moon' });
    this.vSun     = mk('line', { class: 'lumen-vec lumen-vec--sun' });

    this.gReticle = mk('g', { class: 'lumen-reticle' });
    const r = 13;
    this.gReticle.append(
      mk('circle', { r, cx: 0, cy: 0, class: 'lumen-reticle__ring' }),
      mk('circle', { r: 2.2, cx: 0, cy: 0, class: 'lumen-reticle__core' }),
      mk('line', { x1: -r - 8, y1: 0, x2: -r + 3, y2: 0, class: 'lumen-reticle__tick' }),
      mk('line', { x1:  r - 3, y1: 0, x2:  r + 8, y2: 0, class: 'lumen-reticle__tick' }),
      mk('line', { x1: 0, y1: -r - 8, x2: 0, y2: -r + 3, class: 'lumen-reticle__tick' }),
      mk('line', { x1: 0, y1:  r - 3, x2: 0, y2:  r + 8, class: 'lumen-reticle__tick' })
    );

    svg.append(
      this.vSunrise, this.vSunset,
      this.vShadow, this.vMoon, this.vSun,
      this.gReticle
    );

    this.container.appendChild(svg);
    this.svg = svg;
  }

  wireEvents() {
    this.map.on('click', e => {
      this.onPin(e.lngLat.lng, e.lngLat.lat);
    });

    this.map.on('move', () => this.onMove());
    this.map.on('idle', () => this.onIdle());

    /* The cursor should say "you can place a pin here". */
    this.map.getCanvas().style.cursor = 'crosshair';
  }

  onceReady(fn) {
    if (this.map.loaded()) fn();
    else this.map.once('load', fn);
  }

  /* ------------------------------------------------------------------------
     VIEW
     ------------------------------------------------------------------------ */

  jumpTo(lng, lat, zoom) {
    this.map.jumpTo({ center: [lng, lat], zoom });
  }

  flyTo(lng, lat, zoom) {
    this.map.flyTo({
      center: [lng, lat],
      zoom: zoom !== undefined ? zoom : this.map.getZoom(),
      /* Short and mechanical, not a cinematic swoop. */
      duration: 700,
      curve: 1.2,
      essential: true
    });
  }

  getCenter() {
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat };
  }

  getZoom() {
    return this.map.getZoom();
  }

  /**
   * The size every overlay projects against.
   *
   * Measured from the CONTAINER, not from the map's own canvas. The canvas
   * lags its container during layout changes, and an overlay that projects
   * against a lagging size is displaced by half the discrepancy rather than
   * simply being wrong in an obvious way. The container is the one dimension
   * both the map and the overlays are guaranteed to agree on.
   */
  getSize() {
    return {
      width: this.container.clientWidth,
      height: this.container.clientHeight
    };
  }

  resize() {
    this.map.resize();
  }

  /* ------------------------------------------------------------------------
     VECTORS
     ------------------------------------------------------------------------ */

  /**
   * Redraw the reticle and every celestial vector.
   *
   * @param {Object} s  application state
   */
  drawVectors(s) {
    const size = this.getSize();
    if (!size.width || !size.height) return;

    const t = viewTransform(this.getCenter(), this.getZoom(), size.width, size.height);
    const m = toMercator(s.lng, s.lat);
    const p = project(m.x, m.y, t);

    this.gReticle.setAttribute('transform', `translate(${p.x} ${p.y})`);

    /* Hide the reticle when the pin has been panned off screen, rather than
       letting the browser draw it against the viewport edge where it reads as
       a live position. */
    const onScreen = p.x > -40 && p.x < size.width + 40 &&
                     p.y > -40 && p.y < size.height + 40;
    this.gReticle.style.display = onScreen ? '' : 'none';

    const reach = Math.min(size.width, size.height) * VECTOR_REACH;

    /* Sun. Drawn dimmed when below the horizon: the reading still exists and
       is still useful for planning, but it is not an operational light
       source and must not look like one. */
    if (s.sun) {
      this.setVector(this.vSun, p, s.sun.azimuth, reach);
      this.vSun.classList.toggle('is-below', s.sun.altitude <= 0);

      /* Shadow direction. Only meaningful while the sun is up. */
      const up = s.sun.altitude > 0;
      this.vShadow.style.display = up ? '' : 'none';
      if (up) this.setVector(this.vShadow, p, (s.sun.azimuth + 180) % 360, reach * 0.55);
    }

    /* Moon. Ivory rather than cyan, because it is a second, colder light and
       must never be confused with the live solar reading at a glance. */
    if (s.moon) {
      this.setVector(this.vMoon, p, s.moon.azimuth, reach * 0.8);
      this.vMoon.classList.toggle('is-below', s.moon.altitude <= 0);
    }

    /* Sunrise and sunset bearings: the operational limits of the day. */
    if (s.sunTimes) {
      this.setBoundary(this.vSunrise, p, s.sunriseAzimuth, reach * 0.9);
      this.setBoundary(this.vSunset, p, s.sunsetAzimuth, reach * 0.9);
    }
  }

  setVector(el, origin, bearing, length) {
    const d = bearingToScreen(bearing);
    el.setAttribute('x1', origin.x);
    el.setAttribute('y1', origin.y);
    el.setAttribute('x2', origin.x + d.x * length);
    el.setAttribute('y2', origin.y + d.y * length);
    el.style.display = '';
  }

  setBoundary(el, origin, bearing, length) {
    if (bearing === null || bearing === undefined || !isFinite(bearing)) {
      el.style.display = 'none';
      return;
    }
    this.setVector(el, origin, bearing, length);
  }
}
