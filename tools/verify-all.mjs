#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => f.startsWith('verify-') && f !== 'verify-all.mjs' && f.endsWith('.mjs'));

let hasError = false;

for (const file of files) {
  const result = spawnSync('node', [join(dir, file)], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) {
    hasError = true;
    console.log(`[ERROR] from ${file}:`);
    if (result.stdout) console.log(result.stdout.trim());
    if (result.stderr) console.log(result.stderr.trim());
    console.log('---');
  }
}

if (!hasError) {
  console.log('[PASS] All verifications passed.');
} else {
  process.exit(1);
}
