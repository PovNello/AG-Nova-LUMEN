/* ==========================================================================
   L.U.M.E.N. — CONFIG / SERVICES
   Every external URL in the entire application lives in this file.

   ---------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   ---------------------------------------------------------------------------
   The tool depends on three things it does not own: vector tiles, map fonts,
   and a geocoder. All three are free and keyless, and all three could
   disappear. OpenFreeMap in particular is a small donation-funded project
   with no service level agreement.

   That risk is acceptable, but only because it is contained. The tile schema
   is OpenMapTiles, a public standard also served by MapTiler, Stadia and any
   self-hosted Protomaps or TileServer GL instance. Migrating providers is a
   change to the constants below and nothing else. See the recovery notes in
   README.md before assuming the tool is broken.

   Nothing else in the codebase may hard-code a URL.
   ========================================================================== */

export const SERVICES = {

  /* ------------------------------------------------------------------------
     VECTOR TILES
     Source of both the basemap and, more importantly, the building footprints
     and heights the shadow engine reads. No registration, no API key.
     ------------------------------------------------------------------------ */
  tiles: {
    url: 'https://tiles.openfreemap.org/planet',
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
      '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  },

  /* Glyph endpoint for map labels. Must come from the same project as the
     style, since fontstack names are provider specific. */
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',

  /* ------------------------------------------------------------------------
     GEOCODER
     The most fragile dependency here. Nominatim is community infrastructure
     with a strict usage policy: one request per second, no autocomplete, and
     a meaningful identifier on every call. Browsers cannot set User-Agent, so
     the Referer carries the identification instead.

     If it fails, the tool loses nothing but convenience. Clicking the map and
     using the device position both still work, and the failure is surfaced in
     the interface rather than swallowed.
     ------------------------------------------------------------------------ */
  geocoder: {
    url: 'https://nominatim.openstreetmap.org/search',
    minIntervalMs: 1100,
    limit: 5,
    enabled: true
  }
};

/* --------------------------------------------------------------------------
   DEFAULT VIEW
   Where the terminal opens when there is no shared link and the operator has
   not granted location access.
   -------------------------------------------------------------------------- */
export const DEFAULT_VIEW = {
  lng: 11.3426,
  lat: 44.4949,
  zoom: 16.2,
  label: 'BOLOGNA_SECTOR_IT'
};

/* Local path to the map style. Relative so the tool runs identically from a
   subdomain root or from a subdirectory. */
export const STYLE_PATH = 'assets/style/lumen-dark.json';

/* Style layer ids that carry building polygons. The shadow engine queries
   exactly these. Kept here because it is a contract between the style file
   and the extraction code, and a rename in one without the other is a silent
   failure that shows up as "no shadows, no error". */
export const BUILDING_LAYERS = ['building-fill'];
