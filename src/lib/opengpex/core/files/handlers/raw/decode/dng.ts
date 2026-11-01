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
 * decode/dng.ts — the DNG first-principles color chains: the calibrated
 * reference-equivalent chain (decodeDngCalibrated, default) and the hybrid v1
 * chain kept as its degradation path.
 *
 * LibRaw is narrowed to container + linearization + levels + demosaic
 * (`-o 0`: no color matrix, camera-WB gains applied — probe-verified
 * 20261030). Everything color is this module's composition of the engine's
 * pure math.
 *
 * TONE PLACEMENT (hybrid v1, calibrated against the reference renderer's own
 * output of the sample files — see probes/raw/oracle `-render`): a
 * first-principles port of the reference exposure/tone stages (exposure ramp,
 * default contrast curve) did NOT yet reproduce the reference render from
 * identical input, and LibRaw's `-o 0` output scale diverges from the
 * reference Stage3 scale by a file-dependent factor (measured 4.2×/6.2×).
 * Shipping that port blew out high-key captures. What IS verified:
 *   1. the camera→working matrix chain (golden vs reference, 1e-6);
 *   2. the legacy scene-anchor placement — the scene median anchored onto
 *      18% display grey matches the vendor's own preview placement of the
 *      sample captures (vendor preview median ≈ 0.19 display-linear).
 * So v1 = verified matrix + the proven legacy tone stages (anchor → knee),
 * applied in the working space. The full reference tone port (BaselineExposure
 * ramp + default render curve + gain-table order) continues behind
 * `oracle -render` ground truth in a dedicated calibration round.
 *
 * Output contract:
 *   • f16 master: working-linear ProPhoto scaled by the anchor gain
 *     (overrange preserved — the GPU knee places highlights);
 *   • colorIdentity: gamut 'prophoto-rgb' (working — GPU fold is identity),
 *     trc 'linear', rawWhiteDomain present ⟹ the GPU applies the SAME filmic
 *     knee the legacy chain uses (tone parity with the proven path);
 *   • 8-bit proxy: anchor → knee → fold → OETF, matching the canvas.
 */

import type { DecodedPayload } from '../../../types';
import type { IngestDecision as Decision } from '../../../strategy';
import {
  buildDngColorPipeline,
  interpolateHueSatGridForProfile,
  type DngColorPipeline,
  type HueSatGrid,
} from '@opengpex/editor/core/engine/color/raw/dng-spec';
import { renderDngScene } from '@opengpex/editor/core/engine/color/raw/dng-render';
import {
  linearizeStage2,
  demosaicBilinearCfa,
  invertDisplayCurve,
} from '@opengpex/editor/core/engine/color/raw/dng-stages';
import {
  filmicExposureGain,
  clampFilmicWhiteDomain,
  filmicToneMap,
} from '@opengpex/editor/core/engine/color/filmic';
import {
  parseDngCameraProfileData,
  parseDngGainTableMap,
  parseDngHueSatMap,
  parseDngLinearizationData,
  parseDngLookTable,
  parseDngProfileToneCurve,
  parseDngRenderFacts,
  parseDngShadowScale,
} from '../metadata/dng';
import { linearFloatToFloat16 } from '@opengpex/editor/core/engine/color/float16';
import { getConversionMatrix } from '@opengpex/editor/core/engine/color/matrices';
import { linearToSrgb } from '@opengpex/editor/core/engine/color/trc';
import { LibRaw } from '../libraw';
import type { WorkingColorSpace } from '@opengpex/editor/core/types';

/** Candidate gate: DNG files are the first-principles chain's inputs. */
export function isDngFirstPrinciplesCandidate(file: File): boolean {
  return /\.dng$/i.test(file.name);
}

/**
 * Hybrid v1 chain (verified matrix + legacy anchor/knee tone). Kept as the
 * degradation path when the calibrated chain cannot run on a file. Throws on
 * any failure — the caller degrades to the legacy chain.
 */
