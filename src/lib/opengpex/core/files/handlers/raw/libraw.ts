/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * LibRaw Worker wrapper + RAW → PNG conversion.
 *
 * Thin wrapper around the pre-copied libraw-worker.js.
 * Communicates via postMessage and serializes calls in order.
 *
 * Color conversion is strategy-driven via RawColorConfig.
 */

import type { WorkingColorSpace } from '@opengpex/editor/core/types';
import type { RawImageData, LibRawSettings } from 'libraw-wasm';
import {
  getConversionMatrix,
  linearToSrgb,
  normalizedUint16ToFloat16,
} from '@opengpex/editor/core/engine/color';
import {
  filmicExposureGain,
  filmicToneMap,
} from '@opengpex/editor/core/engine/color/filmic';

// ═══════════════════════════════════════════════════════════════════════════════
// LibRaw Worker Class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin wrapper around libraw-worker.js Worker.
 * Serializes calls and handles Worker lifecycle.
 */
class LibRaw {
  private worker: Worker;
  private pending: Map<number, { resolve: (val: unknown) => void; reject: (err: Error) => void }>;
  private nextId: number = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed: boolean = false;

  constructor() {
    this.worker = new Worker('/ext/wasm/libraw/libraw-worker.js', { type: 'module' });
    this.pending = new Map();
    this.worker.onmessage = ({ data: e }) => {
      const t = this.pending.get(e?.id);
      if (t) {
        this.pending.delete(e.id);
        if (e?.error) {
          t.reject(new Error(e.error));
        } else {
          t.resolve(e?.out);
        }
      }
    };
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    for (const { reject } of this.pending.values()) {
      reject(new Error('LibRaw disposed'));
    }
    this.pending.clear();
  }

  private runFn(fn: string, ...args: unknown[]): Promise<unknown> {
    const n = () => new Promise<unknown>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('LibRaw disposed'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const transferables = args.map(r => {
        if (r && typeof r === 'object' && 'buffer' in r && r.buffer instanceof ArrayBuffer) {
          return r.buffer;
        }
        if (r instanceof ArrayBuffer) {
          return r;
        }
        return null;
      }).filter((r): r is ArrayBuffer => !!r);

      this.worker.postMessage({ id, fn, args }, transferables);
    });

