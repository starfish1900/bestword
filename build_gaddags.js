#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// GADDAG Builder — Run locally to pre-build .gaddag binary files
// Usage: node build_gaddags.js
// Produces: english.gaddag, french.gaddag, spanish.gaddag
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { GADDAG } = require('./gaddag');

const configs = [
  { name: 'english', file: 'dictionary.txt', out: 'english.gaddag' },
  { name: 'french', file: 'dictionary_fr.txt', out: 'french.gaddag' },
  { name: 'spanish', file: 'dictionary_es.txt', out: 'spanish.gaddag' }
];

for (const cfg of configs) {
  const dictPath = path.join(__dirname, cfg.file);
  if (!fs.existsSync(dictPath)) {
    console.error(`Dictionary not found: ${dictPath}`);
    continue;
  }

  console.log(`\n=== Building ${cfg.name} GADDAG ===`);
  const words = fs.readFileSync(dictPath, 'utf-8')
    .split(/\r?\n/).map(w => w.trim().toUpperCase()).filter(w => w.length > 0);
  console.log(`${words.length} words loaded`);

  const gaddag = GADDAG.build(words);

  // Save packed array as binary file
  // Format: [4 bytes: rootIndex as uint32] [rest: packed Uint32Array]
  const header = Buffer.alloc(4);
  header.writeUInt32LE(gaddag.rootIndex, 0);
  const body = Buffer.from(gaddag.data.buffer, gaddag.data.byteOffset, gaddag.data.byteLength);
  const outPath = path.join(__dirname, cfg.out);
  fs.writeFileSync(outPath, Buffer.concat([header, body]));

  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  console.log(`Saved: ${outPath} (${sizeMB} MB)`);

  // Help GC
  gaddag.data = null;
}

console.log('\nDone! Commit the .gaddag files to your repo.');
