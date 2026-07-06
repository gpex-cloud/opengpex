#!/usr/bin/env node
/**
 * postinstall-exts.mjs
 *
 * Copies required WASM binaries and static vendor assets from node_modules
 * into public/ext/ so they can be served at runtime.
 *
 * Also copies self-written Worker scripts from src/lib/opengpex/core/files/workers/
 * into their respective subdirectories.
 *
 * Directory layout:
 *   public/ext/wasm/resvg/   ← resvg.wasm + index.js + resvg-worker.js
 *   public/ext/wasm/vips/    ← vips.js + vips.wasm + vips-worker.js
 *   public/ext/wasm/libraw/  ← libraw.wasm + libraw.js + libraw-worker.js
 *   public/ext/wasm/gs/      ← gs.wasm + gs.js + gs-worker.js
 *   public/ext/wasm/avif/    ← avif_enc.wasm
 *   public/ext/js/           ← heic-to.js
 *
 * This runs automatically after `pnpm install`.
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Ensure subdirectories exist ────────────────────────────────────────────────
const WASM_BASE = resolve(ROOT, 'public/ext/wasm');
const SUBDIRS = ['resvg', 'vips', 'libraw', 'gs', 'avif'];
for (const sub of SUBDIRS) {
  mkdirSync(resolve(WASM_BASE, sub), { recursive: true });
}

// ─── WASM/JS Files from node_modules ────────────────────────────────────────────
const vendorFiles = [
  // ── resvg ──
  { src: 'node_modules/@resvg/resvg-wasm/index_bg.wasm', dest: 'resvg/resvg.wasm' },
  { src: 'node_modules/@resvg/resvg-wasm/index.mjs',     dest: 'resvg/index.js' },

  // ── vips ──
  { src: 'node_modules/wasm-vips/lib/vips.js',   dest: 'vips/vips.js' },
  { src: 'node_modules/wasm-vips/lib/vips.wasm', dest: 'vips/vips.wasm' },

  // ── libraw ──
  { src: 'node_modules/libraw-wasm/dist/libraw.wasm', dest: 'libraw/libraw.wasm' },
  { src: 'node_modules/libraw-wasm/dist/libraw.js',   dest: 'libraw/libraw.js' },
  { src: 'node_modules/libraw-wasm/dist/worker.js',   dest: 'libraw/libraw-worker.js' },

  // ── gs (ghostpdl) ──
  { src: 'node_modules/@okathira/ghostpdl-wasm/dist/gs.wasm', dest: 'gs/gs.wasm' },
  { src: 'node_modules/@okathira/ghostpdl-wasm/dist/gs.js',   dest: 'gs/gs.js' },

  // ── avif ──
  { src: 'node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', dest: 'avif/avif_enc.wasm' },
];

let copied = 0;
for (const { src, dest } of vendorFiles) {
  const srcPath = resolve(ROOT, src);
  const destPath = resolve(WASM_BASE, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${dest} (from ${src})`);
    copied++;
  } else {
    console.warn(`  ⚠ ${src} not found — skipping`);
  }
}
console.log(`postinstall-exts: ${copied}/${vendorFiles.length} vendor files copied to public/ext/wasm/`);

// ─── Self-written Worker scripts (source of truth: core/files/workers/) ─────────
const WORKERS_SRC = resolve(ROOT, 'src/lib/opengpex/core/files/workers');
const workerFiles = [
  { src: 'resvg-worker.js', dest: 'resvg/resvg-worker.js' },
  { src: 'gs-worker.js',    dest: 'gs/gs-worker.js' },
  { src: 'vips-worker.js',  dest: 'vips/vips-worker.js' },
];

let workersCopied = 0;
for (const { src, dest } of workerFiles) {
  const srcPath = resolve(WORKERS_SRC, src);
  const destPath = resolve(WASM_BASE, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`  ✓ ${dest} (worker from core/files/workers/${src})`);
    workersCopied++;
  } else {
    console.warn(`  ⚠ core/files/workers/${src} not found — skipping`);
  }
}
console.log(`postinstall-exts: ${workersCopied}/${workerFiles.length} worker scripts copied.`);

// ─── heic-to (LGPL-3.0) ───────────────────────────────────────────────────────
const JS_DEST = resolve(ROOT, 'public/ext/js');
mkdirSync(JS_DEST, { recursive: true });

const heicSrc = resolve(ROOT, 'node_modules/heic-to/dist/heic-to.js');
const heicDestFile = resolve(JS_DEST, 'heic-to.js');

if (existsSync(heicSrc)) {
  copyFileSync(heicSrc, heicDestFile);
  // Patch ESM export → window globals (loaded via <script> tag, not ES module)
  let heicContent = readFileSync(heicDestFile, 'utf8');
  heicContent = heicContent.replace(
    /export\{B as heicTo,v as isHeic\};?/,
    'window.heicTo=B;window.isHeic=v;'
  );
  writeFileSync(heicDestFile, heicContent);
  console.log(`  ✓ heic-to.js (from node_modules/heic-to/dist/heic-to.js, patched ESM→globals)`);
} else {
  console.warn(`  ⚠ node_modules/heic-to/dist/heic-to.js not found — skipping`);
}