export async function decodeDngHybrid(
  file: File,
  decision: Decision,
): Promise<DecodedPayload[]> {
  const buffer = await file.arrayBuffer();

  // Parse the profile BEFORE instance.open — the open hands the buffer to the
  // worker as a transferable, which detaches it.
  const profile = parseDngCameraProfileData(new Uint8Array(buffer.slice(0)));
  if (!profile.colorMatrix1) {
    throw new Error('dng-first-principles: no ColorMatrix1 — not a candidate');
  }
  const pipeline: DngColorPipeline | null = buildDngColorPipeline(profile);
  if (!pipeline) throw new Error('dng-first-principles: pipeline build failed');

  const instance = new LibRaw();
  try {
    await instance.open(new Uint8Array(buffer), {
      useCameraWb: true,
      outputColor: 0, // raw camera RGB — the matrix below owns the color
      outputBps: 16,
      gamm: [1, 1],
      userQual: 3,
    });
    const imageData = await instance.imageData();
    if (!imageData) throw new Error('dng-first-principles: no image data');
    const { width, height, data, colors, bits } = imageData;
    if (bits !== 16) throw new Error(`dng-first-principles: unexpected ${bits}-bit output`);

    // Expand to RGBA f32 camera-linear.
    const px = width * height;
    const working = new Float32Array(px * 4);
    const src = data as Uint16Array;
    if (colors === 3) {
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        working[j] = src[i] / 65535;
        working[j + 1] = src[i + 1] / 65535;
        working[j + 2] = src[i + 2] / 65535;
        working[j + 3] = 1;
      }
    } else {
      for (let i = 0, j = 0; j < working.length; i += 4, j += 4) {
        working[j] = src[i] / 65535;
        working[j + 1] = src[i + 1] / 65535;
        working[j + 2] = src[i + 2] / 65535;
        working[j + 3] = 1;
      }
    }

    // Stage 1: camera → working matrix (the golden-verified color chain).
    const m = pipeline.cameraToWorking;
    const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5];
    const m6 = m[6], m7 = m[7], m8 = m[8];
    for (let j = 0; j < working.length; j += 4) {
      const r = working[j];
      const g = working[j + 1];
      const b = working[j + 2];
      working[j] = m0 * r + m1 * g + m2 * b;
      working[j + 1] = m3 * r + m4 * g + m5 * b;
      working[j + 2] = m6 * r + m7 * g + m8 * b;
    }

    // Stage 2: the proven legacy tone placement — scene median anchored onto
    // 18% display grey (sampled, not exhaustive), highlight percentile for the
    // GPU knee's white domain. Same stages, same constants as the legacy
    // decode; only the input pixels are matrix-corrected.
    const anchorStep = Math.max(1, Math.floor(px / 65536));
    const lumaSample: number[] = [];
    for (let p = 0; p < px; p += anchorStep) {
      const j = p * 4;
      lumaSample.push(0.2126 * working[j] + 0.7152 * working[j + 1] + 0.0722 * working[j + 2]);
    }
    lumaSample.sort((a, b) => a - b);
    const exposureGain = filmicExposureGain(lumaSample[Math.floor(lumaSample.length / 2)]);
    const anchoredP995 = lumaSample[Math.floor(lumaSample.length * 0.995)] * exposureGain;
    const rawWhiteDomain = clampFilmicWhiteDomain(anchoredP995);

    // Stage 3: pack the f16 master — anchored LINEAR working-space pixels
    // (overrange preserved; the GPU knee places highlights), riding the white
    // domain via colorIdentity.
    for (let j = 0; j < working.length; j += 4) {
      working[j] *= exposureGain;
      working[j + 1] *= exposureGain;
      working[j + 2] *= exposureGain;
    }
    const half = linearFloatToFloat16(working);

    // Stage 4: 8-bit proxy — anchor → linear fold ProPhoto → display target →
    // filmic knee (same constants as the GPU) → OETF. No style preset (the
    // decision: style stays a user-explicit toggle; the proxy bakes the
    // neutral default).
    const target: WorkingColorSpace = 'display-p3';
    const fold = getConversionMatrix('prophoto-rgb', target);
    const rgba8 = new Uint8ClampedArray(px * 4);
    for (let j = 0; j < working.length; j += 4) {
      let r = working[j];
      let g = working[j + 1];
      let b = working[j + 2];
      if (fold) {
        const nr = fold[0] * r + fold[1] * g + fold[2] * b;
        const ng = fold[3] * r + fold[4] * g + fold[5] * b;
        const nb = fold[6] * r + fold[7] * g + fold[8] * b;
        r = nr; g = ng; b = nb;
      }
      const [tr, tg, tb] = filmicToneMap(
        Math.min(1, Math.max(0, r)),
        Math.min(1, Math.max(0, g)),
        Math.min(1, Math.max(0, b)),
        rawWhiteDomain,
      );
      rgba8[j] = Math.round(linearToSrgb(tr) * 255);
      rgba8[j + 1] = Math.round(linearToSrgb(tg) * 255);
      rgba8[j + 2] = Math.round(linearToSrgb(tb) * 255);
      rgba8[j + 3] = 255;
    }
    const displayBlob = await encodeDisplayBlob(rgba8, width, height, target);

    const safeFile = new File([displayBlob], file.name.replace(/\.[^.]+$/, '.png'), {
      type: 'image/png',
    });

    return [
      {
        displayBlob: safeFile,
        width,
        height,
        index: 0,
        highDepthSource: {
          data: half,
          width,
          height,
        },
        // Working-space identity (the sanctioned per-page exception): the
        // pixels ARE working ProPhoto-linear, so the GPU fold is identity; the
        // white domain turns on the SAME filmic knee the legacy chain uses.
        colorIdentity: {
          gamut: 'prophoto-rgb',
          trc: 'linear',
          bitDepth: decision.colorIdentity.bitDepth,
          dataFormat: 'rgba16float',
          rawWhiteDomain,
        },
      },
    ];
  } finally {
    instance.dispose();
  }
}