    const a = this.tail.then(n, n);
    this.tail = a.then(() => {}, () => {});
    return a;
  }

  async open(bytes: BufferSource, settings?: LibRawSettings): Promise<void> {
    await this.runFn('open', bytes, settings);
  }

  async imageData(): Promise<RawImageData | undefined> {
    return (await this.runFn('imageData')) as RawImageData | undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAW → PNG Conversion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Color conversion config for RAW decode, driven by ColorPipeline strategy.
 * Ensures convertRawToBlob stays in sync with strategy table changes.
 */
export interface RawColorConfig {
  sourceColorSpace: WorkingColorSpace;
  targetColorSpace: WorkingColorSpace;
  conversion: 'none' | 'matrix' | 'icc-engine';
  /**
   * LibRaw `-o` output-colour enum, DERIVED from the resolved source gamut in
   * `decode.ts` (display-p3→7, prophoto-rgb→4, adobe-rgb→2, srgb→1). Replaces
   * the former hard-coded `5` (which was XYZ, not ProPhoto — defect B), so the
   * demosaiced pixels physically ARE in `sourceColorSpace` and match the tag.
   */
  outputColor: number;
}

/**
 * Result of decoding a RAW file: an 8-bit display blob (edit/thumbnail/cold-reload
 * fallback) plus, when 16-bit ingest succeeds, the GPU-ready half-float naked
 * pixels for the `{ kind: 'raw' }` resident path.
 */
export interface RawDecodeResult {
  /** 8-bit sRGB/P3 PNG blob — the display/fallback representation. */
  displayBlob: Blob;
  width: number;
  height: number;
  /**
   * 16-bit naked pixels (IEEE binary16 bit patterns, RGBA interleaved), LINEAR
   * light in the source gamut, scaled by the stage-① exposure anchor. Present
   * ONLY when libraw yielded 16-bit output (`bits === 16`); absent → the decode
   * degraded to the 8-bit display path only.
   */
  highDepth?: {
    data: Uint16Array;
    width: number;
    height: number;
    trc: 'linear';
  };
}

/**
 * Build the 8-bit display proxy from LINEAR source-gamut 16-bit RGBA.
 *
 * Libraw emits LINEAR light (`gamm:[1,1]`), so the display proxy — a plain
 * sRGB/P3 preview with NO GPU gamut/TRC step behind it — must carry the whole
 * `filmic` display intent itself (`core/engine/color/filmic.ts`):
 *   1. `exposureGain` — the per-file scene-median anchor (stage ①);
 *   2. (optionally) the source→target gamut fold IN LINEAR LIGHT;
 *   3. the luma-referenced knee (stage ②, same constants the GPU
 *      `tone_map_filmic` injects) — ONE gain per pixel so chromaticity is
 *      preserved — then the display target's OETF (the sRGB transfer curve,
 *      shared by both `srgb` and `display-p3`) before the 16→8 quantise.
 * Thumbnails / cold-reload fallback / pre-upload frames therefore match the
 * canvas by construction.
 *
 * @param linear16     - RGBA Uint16 (0..65535), LINEAR light, source gamut
 * @param matrix       - source→target 3×3 (row-major, linear light), or null (no fold)
 * @param exposureGain - stage-① anchor (decode-computed; 1 = un-anchored)
 */
export function linearRgba16ToDisplayProxy8(
  linear16: Uint16Array,
  matrix: Float32Array | null,
  exposureGain = 1,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(linear16.length);
  const INV = 1 / 65535;
  for (let i = 0; i < linear16.length; i += 4) {
    let lr = linear16[i] * INV * exposureGain;
    let lg = linear16[i + 1] * INV * exposureGain;
    let lb = linear16[i + 2] * INV * exposureGain;
    if (matrix) {
      const r = matrix[0] * lr + matrix[1] * lg + matrix[2] * lb;
      const g = matrix[3] * lr + matrix[4] * lg + matrix[5] * lb;
      const b = matrix[6] * lr + matrix[7] * lg + matrix[8] * lb;
      lr = r; lg = g; lb = b;
    }
    // filmic knee on luma (stage ②, chroma-preserving) then the sRGB OETF.
    const [tr, tg, tb] = filmicToneMap(clamp01(lr), clamp01(lg), clamp01(lb));
    out[i]     = Math.round(linearToSrgb(tr) * 255);
    out[i + 1] = Math.round(linearToSrgb(tg) * 255);
    out[i + 2] = Math.round(linearToSrgb(tb) * 255);
    out[i + 3] = Math.round(clamp01(linear16[i + 3] * INV) * 255); // alpha: linear, no OETF
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Converts a camera RAW file to an 8-bit display blob + optional 16-bit naked
 * pixels.
 *
 * Supports all LibRaw formats: CR2, CR3, NEF, NRW, ARW, DNG, ORF, RW2, RAF,
 * PEF, SRW, RAW, RWL, 3FR, FFF, IIQ, and more (1200+ cameras).
 *
 * DATA FLOW (16-bit path with asymmetric split):
 *   libraw `outputBps:16` + `gamm:[1,1]` → RGB(A) `Uint16Array` in the resolved
 *   source gamut (`outputColor` derived per-gamut), LINEAR light
 *     → expand to RGBA Uint16
 *     → stage-① filmic exposure anchor: K = 0.18/median(luma)
 *       (`core/engine/color/filmic.ts` — libraw normalizes SENSOR WHITE to 1.0
 *       with zero headroom, so scene placement must be anchored per capture)
 *     → highDepth: pack the source-gamut LINEAR pixels to half-float
 *       (`normalizedUint16ToFloat16`, /65535 × K) → `highDepth.data`, tagged
 *       `linear`. The GPU sampling shader does the source→working gamut matrix
 *       (tagged per-asset in `raw/decode.ts`) and the fixed filmic knee — NO
 *       CPU gamut/TRC math happens on this branch; the gain keeps it
 *       LINEAR light in the source gamut.
 *     → display blob: the whole filmic display intent in one helper —
 *       exposure anchor → linear gamut fold (only for a wide source) → fixed
 *       knee → sRGB OETF → 8-bit (`linearRgba16ToDisplayProxy8`). The proxy is
 *       a plain preview with no GPU step behind it, so it carries its own
 *       display transform — identical constants to the GPU operator, so
 *       thumbnails / cold-reload fallback / pre-upload frames match the canvas.
 *
 * @param file - RAW file to decode
 * @param colorConfig - Strategy-driven color conversion parameters
 */
export async function convertRawToBlob(file: File, colorConfig: RawColorConfig): Promise<RawDecodeResult> {
  const instance = new LibRaw();

  try {
    const buffer = await file.arrayBuffer();

    await instance.open(new Uint8Array(buffer), {
      useCameraWb: true,
      // Derived per-gamut in decode.ts (display-p3→7, prophoto→4, adobe→2, srgb→1).
      // Replaces the former hard-coded `5` (which was XYZ, not ProPhoto — defect B).
      outputColor: colorConfig.outputColor,
      outputBps: 16,         // 16-bit output (preserve 14-bit demosaic precision)
      // LINEAR output. The f16 truth line then carries real
      // linear light matching the `trc:'linear'` identity; the 8-bit display proxy
      // applies the display-target OETF itself (linearRgba16ToDisplayProxy8).
      gamm: [1, 1],
      userQual: 3,           // AHD interpolation
    });

    const imageData: RawImageData | undefined = await instance.imageData();
    if (!imageData) {
      throw new Error('Failed to decode RAW image: no image data returned');
    }

    const { width, height, data, colors, bits } = imageData;

    // ── 16-bit path (bits === 16, the outputBps:16 result) ──────────────────
    if (bits === 16) {
      const px = width * height;

      // Expand to RGBA Uint16 (libraw gives packed RGB or RGBA).
      const rgba16 = new Uint16Array(px * 4);
      const src16 = data as Uint16Array;
      if (colors === 3) {
        for (let i = 0, j = 0; i < src16.length; i += 3, j += 4) {
          rgba16[j] = src16[i];
          rgba16[j + 1] = src16[i + 1];
          rgba16[j + 2] = src16[i + 2];
          rgba16[j + 3] = 65535; // opaque in the 16-bit range
        }
      } else {
        rgba16.set(new Uint16Array(src16.buffer, src16.byteOffset, px * 4));
      }

      // Stage ① exposure anchor (filmic.ts): libraw normalizes SENSOR WHITE to
      // 1.0 with zero headroom, so scene placement varies per capture — anchor
      // the scene median onto 18% display-linear grey (dcraw auto-bright
      // convention). Sampled, not exhaustive: ~64k luma points is plenty for a
      // robust median at 12MP+.
      const anchorStep = Math.max(1, Math.floor(px / 65536));
      const lumaSample: number[] = [];
      for (let p = 0; p < px; p += anchorStep) {
        const j = p * 4;
        lumaSample.push((0.2126 * rgba16[j] + 0.7152 * rgba16[j + 1] + 0.0722 * rgba16[j + 2]) / 65535);
      }
      lumaSample.sort((a, b) => a - b);
      const exposureGain = filmicExposureGain(lumaSample[Math.floor(lumaSample.length / 2)]);

      // Asymmetric split:
      //   • 16-bit half-float highDepth → GPU: keep the ORIGINAL source-gamut
      //     pixels UNCONVERTED and LINEAR. The GPU sampling shader performs the
      //     source→working gamut matrix (`gamut_to_working`, tagged per-asset via
      //     decode.ts). Folding here too would DOUBLE-CONVERT once the GPU consumer
      //     is active, and folding in 16-bit uint would clip highlights outside the
      //     target gamut before they ever reach the wide-gamut float buffer.
      //     The `exposureGain` rides along on this line (RGB only, alpha
      //     untouched): a positive linear gain keeps the line LINEAR-light in
      //     the source gamut — `trc:'linear'` stays true — and f16 cannot clip.
      //   • 8-bit display blob → a plain sRGB/P3 preview with no GPU gamut step
      //     behind it, so it carries the whole filmic display intent itself:
      //     the same exposure gain + the fixed knee (stage ②, shared constants
      //     with the GPU operator) + the display-target OETF.
      // 'none' → source already IS the display target (no matrix fold needed).
      // 'icc-engine' → N/A for RAW (libraw emits known RGB spaces).
      const displayMatrix =
        colorConfig.conversion === 'matrix'
          ? getConversionMatrix(colorConfig.sourceColorSpace, colorConfig.targetColorSpace)
          : null;

      // Pack the SOURCE-gamut LINEAR 16-bit pixels to half-float (normalized
      // /65535, exposure-anchored) for the `{ kind: 'raw' }` → rgba16float
      // resident upload; the GPU folds the gamut and applies the knee, so this
      // stays the untouched linear source truth line.
      const half = normalizedUint16ToFloat16(rgba16, exposureGain);

      // 8-bit display proxy: exposure anchor → optional linear gamut fold →
      // filmic knee → sRGB OETF → 16→8 quantise.
      const rgba8 = linearRgba16ToDisplayProxy8(rgba16, displayMatrix, exposureGain);
      const displayBlob = await encodeDisplayBlob(rgba8, width, height, colorConfig.targetColorSpace);

      return {
        displayBlob,
        width,
        height,
        highDepth: { data: half, width, height, trc: 'linear' },
      };
    }

    // ── 8-bit fallback path (bits !== 16 — defensive, no 16-bit regression) ──
    // libraw now emits LINEAR light (`gamm:[1,1]`) here too, so this path carries
    // the same filmic intent via the same proxy helper (upscaled to the 16-bit
    // linear domain it expects): median anchor → optional fold → knee → OETF.
    const linear16 = new Uint16Array(width * height * 4);
    if (colors === 3) {
      const src = data as Uint8Array;
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        linear16[j] = src[i] * 257;
        linear16[j + 1] = src[i + 1] * 257;
        linear16[j + 2] = src[i + 2] * 257;
        linear16[j + 3] = 65535;
      }
    } else {
      const src = new Uint8Array(data.buffer, data.byteOffset, width * height * 4);
      for (let k = 0; k < src.length; k++) linear16[k] = src[k] * 257;
    }

    const anchorStep = Math.max(1, Math.floor(width * height / 65536));
    const lumaSample: number[] = [];
    for (let p = 0; p < width * height; p += anchorStep) {
      const j = p * 4;
      lumaSample.push((0.2126 * linear16[j] + 0.7152 * linear16[j + 1] + 0.0722 * linear16[j + 2]) / 65535);
    }
    lumaSample.sort((a, b) => a - b);
    const exposureGain = filmicExposureGain(lumaSample[Math.floor(lumaSample.length / 2)]);

    const fallbackMatrix =
      colorConfig.conversion === 'matrix'
        ? getConversionMatrix(colorConfig.sourceColorSpace, colorConfig.targetColorSpace)
        : null;
    const rgbaData = linearRgba16ToDisplayProxy8(linear16, fallbackMatrix, exposureGain);

    const displayBlob = await encodeDisplayBlob(rgbaData, width, height, colorConfig.targetColorSpace);
    return { displayBlob, width, height };
  } catch (error) {
    console.error('[RawHandler] Conversion failed', error);
    throw error;
  } finally {
    instance.dispose();
  }
}

/**
 * Encode an 8-bit RGBA buffer to a PNG blob, tagged with the correct canvas
 * color space so the browser does not implicitly re-convert (P3 stays P3).
 */
async function encodeDisplayBlob(
  rgba8: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  targetColorSpace: WorkingColorSpace,
): Promise<Blob> {
  const canvasCS: PredefinedColorSpace = targetColorSpace === 'display-p3' ? 'display-p3' : 'srgb';
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace: canvasCS })!;
  const imgData = new ImageData(rgba8, width, height, { colorSpace: canvasCS });
  ctx.putImageData(imgData, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
