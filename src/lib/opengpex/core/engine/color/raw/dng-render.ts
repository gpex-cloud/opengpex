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
 * dng-render.ts — the calibrated DNG render chain: reference-Stage3 camera
 * pixels → display-referred ProPhoto linear, stage for stage in the reference
 * render's order. Pixel-verified against the reference renderer's own output
 * (8-bit |diff| p95 ≤ 5 on linear, Bayer and neutral-patch samples):
 *
 *   1. clip each camera channel at the solved camera white, apply the
 *      camera→ProPhoto matrix, pin to [0, 1];
 *   2. HueSatMap (lattice), on the full active area;
 *   3. ProfileGainTableMap (spatial; geometry anchored to the active area);
 *   4. crop to the default-crop window;
 *   5. exposure ramp (BaselineExposure white + shadow pedestal);
 *   6. LookTable (lattice);
 *   7. joint-RGB hue-preserving tone — the profile's own tone spline when it
 *      declares one, else the default curve — composed with the negative-
 *      exposure tone;
 *   8. capture sharpening (luma-only unsharp mask driven by the file's
 *      BaselineSharpness). The reference render stops at 7 — the tag is
 *      carried for converters to act on — so the pixel-parity gates compare
 *      with sharpening disabled.
 *
 * Input pixels are UNBALANCED camera RGB in [0, 1] (the reference Stage3
 * scale; see dng-stages.ts) — the white balance lives in the matrix, which is
 * built from the file's real AsShotNeutral.
 *
 * @module core/engine/color/dng-render
 */

import {
  applyHuePreservingTone,
  applyProfileLookLut,
  bakeHueSatLut,
  bakeLookTableLut,
  bakeToneTable,
  buildProfileToneSpline,
  makeExposureRamp,
  type DngColorPipeline,
  type HueSatGrid,
} from './dng-spec';
import {
  applyBakedGainTableMap,
  bakeGainTableMapSpatial,
  type DngGainTableMap,
} from './gainTableMap';

/** Everything the chain consumes besides the pixels. */
export interface DngRenderInputs {
  pipeline: DngColorPipeline;
  hueSatMap: HueSatGrid | null;
  lookTable: HueSatGrid | null;
  gainTableMap: DngGainTableMap | null;
  /** BaselineExposure + profile BaselineExposureOffset, stops. */
  exposure: number;
  shadowScale: number;
  /** DefaultBlackRender = 1 ("None") disables the shadow pedestal. */
  noShadowPedestal: boolean;
  toneCurve: ReadonlyArray<readonly [number, number]> | null;
  crop: { x: number; y: number; width: number; height: number } | null;
  /**
   * The file's BaselineSharpness (relative amount the camera model needs).
   * 0 disables the capture-sharpening stage.
   */
  baselineSharpness: number;
}

/**
 * Capture-sharpening calibration. The unsharp mask runs on display-encoded
 * luma (sRGB-curve encoded ProPhoto luminance) with a Gaussian of
 * SHARPEN_SIGMA px; its amount is BaselineSharpness × SHARPEN_AMOUNT_PER_UNIT.
 * Fitted on a phone linear DNG (BaselineSharpness 1.5) against the writer's
 * own embedded rendition: σ 0.8 / amount 2.0 brings every band above 0.25
 * Nyquist to within 0.9–1.03 of its spectrum (unsharpened: 1.65–2.67× short).
 */
const SHARPEN_SIGMA = 0.8;
const SHARPEN_AMOUNT_PER_UNIT = 2.0 / 1.5;

/** ProPhoto (D50) relative luminance weights — the Y row of RGB→XYZ. */
const PROPHOTO_Y = [0.2880402, 0.7118741, 0.0000857] as const;

const encodeLuma = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const decodeLuma = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

/**
 * Luma-only unsharp mask in place on RGBA display-referred linear pixels.
 * Chroma is untouched: each pixel's RGB is scaled by the ratio of sharpened
 * to original luminance, so no colour fringes appear at edges.
 */