/** Encode display-encoded RGBA to a tagged PNG blob. */
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

// ═══════════════════════════════════════════════════════════════════════════════
// Calibrated chain (default)
// ═══════════════════════════════════════════════════════════════════════════════

/** Parsed HSM/LookTable payload → engine grid (first data set only). */
function toGrid(
  dims: readonly [number, number, number],
  data: readonly number[],
): HueSatGrid {
  const deltas: [number, number, number][] = [];
  for (let i = 0; i + 2 < data.length; i += 3) deltas.push([data[i], data[i + 1], data[i + 2]]);
  return { hueDivisions: dims[0], satDivisions: dims[1], valDivisions: dims[2], deltas };
}

/**
 * Apply an EXIF orientation to an RGBA f32 buffer (1 = identity). The chain
 * runs in stored sensor orientation (the gain-table geometry is defined
 * there), so the decode rotates only at the very end.
 */
function orientRgba(
  src: Float32Array,
  width: number,
  height: number,
  orientation: number,
): { data: Float32Array; width: number; height: number } {
  if (orientation === 1 || orientation < 1 || orientation > 8) return { data: src, width, height };
  const swap = orientation >= 5;
  const ow = swap ? height : width;
  const oh = swap ? width : height;
  const out = new Float32Array(ow * oh * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number, dy: number;
      switch (orientation) {
        case 2: dx = width - 1 - x; dy = y; break;
        case 3: dx = width - 1 - x; dy = height - 1 - y; break;
        case 4: dx = x; dy = height - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = height - 1 - y; dy = x; break;
        case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        default: dx = y; dy = width - 1 - x; break; // 8
      }
      const s = (y * width + x) * 4;
      const d = (dy * ow + dx) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return { data: out, width: ow, height: oh };
}

/**
 * Render one DNG through the calibrated chain: the file's own tag math for
 * the raw stages (linearization table, black/white levels, the reference
 * bilinear CFA interpolator) and the reference render stages for color and
 * tone. Output is display-referred ProPhoto linear: the payload carries NO
 * rawWhiteDomain, so the GPU passes it through without a second tone map.
 * Throws on any unsupported file — the caller degrades to the hybrid chain.
 */
export async function decodeDngFirstPrinciples(
  file: File,
  decision: Decision,
): Promise<DecodedPayload[]> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer.slice(0));

  const profile = parseDngCameraProfileData(bytes);
  if (!profile.colorMatrix1 || !profile.asShotNeutral) {
    throw new Error('dng-calibrated: no ColorMatrix1/AsShotNeutral');
  }
  const pipeline = buildDngColorPipeline(profile, profile.asShotNeutral as [number, number, number]);
  if (!pipeline) throw new Error('dng-calibrated: pipeline build failed');
  const facts = parseDngRenderFacts(bytes);
  if (facts.cfaPattern && facts.cfaLayout !== 1) {
    throw new Error(`dng-calibrated: CFA layout ${facts.cfaLayout} unsupported`);
  }

  const instance = new LibRaw();
  let camera: Float32Array;
  let width: number;
  let height: number;
  try {
    if (facts.cfaPattern) {
      // CFA: the raw stage is bit-exact sensor data; rebuild Stage2/3 here.
      await instance.open(new Uint8Array(buffer), { userFlip: 0 });
      const raw = await instance.rawImageData();
      if (!raw) throw new Error('dng-calibrated: no raw sensor data');
      const lin = parseDngLinearizationData(bytes, 1);
      const stage2 = linearizeStage2(raw.data, raw.raw_width, raw.raw_height, 1, lin);
      const { rows, cols, colors } = facts.cfaPattern;
      const demosaiced = demosaicBilinearCfa(stage2.data, stage2.width, stage2.height, colors, rows, cols);
      camera = demosaiced.rgb;
      for (let i = 0; i < camera.length; i++) camera[i] /= 65535;
      width = demosaiced.width;
      height = demosaiced.height;
    } else {
      // Linear: the library's processed output is the linearized image under
      // its baked display curve — invert the curve (unbalanced, unscaled).
      await instance.open(new Uint8Array(buffer), {
        useCameraWb: false,
        noAutoBright: true,
        noAutoScale: true,
        outputColor: 0,
        outputBps: 16,
        userFlip: 0,
      });
      const img = await instance.imageData();
      if (!img || img.bits !== 16) throw new Error('dng-calibrated: no 16-bit image data');
      width = img.width;
      height = img.height;
      const src = img.data as Uint16Array;
      const ch = img.colors;
      camera = new Float32Array(width * height * 3);
      for (let p = 0; p < width * height; p++) {
        for (let c = 0; c < 3; c++) camera[p * 3 + c] = invertDisplayCurve(src[p * ch + c] / 65535);
      }
    }
  } finally {
    instance.dispose();
  }

  const hsm = parseDngHueSatMap(bytes);
  const grid1 = hsm ? toGrid(hsm.dims, hsm.data1) : undefined;
  const grid2 = hsm?.data2 ? toGrid(hsm.dims, hsm.data2) : undefined;
  const look = parseDngLookTable(bytes);

  const rendered = renderDngScene(camera, width, height, {
    pipeline,
    hueSatMap: interpolateHueSatGridForProfile(grid1, grid2, profile, pipeline.whiteXY),
    lookTable: look ? toGrid(look.dims, look.data) : null,
    gainTableMap: parseDngGainTableMap(bytes) ?? null,
    exposure: (profile.baselineExposure ?? 0) + facts.baselineExposureOffset,
    shadowScale: parseDngShadowScale(bytes) ?? 1,
    noShadowPedestal: facts.defaultBlackRender === 1,
    toneCurve: parseDngProfileToneCurve(bytes) ?? null,
    crop: facts.defaultCrop ?? null,
    baselineSharpness: facts.baselineSharpness,
  });
  const oriented = orientRgba(rendered.rgba, rendered.width, rendered.height, facts.orientation);
  const outW = oriented.width;
  const outH = oriented.height;
  const working = oriented.data;
  const half = linearFloatToFloat16(working);

  // 8-bit proxy: display-referred ProPhoto → display target → OETF.
  const target: WorkingColorSpace = 'display-p3';
  const fold = getConversionMatrix('prophoto-rgb', target);
  const rgba8 = new Uint8ClampedArray(outW * outH * 4);
  for (let j = 0; j < working.length; j += 4) {
    let r = working[j], g = working[j + 1], b = working[j + 2];
    if (fold) {
      const nr = fold[0] * r + fold[1] * g + fold[2] * b;
      const ng = fold[3] * r + fold[4] * g + fold[5] * b;
      const nb = fold[6] * r + fold[7] * g + fold[8] * b;
      r = nr; g = ng; b = nb;
    }
    rgba8[j] = Math.round(linearToSrgb(Math.min(1, Math.max(0, r))) * 255);
    rgba8[j + 1] = Math.round(linearToSrgb(Math.min(1, Math.max(0, g))) * 255);
    rgba8[j + 2] = Math.round(linearToSrgb(Math.min(1, Math.max(0, b))) * 255);
    rgba8[j + 3] = 255;
  }
  const displayBlob = await encodeDisplayBlob(rgba8, outW, outH, target);
  const safeFile = new File([displayBlob], file.name.replace(/\.[^.]+$/, '.png'), { type: 'image/png' });

  return [
    {
      displayBlob: safeFile,
      width: outW,
      height: outH,
      index: 0,
      highDepthSource: { data: half, width: outW, height: outH },
      // Display-referred working pixels: GPU fold is identity, and the absent
      // white domain keeps the GPU from tone mapping a second time.
      colorIdentity: {
        gamut: 'prophoto-rgb',
        trc: 'linear',
        bitDepth: decision.colorIdentity.bitDepth,
        dataFormat: 'rgba16float',
      },
    },
  ];
}
