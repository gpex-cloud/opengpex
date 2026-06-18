#!/usr/bin/env node
/**
 * postinstall-exts.mjs
 *
 * Copies required WASM binaries and static vendor assets from node_modules
 * into public/ext/ so they can be served at runtime.
 *
 * This runs automatically after `pnpm install`.
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── WASM Files ────────────────────────────────────────────────────────────────
const WASM_DEST = resolve(ROOT, 'public/ext/wasm');
mkdirSync(WASM_DEST, { recursive: true });

const wasmFiles = [
  {
    src: 'node_modules/@resvg/resvg-wasm/index_bg.wasm',
    dest: 'resvg.wasm',
  },
  {
    src: 'node_modules/@jsquash/avif/codec/enc/avif_enc.wasm',
    dest: 'avif_enc.wasm',
  },
];

let copied = 0;
for (const { src, dest } of wasmFiles) {
  const srcPath = resolve(ROOT, src);
  const destPath = resolve(WASM_DEST, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${dest} (from ${src})`);
    copied++;
  } else {
    console.warn(`  ⚠ ${src} not found — skipping`);
  }
}
console.log(`postinstall-exts: ${copied}/${wasmFiles.length} WASM files copied to public/ext/wasm/`);

// ─── heic-to (LGPL-3.0) ───────────────────────────────────────────────────────
// heic-to is loaded via <script> tag at runtime to bypass Next.js/Turbopack bundling.
// The npm package provides a self-contained IIFE bundle with libheif WASM2JS baked in.
const JS_DEST = resolve(ROOT, 'public/ext/js');
mkdirSync(JS_DEST, { recursive: true });

const heicSrc = resolve(ROOT, 'node_modules/heic-to/dist/heic-to.js');
const heicDestFile = resolve(JS_DEST, 'heic-to.js');

if (existsSync(heicSrc)) {
  copyFileSync(heicSrc, heicDestFile);
  console.log(`  ✓ heic-to.js (from node_modules/heic-to/dist/heic-to.js)`);
} else {
  console.warn(`  ⚠ node_modules/heic-to/dist/heic-to.js not found — skipping`);
  console.warn(`    (heic-to HEIC conversion will not be available)`);
}
