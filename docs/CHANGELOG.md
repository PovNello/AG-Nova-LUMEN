# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]
### Added
- Created `verify-all.mjs` script to run all verifications and output only failing files.
- Added SVG logo extraction to standalone file `logo.svg` and as favicon.

### Changed
- Increased `MAX_BUILDINGS` limit from 4000 to 12000 in `src/core/buildings.mjs` to prevent shadow truncation at wider zoom levels.
- Increased `MIN_SHADOW_ZOOM` from 15 to 15.8 to suspend shadow generation earlier when zooming out.
- Restored missing `data-field="modelState"` span in `index.html` within the Surface Model panel.
- Modified `console.mjs` to preserve the `nova-panel__state` class when setting the `modelState` value, fixing right-alignment.
