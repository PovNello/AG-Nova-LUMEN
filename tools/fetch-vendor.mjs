#!/usr/bin/env node
/* ==========================================================================
   L.U.M.E.N. — VENDOR FETCH
   Run:  node tools/fetch-vendor.mjs

   Downloads every third-party file the instrument needs, at an exact pinned
   version, into assets/vendor/.

   ---------------------------------------------------------------------------
   WHY A SCRIPT AND NOT A PACKAGE MANAGER
   ---------------------------------------------------------------------------
   This project has no build step and no node_modules. It is plain HTML, CSS
   and ES modules, served as-is. The only reason it needs a tool at all is
   that committing a megabyte of minified library to a repository is unkind
   to whoever clones it next.

   The files are still vendored: once fetched, they are local, pinned, and
   nothing at runtime reaches for a CDN. If a version is ever yanked from the
   registry, the copies already on disk keep working. That is the whole point.

   ---------------------------------------------------------------------------
   ON PINNING
   ---------------------------------------------------------------------------
   Every entry names an exact version, never a range and never "latest". A
   library that silently changes underneath a tool which draws shadows from
   its output is not a dependency, it is a trap. Record what you pulled in
   docs/VENDOR.md and change it on purpose.
   ========================================================================== */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'assets', 'vendor');

/* --------------------------------------------------------------------------
   THE MANIFEST
   -------------------------------------------------------------------------- */

const MANIFEST = [
  {
    file: 'maplibre-gl.js',
    version: '4.7.1',
    url: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    licence: 'BSD-3-Clause',
    why: 'Map rendering, and the only practical way to read building ' +
         'footprints and heights out of vector tiles without a second ' +
         'network service.'
  },
  {
    file: 'maplibre-gl.css',
    version: '4.7.1',
    url: 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css',
    licence: 'BSD-3-Clause',
    why: 'Canvas positioning. Nearly all of its widget styling is overridden ' +
         'in 11-lumen-map.css.'
  },
  {
    file: 'tz-lookup.js',
    version: '6.1.25',
    url: 'https://cdn.jsdelivr.net/npm/tz-lookup@6.1.25/tz.js',
    licence: 'CC0-1.0',
    optional: true,
    why: 'Coordinate to IANA timezone. There is no browser API for this, and ' +
         'without it every time shown for a foreign pin is silently the ' +
         'device\'s own. Optional only in the sense that the tool degrades ' +
         'loudly rather than breaking.'
  }
];

/* --------------------------------------------------------------------------
   FETCH
   -------------------------------------------------------------------------- */

async function main() {
  await mkdir(VENDOR, { recursive: true });

  console.log('L.U.M.E.N. vendor fetch');
  console.log('-'.repeat(72));

  const results = [];
  let failures = 0;

  for (const entry of MANIFEST) {
    const dest = join(VENDOR, entry.file);
    const force = process.argv.includes('--force');

    if (!force && await exists(dest)) {
      const hash = await hashFile(dest);
      console.log(`  SKIP   ${entry.file.padEnd(22)} already present  ${hash.slice(0, 16)}`);
      results.push({ ...entry, hash, status: 'present' });
      continue;
    }

    try {
      process.stdout.write(`  FETCH  ${entry.file.padEnd(22)} ${entry.version} ... `);
      const bytes = await download(entry.url, dest);
      const hash = await hashFile(dest);
      console.log(`${(bytes / 1024).toFixed(0)} kB  ${hash.slice(0, 16)}`);
      results.push({ ...entry, hash, bytes, status: 'fetched' });
    } catch (err) {
      console.log('FAILED');
      console.log(`         ${err.message}`);
      if (!entry.optional) failures++;
      results.push({ ...entry, status: 'failed', error: err.message });
    }
  }

  console.log('-'.repeat(72));

  await writeLockfile(results);

  if (failures > 0) {
    console.log(`\n${failures} required file(s) could not be fetched.`);
    console.log('The instrument will not start without them. Check the network,');
    console.log('or download the URLs in tools/fetch-vendor.mjs by hand into');
    console.log('assets/vendor/ using the exact filenames listed above.');
    process.exit(1);
  }

  const missingOptional = results.filter(r => r.status === 'failed');
  if (missingOptional.length) {
    console.log('\nOptional file(s) missing. The instrument will run, but it will');
    console.log('display a degraded-timezone warning and use the device zone.');
  }

  console.log('\nVendor directory ready. Serve the project root over HTTP:');
  console.log('  python3 -m http.server 8080');
  console.log('  then open http://localhost:8080');
}

async function download(url, dest, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects');

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const out = createWriteStream(dest);
  await pipeline(res.body, out);

  const info = await stat(dest);
  if (info.size < 1024) {
    throw new Error(`suspiciously small file (${info.size} bytes) — check the URL`);
  }
  return info.size;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * A lockfile is written on every run.
 *
 * Not for a package manager to read — there isn't one. It is a record for a
 * human: exactly which bytes are sitting in assets/vendor/, so that a future
 * "it worked last month" can be checked against something factual.
 */
async function writeLockfile(results) {
  const lines = [
    '# L.U.M.E.N. vendor lock',
    '#',
    '# Written by tools/fetch-vendor.mjs. Commit this file.',
    '# If a checksum here stops matching the file on disk, something changed',
    '# that you did not change.',
    '#',
    `# Generated ${new Date().toISOString()}`,
    ''
  ];

  for (const r of results) {
    lines.push(`${r.file}`);
    lines.push(`  version  ${r.version}`);
    lines.push(`  licence  ${r.licence}`);
    lines.push(`  url      ${r.url}`);
    lines.push(`  sha256   ${r.hash || '(not present)'}`);
    lines.push(`  status   ${r.status}`);
    lines.push('');
  }

  await writeFile(join(ROOT, 'docs', 'VENDOR.lock'), lines.join('\n'), 'utf8');
}

main().catch(err => {
  console.error('\nUnexpected failure:', err);
  process.exit(1);
});