export function applyCaptureSharpening(
  rgba: Float32Array,
  width: number,
  height: number,
  amount: number,
  sigma: number = SHARPEN_SIGMA,
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const px = width * height;
  const lum = new Float32Array(px);
  const enc = new Float32Array(px);
  for (let p = 0, j = 0; p < px; p++, j += 4) {
    const y = PROPHOTO_Y[0] * rgba[j] + PROPHOTO_Y[1] * rgba[j + 1] + PROPHOTO_Y[2] * rgba[j + 2];
    lum[p] = y;
    enc[p] = encodeLuma(y < 0 ? 0 : y > 1 ? 1 : y);
  }

  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(2 * radius + 1);
  let ksum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = w;
    ksum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= ksum;

  const tmp = new Float32Array(px);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += enc[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        acc += tmp[yy * width + x] * kernel[k + radius];
      }
      const p = y * width + x;
      let sharp = enc[p] + amount * (enc[p] - acc);
      if (sharp < 0) sharp = 0; else if (sharp > 1) sharp = 1;
      const y0 = lum[p];
      if (y0 <= 1e-6) continue;
      const ratio = decodeLuma(sharp) / y0;
      const j = p * 4;
      rgba[j] *= ratio;
      rgba[j + 1] *= ratio;
      rgba[j + 2] *= ratio;
    }
  }
}

/**
 * Render interleaved camera RGB (`rgb`, 3 floats/pixel, `width × height` =
 * the active area) to RGBA f32 display-referred ProPhoto linear over the crop.
 */
export function renderDngScene(
  rgb: Float32Array,
  width: number,
  height: number,
  inputs: DngRenderInputs,
): { rgba: Float32Array; width: number; height: number } {
  const { pipeline } = inputs;
  const m = pipeline.cameraToWorking;
  const cw = pipeline.cameraWhite;
  const px = width * height;
  const buf = new Float32Array(px * 4);
  const pin = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

  for (let p = 0; p < px; p++) {
    const r = Math.min(rgb[p * 3], cw[0]);
    const g = Math.min(rgb[p * 3 + 1], cw[1]);
    const b = Math.min(rgb[p * 3 + 2], cw[2]);
    const j = p * 4;
    buf[j] = pin(m[0] * r + m[1] * g + m[2] * b);
    buf[j + 1] = pin(m[3] * r + m[4] * g + m[5] * b);
    buf[j + 2] = pin(m[6] * r + m[7] * g + m[8] * b);
    buf[j + 3] = 1;
  }

  const hsmLut = bakeHueSatLut(inputs.hueSatMap);
  if (hsmLut) {
    for (let j = 0; j < buf.length; j += 4) {
      const [r, g, b] = applyProfileLookLut(hsmLut, buf[j], buf[j + 1], buf[j + 2]);
      buf[j] = r; buf[j + 1] = g; buf[j + 2] = b;
    }
  }

  if (inputs.gainTableMap) {
    applyBakedGainTableMap(buf, width, height, bakeGainTableMapSpatial(inputs.gainTableMap), inputs.exposure);
  }

  const crop = inputs.crop ?? { x: 0, y: 0, width, height };
  const cx = Math.max(0, Math.min(width - 1, crop.x));
  const cy = Math.max(0, Math.min(height - 1, crop.y));
  const cW = Math.min(crop.width, width - cx);
  const cH = Math.min(crop.height, height - cy);
  const out = new Float32Array(cW * cH * 4);
  for (let y = 0; y < cH; y++) {
    const src = ((y + cy) * width + cx) * 4;
    out.set(buf.subarray(src, src + cW * 4), y * cW * 4);
  }

  const ramp = makeExposureRamp(inputs.exposure, inputs.noShadowPedestal ? 0 : inputs.shadowScale);
  const lookLut = bakeLookTableLut(inputs.lookTable);
  const spline = inputs.toneCurve ? buildProfileToneSpline(inputs.toneCurve) : null;
  const tone = bakeToneTable(inputs.exposure, spline);

  for (let j = 0; j < out.length; j += 4) {
    let r = ramp(out[j]);
    let g = ramp(out[j + 1]);
    let b = ramp(out[j + 2]);
    if (lookLut) [r, g, b] = applyProfileLookLut(lookLut, r, g, b);
    [r, g, b] = applyHuePreservingTone(tone, r, g, b);
    out[j] = r; out[j + 1] = g; out[j + 2] = b;
  }

  applyCaptureSharpening(out, cW, cH, inputs.baselineSharpness * SHARPEN_AMOUNT_PER_UNIT);
  return { rgba: out, width: cW, height: cH };
}
