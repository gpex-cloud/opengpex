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
 *   (the vips engine is NOT installed here any more: the self-built 2 GB
 *    build is committed under public/hb/wasm/vips-2g/ — see plan §12.10)
 *   public/ext/wasm/libraw/  ← libraw.wasm + libraw.js + libraw-worker.js
 *   public/ext/wasm/gs/      ← gs.wasm + gs.js + gs-worker.js
 *   public/ext/wasm/avif/    ← avif_enc.wasm + avif_enc.js + avif-worker.js (@jsquash/avif ST)
 *   (avif encoding via vips-heif.wasm in vips/ directory)
 *   public/ext/wasm/libheif/ ← libheif.js + libheif.wasm + heic-worker.js (libheif-js, LGPL-3.0)
 *   public/ext/js/           ← gifuct-js.js + gifenc.js + polygon-clipping.js
 *
 * This runs automatically after `pnpm install`.
 */

import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ─── Ensure subdirectories exist ────────────────────────────────────────────────
const WASM_BASE = resolve(ROOT, 'public/ext/wasm');
const SUBDIRS = ['resvg', 'libraw', 'gs', 'avif', 'avif/dec', 'libheif'];
for (const sub of SUBDIRS) {
  mkdirSync(resolve(WASM_BASE, sub), { recursive: true });
}

// ─── WASM/JS Files from node_modules ────────────────────────────────────────────
const vendorFiles = [
  // ── resvg ──
  { src: 'node_modules/@resvg/resvg-wasm/index_bg.wasm', dest: 'resvg/resvg.wasm' },
  { src: 'node_modules/@resvg/resvg-wasm/index.mjs',     dest: 'resvg/index.js' },


  // ── libraw ──
  { src: 'node_modules/libraw-wasm/dist/libraw.wasm', dest: 'libraw/libraw.wasm' },
  { src: 'node_modules/libraw-wasm/dist/libraw.js',   dest: 'libraw/libraw.js' },
  { src: 'node_modules/libraw-wasm/dist/worker.js',   dest: 'libraw/libraw-worker.js' },
  // The worker ends with //# sourceMappingURL=worker.js.map; without this file
  // DevTools requests it on every RAW load and gets a 404 in the server log.
  { src: 'node_modules/libraw-wasm/dist/worker.js.map', dest: 'libraw/worker.js.map' },

  // ── gs (ghostpdl) ──
  { src: 'node_modules/@okathira/ghostpdl-wasm/dist/gs.wasm', dest: 'gs/gs.wasm' },
  { src: 'node_modules/@okathira/ghostpdl-wasm/dist/gs.js',   dest: 'gs/gs.js' },

  // ── avif (@jsquash/avif — ST encoder + libavif decoder. EXACT version pin
  //    in package.json: the decode fidelity/depth probes were validated against
  //    this build (gpex-cloud/probes/avif), bumping requires re-running them) ──
  { src: 'node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', dest: 'avif/avif_enc.wasm' },
  { src: 'node_modules/@jsquash/avif/codec/enc/avif_enc.js',   dest: 'avif/avif_enc.js' },
  { src: 'node_modules/@jsquash/avif/codec/dec/avif_dec.wasm', dest: 'avif/dec/avif_dec.wasm' },
  { src: 'node_modules/@jsquash/avif/codec/dec/avif_dec.js',   dest: 'avif/dec/avif_dec.js' },

  // ── libheif (libheif-js prebuilt wasm — HEIC proxy decode; EXACT version pin
  //    in package.json: the six-sample probe was validated against this build,
  //    bumping requires re-running gpex-cloud/probes/heic) ──
  { src: 'node_modules/libheif-js/libheif-wasm/libheif.js',   dest: 'libheif/libheif.js' },
  { src: 'node_modules/libheif-js/libheif-wasm/libheif.wasm', dest: 'libheif/libheif.wasm' },
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
  { src: 'avif-worker.js',  dest: 'avif/avif-worker.js' },
  // The served vips worker is the self-built 2G build (plan §12.10); src is
  // the single source of truth — this copy must never be edited by hand.
  { src: 'vips-worker.js', dest: '../../hb/wasm/vips-2g/vips-worker.js' },
  { src: 'heic-worker.js',  dest: 'libheif/heic-worker.js' },
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

// ─── public/ext/js (esbuild-bundled browser globals below) ────────────────────
const JS_DEST = resolve(ROOT, 'public/ext/js');
mkdirSync(JS_DEST, { recursive: true });

// ─── GIF libraries: gifuct-js + gifenc (MIT) ──────────────────────────────────
// gifuct-js has require() calls to sub-modules → must be bundled via esbuild.
// gifenc dist is self-contained CJS → also bundle for consistency.
// Output: public/ext/js/gifuct-js.js  (window.gifuctJs = { parseGIF, decompressFrames })
//         public/ext/js/gifenc.js     (window.gifenc = { GIFEncoder, quantize, applyPalette, ... })

import { execSync } from 'node:child_process';

const gifuctEntry = resolve(ROOT, 'node_modules/gifuct-js/lib/index.js');
const gifuctOut = resolve(JS_DEST, 'gifuct-js.js');

if (existsSync(gifuctEntry)) {
  try {
    execSync(
      `npx esbuild "${gifuctEntry}" --bundle --format=iife --global-name=gifuctJs --outfile="${gifuctOut}" --minify --target=es2020`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    console.log(`  ✓ gifuct-js.js (esbuild bundle → IIFE window.gifuctJs)`);
  } catch (e) {
    console.warn(`  ⚠ esbuild failed for gifuct-js: ${e.message}`);
  }
} else {
  console.warn(`  ⚠ node_modules/gifuct-js/lib/index.js not found — GIF decode unavailable`);
}

const gifencEntry = resolve(ROOT, 'node_modules/gifenc/dist/gifenc.esm.js');
const gifencOut = resolve(JS_DEST, 'gifenc.js');

if (existsSync(gifencEntry)) {
  try {
    execSync(
      `npx esbuild "${gifencEntry}" --bundle --format=iife --global-name=gifenc --outfile="${gifencOut}" --minify --target=es2020`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    console.log(`  ✓ gifenc.js (esbuild bundle → IIFE window.gifenc)`);
  } catch (e) {
    console.warn(`  ⚠ esbuild failed for gifenc: ${e.message}`);
  }
} else {
  console.warn(`  ⚠ node_modules/gifenc/dist/gifenc.esm.js not found — GIF encode unavailable`);
}

// ─── polygon-clipping (MIT) ────────────────────────────────────────────────────
const pcEntry = resolve(ROOT, 'node_modules/polygon-clipping/dist/polygon-clipping.esm.js');
const pcOut = resolve(JS_DEST, 'polygon-clipping.js');

if (existsSync(pcEntry)) {
  try {
    execSync(
      `npx esbuild "${pcEntry}" --bundle --format=iife --global-name=polygonClipping --outfile="${pcOut}" --minify --target=es2020`,
      { cwd: ROOT, stdio: 'pipe' },
    );
    console.log(`  ✓ polygon-clipping.js (esbuild bundle → IIFE self.polygonClipping)`);
  } catch (e) {
    console.warn(`  ⚠ esbuild failed for polygon-clipping: ${e.message}`);
  }
} else {
  console.warn(`  ⚠ node_modules/polygon-clipping/dist/polygon-clipping.esm.js not found — polygon boolean ops unavailable`);
}

