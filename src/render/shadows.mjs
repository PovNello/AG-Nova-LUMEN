/* ==========================================================================
   L.U.M.E.N. — RENDER / SHADOWS
   The projection engine. A canvas laid over the map.

   ---------------------------------------------------------------------------
   METHOD
   ---------------------------------------------------------------------------
   Geometric footprint projection, not per-pixel ray casting.

   For each building, every footprint vertex is duplicated and pushed away
   from the sun by a distance of height / tan(altitude). The convex hull of
   the original and the pushed copy is the silhouette that building throws on
   flat ground. Fill it.

   This is elementary trigonometry, it runs on any phone, and on level urban
   ground it is accurate. The competition uses GPU ray casting because they
   also model terrain and tree canopy; we model neither, so the expensive
   machinery would buy nothing.

   ---------------------------------------------------------------------------
   THE COMPOSITING TRICK
   ---------------------------------------------------------------------------
   Drawing translucent shadows one by one makes overlaps stack into ever
   darker blobs, which is physically wrong — a point is either lit or it is
   not — and reads as a rendering bug.

   The fix is a second canvas. Every silhouette is filled at FULL opacity on
   an offscreen surface, so overlaps merge into a single flat region, and the
   whole surface is then composited onto the map once at a single alpha.

   This is why no polygon-union library appears in the dependency list. The
   union is performed by the rasteriser, for free.
   ========================================================================== */

import {
  viewTransform, project, metresPerPixel,
  convexHull, bearingToScreen
} from '../core/geometry.mjs';

/* Below this sun altitude the shadow length exceeds any sensible map extent
   and the flat-ground assumption collapses. Shadows are clamped and the
   readout is flagged rather than drawn as if they were meaningful. */
export const GRAZING_ALTITUDE_DEG = 1.5;

/* Maximum drawn shadow length, expressed as a multiple of the viewport
   diagonal rather than as a fixed distance in metres.

   A fixed metre figure is wrong at both ends of the zoom range: at zoom 18 it
   is far beyond anything visible and wastes fill, and at zoom 15 it can be
   shorter than the screen and clip a shadow that genuinely reaches across it.
   Scaling with the view keeps the clamp meaningful everywhere. */
const MAX_SHADOW_DIAGONALS = 1.5;

/* Single alpha applied to the whole merged shadow layer. */
const SHADOW_ALPHA = 0.62;

export class ShadowLayer {
  /**
   * @param {HTMLElement} container  the map container; the canvas is appended
   *                                 over it and never receives pointer events
   * @param {Function} [onResize]    called after the surface has been resized,
   *                                 so the application can request a redraw
   */
  constructor(container, onResize) {
    this.container = container;
    this.onResize = onResize;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lumen-shadow-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');

    /* Offscreen surface where silhouettes are merged at full opacity. */
    this.buffer = document.createElement('canvas');
    this.bufferCtx = this.buffer.getContext('2d');

    this.dpr = 0;
    this.width = 0;
    this.height = 0;

    /* Palette is read from the stylesheet rather than hard-coded, so the
       shadow obeys the same tokens as the rest of the terminal. */
    this.colours = readColours();

    this.syncSize();
    this.observe();
  }

  /* ------------------------------------------------------------------------
     SIZING

     The single source of truth is the CONTAINER, measured directly, and it is
     re-measured by a ResizeObserver rather than being told about changes.

     This is not defensive coding for its own sake. An earlier version sized
     this surface from the map's canvas, at a moment when that canvas had not
     yet grown to fill its container, and then never re-synchronised. Two
     symptoms followed from that one mistake, and neither looked like a sizing
     bug:

       1. The surface was physically shorter than the map, so shadows were
          clipped along a clean horizontal line with nothing drawn below it.

       2. viewTransform centres the projection on height / 2. With a stale
          height that centre was too high, so every shadow was displaced
          upward by half the discrepancy — a plausible-looking offset with no
          error anywhere.

     Measuring the container and observing it makes both impossible by
     construction. Nothing outside this class needs to know the size, and
     nothing needs to remember to tell it.
     ------------------------------------------------------------------------ */

  observe() {
    if (typeof ResizeObserver === 'undefined') {
      /* Old browsers fall back to window resize. Less precise — it misses
         container changes that are not viewport changes — but never stale
         for long, because render() re-checks. */
      window.addEventListener('resize', () => this.syncSize());
      return;
    }

    this.ro = new ResizeObserver(() => {
      if (this.syncSize() && this.onResize) this.onResize();
    });
    this.ro.observe(this.container);
  }

  /**
   * Match the backing store to the container. Returns true if anything moved.
   *
   * Only the backing store is set here. The displayed size comes from CSS
   * (position: absolute; inset: 0), so the element can never disagree with
   * its container even for a frame.
   */
  syncSize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (!width || !height) return false;
    if (this.width === width && this.height === height && this.dpr === dpr) {
      return false;
    }

    this.width = width;
    this.height = height;
    this.dpr = dpr;

    for (const c of [this.canvas, this.buffer]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }

    /* Resizing a canvas resets its transform, so both contexts are rescaled
       to CSS pixels every time. All drawing code works in CSS pixels and is
       unaware of device pixel ratio. */
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bufferCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return true;
  }

  destroy() {
    if (this.ro) this.ro.disconnect();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  /**
   * Draw the shadow layer for one instant.
   *
   * @param {Object} opts
   * @param {Array}  opts.buildings   prepared footprints from core/buildings
   * @param {Object} opts.center      map centre {lng, lat}
   * @param {number} opts.zoom
   * @param {number} opts.sunAzimuth  compass bearing, degrees
   * @param {number} opts.sunAltitude apparent altitude, degrees
   * @param {boolean} opts.showFootprints
   * @returns {{drawn:number, grazing:boolean, night:boolean}}
   */
  render(opts) {
    const {
      buildings, center, zoom,
      sunAzimuth, sunAltitude,
      showFootprints = true
    } = opts;

    /* Cheap guard against drawing into a surface that no longer matches the
       map. The ResizeObserver normally gets here first; this catches the
       frame in between. */
    this.syncSize();

    this.clear();

    /* Sun below the horizon: there are no shadows, there is only night.
       Drawing an "infinite" shadow here would be the classic division-by-zero
       artefact and is explicitly guarded. */
    if (sunAltitude <= 0) {
      return { drawn: 0, grazing: false, night: true };
    }

    if (!buildings.length) {
      return { drawn: 0, grazing: false, night: false };
    }

    const t = viewTransform(center, zoom, this.width, this.height);
    const dir = bearingToScreen((sunAzimuth + 180) % 360);

    const grazing = sunAltitude < GRAZING_ALTITUDE_DEG;
    const effectiveAlt = Math.max(sunAltitude, GRAZING_ALTITUDE_DEG);
    const tanAlt = Math.tan(effectiveAlt * Math.PI / 180);

    const bctx = this.bufferCtx;
    bctx.clearRect(0, 0, this.width, this.height);
    bctx.fillStyle = this.colours.shadow;

    /* Generous margin: a building well off screen can still cast a shadow
       across the visible area. */
    const margin = 600;
    let drawn = 0;

    const maxLengthPx =
      Math.hypot(this.width, this.height) * MAX_SHADOW_DIAGONALS;

    for (const b of buildings) {
      /* Metres per pixel at THIS building's latitude, not the map centre's.
         Across a full-screen view at high latitude the difference is several
         per cent, which is visible as shadows that grow towards one edge. */
      const mpp = metresPerPixel(b.centroidLat, zoom);

      let lengthPx = (b.height / tanAlt) / mpp;
      if (lengthPx > maxLengthPx) lengthPx = maxLengthPx;

      const dx = dir.x * lengthPx;
      const dy = dir.y * lengthPx;

      const merc = b.merc;
      const n = merc.length / 2;
      const pts = new Array(n * 2);

      let visible = false;

      for (let i = 0; i < n; i++) {
        const p = project(merc[i * 2], merc[i * 2 + 1], t);
        pts[i] = p;
        pts[i + n] = { x: p.x + dx, y: p.y + dy };

        if (!visible &&
            p.x > -margin && p.x < this.width + margin &&
            p.y > -margin && p.y < this.height + margin) {
          visible = true;
        }
      }

      if (!visible) continue;

      const hull = convexHull(pts);
      if (hull.length < 3) continue;

      bctx.beginPath();
      bctx.moveTo(hull[0].x, hull[0].y);
      for (let i = 1; i < hull.length; i++) bctx.lineTo(hull[i].x, hull[i].y);
      bctx.closePath();
      bctx.fill();

      drawn++;
    }

    /* One composite, one alpha. Overlaps are already merged. */
    this.ctx.save();
    this.ctx.globalAlpha = SHADOW_ALPHA;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.buffer, 0, 0);
    this.ctx.restore();

    if (showFootprints) this.drawFootprints(buildings, t);

    return { drawn, grazing, night: false };
  }

  /**
   * Outline the footprints themselves. Buildings whose height was inferred
   * rather than surveyed get a warning-coloured edge, so the operator can see
   * at a glance which shadows rest on a guess.
   */
  drawFootprints(buildings, t) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 1;

    for (const pass of ['MEASURED', 'ESTIMATED']) {
      ctx.strokeStyle = pass === 'ESTIMATED'
        ? this.colours.estimated
        : this.colours.footprint;
      ctx.beginPath();

      for (const b of buildings) {
        if (b.confidence !== pass) continue;

        const merc = b.merc;
        const n = merc.length / 2;
        const first = project(merc[0], merc[1], t);
        if (first.x < -100 || first.x > this.width + 100 ||
            first.y < -100 || first.y > this.height + 100) continue;

        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < n; i++) {
          const p = project(merc[i * 2], merc[i * 2 + 1], t);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }

      ctx.stroke();
    }

    ctx.restore();
  }
}

/* --------------------------------------------------------------------------
   PALETTE
   The canvas cannot use CSS variables directly, so they are read once from
   the computed style of the document root. This keeps 01-tokens.css as the
   single source of truth even for pixels drawn by hand.
   -------------------------------------------------------------------------- */

function readColours() {
  const s = getComputedStyle(document.documentElement);
  const get = (name, fallback) => (s.getPropertyValue(name).trim() || fallback);

  return {
    /* Shadow is the absence of light, so it is drawn in the structural void
       colour rather than in an accent. It spends none of the accent budget. */
    shadow: get('--nova-space', '#08111B'),
    footprint: get('--nova-grid', '#22374D'),
    estimated: get('--nova-orange-line', 'rgba(230,130,47,0.40)')
  };
}
