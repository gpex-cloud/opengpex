/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Preset thumbnail rendering — one live capture, N graded miniatures.
 *
 * The base miniature comes from `pixels.render.capture` (the SAME WebGPU
 * composite the canvas shows), downscaled so its longest edge stays within
 * `THUMB_SOURCE_MAX` px. Each preset thumbnail is then produced by applying
 * the preset's grade arms on CPU to a copy of that base.
 *
 * FIDELITY CONTRACT (what matches the applied-layer grade exactly vs what is
 * an approximation). The engine's `apply_adjust_chain` (adjust.wgsl) runs the
 * whole grade TRC-WRAPPED in the ENCODED sRGB domain, and so does this CPU
 * grader on the captured sRGB pixels — same space, same stage order
 * (brightness/contrast -> levels -> curves -> colorBalance -> fused colour
 * matrix). Per arm:
 *
 * - levels / curves — EXACT math source: the shared LUT builders
 *   (`generateLevelsLUT` / `buildCurvesChannelTablesF32`) produce the same
 *   tables the GPU atlas samples. Residual difference is lookup style
 *   (nearest index here vs hardware linear filtering) — sub-code-value.
 * - saturation / hueRotate / channelMix — EXACT math source: the fused
 *   colour matrix is composed with the SAME pure matrices
 *   (`engine/color/adjustMatrices.ts`) the GPU packer fuses into
 *   `color_matrix`, in the same left-multiply order, with the same channelMix
 *   constant offset.
 * - brightness / contrast / colorBalance — FORMULA MIRRORS, not shared code:
 *   the GPU evaluates these operators IN-SHADER, so their formulas exist only
 *   in WGSL. This module transcribes the documented v1-contract formulas
 *   (quadratic midtone brightness, tanh S-curve contrast, HSL-lightness
 *   zone-weighted colorBalance) with "keep in sync with adjust.wgsl" markers.
 *   A future WGSL edit that is not mirrored here degrades thumbnails only —
 *   the applied layer always uses the real GPU pipeline.
 *
 * @module plugins/base/drawers/AdjustmentDrawer/presets/preview
 */

import type { Frame, Layer } from '@opengpex/editor/core/types';
import type { SampledPixels } from '@opengpex/editor/core/engine/types';
import { sampleGpuRawData } from '@opengpex/editor/core/engine/utils/sample-utils';
import { generateLevelsLUT, buildCurvesChannelTablesF32 } from '@opengpex/editor/core/engine/color/luts';
import {
  ADJUST_IDENTITY_M9,
  adjustHueMatrix,
  adjustSaturationMatrix,
  mulAdjustMat3,
  type Mat9,
} from '@opengpex/editor/core/engine/color/adjustMatrices';
import type { PresetGradeState } from './preset-chain';
import { PRESET_IDENTITY } from './preset-chain';

/** Longest-edge cap for the captured source miniature. */
export const THUMB_SOURCE_MAX = 256;

/** Snapshot scale that keeps the longest edge within `THUMB_SOURCE_MAX`. */
export function thumbCaptureScale(frame: Frame): number {
  const maxEdge = Math.max(frame.canvas.w, frame.canvas.h);
  return maxEdge > 0 ? Math.min(1, THUMB_SOURCE_MAX / maxEdge) : 1;
}

/**
 * The capture layer subset that yields a BASELINE-LOCKED thumbnail source.
 *
 * The default all-layers composite runs every layer's grade chain, including
 * the active layer's `adjustMasks`. With a preset already applied, that would
 * bake the preset into the base miniature and the next capture would grade
 * preset-on-preset. So the subset mirrors the default selection (visible,
 * non-group, non-host) but shallow-clones the active layer with its grade
 * chain stripped — an identity grade through the same pipeline. Every other
 * layer passes through untouched, and the original layer objects are never
 * mutated.
 */
export function baselineCaptureLayers(frame: Frame, activeLayerId: string | undefined): Layer[] {
  return frame.layers.order
    .map((id) => frame.layers.byId[id])
    .filter((l) => !l.hostId && l.visible !== false && l.type !== 'group')
    .map((l) => (l.id === activeLayerId ? { ...l, adjustMasks: undefined } : l));
}

/**
 * Capture the current composite as a display-space sRGB canvas. One round
 * trip; call once when the panel opens (or the active layer/frame changes),
 * never per frame.
 */
export async function captureThumbSource(
  frame: Frame,
  capture: (frame: Frame, opts?: { scale?: number; layers?: Layer[] }) => Promise<SampledPixels>,
  layers?: Layer[],
): Promise<HTMLCanvasElement | null> {
  const snap = await capture(frame, { scale: thumbCaptureScale(frame), layers });
  // sampleGpuRawData converts the raw premultiplied-linear readback into the
  // display track (straight sRGB 8-bit). Sampling one oversized block centered
  // on the coverage returns the whole snapshot (clipped to its own bounds).
  const cx = snap.bounds.x + snap.bounds.w / 2;
  const cy = snap.bounds.y + snap.bounds.h / 2;
  const radius = Math.ceil(Math.max(snap.bounds.w, snap.bounds.h) * snap.scale) + 1;
  const block = sampleGpuRawData(snap, cx, cy, radius);
  if (!block || block.w <= 0 || block.h <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = block.w;
  canvas.height = block.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rgb8 = block.rgb8;
  if (!rgb8) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgb8.buffer as ArrayBuffer, rgb8.byteOffset, block.w * block.h * 4), block.w, block.h), 0, 0);
  return canvas;
}

// ─── CPU grade application ─────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Brightness operator — quadratic midtone lift, `x + t * 4x(1-x)`.
 * KEEP IN SYNC WITH adjust.wgsl `adj_brightness` (the operator formula lives
 * only in the shader; this is the documented v1-contract mirror).
 */
function applyBrightness(x: number, t: number): number {
  return clamp01(x + t * 4 * x * (1 - x));
}

/**
 * Contrast operator — normalised tanh S-curve pivoted on 0.5 (c > 0 steepens
 * around mid grey, c < 0 compresses linearly toward it); |c| < 0.001 is the
 * shader's identity fast path.
 * KEEP IN SYNC WITH adjust.wgsl `adj_contrast`.
 */
function applyContrast(x: number, c: number): number {
  if (Math.abs(c) < 0.001) return x;
  if (c > 0) {
    const factor = 1 + c * 4;
    const normDenom = Math.tanh(factor * 0.5);
    return clamp01(0.5 + (0.5 * Math.tanh(factor * (x - 0.5))) / normDenom);
  }
  return clamp01(0.5 + (x - 0.5) * (1 + c));
}

/**
 * Color balance zone weights — HSL-lightness split (`L = (max+min)/2`),
 * `(1-L)^2 / 4L(1-L) / L^2` each scaled by 0.25, exactly as the shader.
 * KEEP IN SYNC WITH adjust.wgsl `adj_color_balance`.
 */
function balanceWeights(r: number, g: number, b: number): { ws: number; wm: number; wh: number } {
  const lRaw = (Math.max(r, g, b) + Math.min(r, g, b)) * 0.5;
  const l = clamp01(lRaw);
  const oneMinusL = 1 - l;
  return {
    ws: oneMinusL * oneMinusL * 0.25,
    wm: 4 * l * oneMinusL * 0.25,
    wh: l * l * 0.25,
  };
}

/**
 * Apply a strength-resolved preset grade to `target`, sampling pixels from
 * `base`. Both canvases are display-space sRGB. A neutral grade is a plain
 * blit. Stage order mirrors the engine's `apply_stage` exactly:
 * brightness/contrast (basic point-ops) -> levels -> curves -> colorBalance
 * -> fused colour matrix (saturation·hue·channelMix + constant).
 */
export function renderPresetThumb(
  base: HTMLCanvasElement,
  target: HTMLCanvasElement,
  state: PresetGradeState,
): void {
  const w = base.width;
  const h = base.height;
  target.width = w;
  target.height = h;
  const tctx = target.getContext('2d');
  if (!tctx) return;
  const bctx = base.getContext('2d');
  if (!bctx) return;
  const img = bctx.getImageData(0, 0, w, h);
  const d = img.data;

  const adj = state.adjustments;
  const hasBasicScalars = !!adj && (
    adj.brightness !== undefined || adj.contrast !== undefined
  );
  const hasMatrixArm = !!adj && (
    (adj.saturation !== undefined && adj.saturation !== 100) ||
    (adj.hueRotate !== undefined && adj.hueRotate !== 0)
  ) || !!state.channelMix;
  const hasLevels = !!state.levels;
  const hasCurves = !!state.curves;
  const hasBalance = !!state.colorBalance;

  if (!hasBasicScalars && !hasMatrixArm && !hasLevels && !hasCurves && !hasBalance) {
    tctx.putImageData(img, 0, 0);
    return;
  }

  // Shared LUT math — the exact tables the GPU samples for levels/curves.
  const levelsLut = hasLevels
    ? (generateLevelsLUT(
        {
          inputBlack: state.levels!.inputBlack ?? PRESET_IDENTITY.levels.inputBlack,
          inputWhite: state.levels!.inputWhite ?? PRESET_IDENTITY.levels.inputWhite,
          gamma: state.levels!.gamma ?? PRESET_IDENTITY.levels.gamma,
          outputBlack: state.levels!.outputBlack ?? PRESET_IDENTITY.levels.outputBlack,
          outputWhite: state.levels!.outputWhite ?? PRESET_IDENTITY.levels.outputWhite,
        },
        256,
        'f32',
      ) as Float32Array)
    : null;
  const [curveR, curveG, curveB] = hasCurves
    ? buildCurvesChannelTablesF32(state.curves, 256)
    : [null, null, null];

  // Basic scalars, normalised exactly like the GPU packer (percent clamped to
  // [0,200] then shifted to [-1,1]).
  const brightnessT = hasBasicScalars
    ? (Math.min(200, Math.max(0, adj?.brightness ?? 100)) - 100) / 100
    : 0;
  const contrastC = hasBasicScalars
    ? (Math.min(200, Math.max(0, adj?.contrast ?? 100)) - 100) / 100
    : 0;

  // Fused colour matrix — composed with the SAME pure matrices the GPU packer
  // uses (left-multiplied, saturation -> hueRotate -> channelMix) plus the
  // channelMix constant offset. `out = M * v + constant`.
  let matrix: Mat9 = ADJUST_IDENTITY_M9;
  let constant: [number, number, number] = [0, 0, 0];
  if (adj && adj.saturation !== undefined && adj.saturation !== 100) {
    matrix = mulAdjustMat3(adjustSaturationMatrix(adj.saturation), matrix);
  }
  if (adj && adj.hueRotate !== undefined && adj.hueRotate !== 0) {
    matrix = mulAdjustMat3(adjustHueMatrix(adj.hueRotate), matrix);
  }
  const mix = state.channelMix;
  if (mix) {
    const id = ADJUST_IDENTITY_M9;
    const r = mix.red ?? [id[0], id[1], id[2]];
    const g = mix.green ?? [id[3], id[4], id[5]];
    const b = mix.blue ?? [id[6], id[7], id[8]];
    // Row-major channelMix matrix: red row 0, green row 1, blue row 2. The
    // FULL matrix is left-multiplied in one shot (never row-by-row — the
    // shader's fused matrix reads all three outputs from the same input
    // vector, so sequential row application would diverge on dense rows).
    matrix = mulAdjustMat3([r[0], r[1], r[2], g[0], g[1], g[2], b[0], b[1], b[2]] as Mat9, matrix);
    if (mix.constant) constant = [mix.constant[0], mix.constant[1], mix.constant[2]];
  }
  const matrixIsIdentity =
    matrix === ADJUST_IDENTITY_M9 ||
    (matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 &&
      matrix[3] === 0 && matrix[4] === 1 && matrix[5] === 0 &&
      matrix[6] === 0 && matrix[7] === 0 && matrix[8] === 1 &&
      constant[0] === 0 && constant[1] === 0 && constant[2] === 0);

  const bal = state.colorBalance;
  // colorBalance offsets arrive as [-100,100] slider values; the shader's
  // CB_STRENGTH pre-scale is 1/100 — same normalisation here.
  const balS = [(bal?.shadows?.[0] ?? 0) / 100, (bal?.shadows?.[1] ?? 0) / 100, (bal?.shadows?.[2] ?? 0) / 100] as const;
  const balM = [(bal?.midtones?.[0] ?? 0) / 100, (bal?.midtones?.[1] ?? 0) / 100, (bal?.midtones?.[2] ?? 0) / 100] as const;
  const balH = [(bal?.highlights?.[0] ?? 0) / 100, (bal?.highlights?.[1] ?? 0) / 100, (bal?.highlights?.[2] ?? 0) / 100] as const;

  const sampleLut = (table: Float32Array, v: number): number =>
    table[Math.round(clamp01(v) * 255)];

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i] / 255;
    let g = d[i + 1] / 255;
    let b = d[i + 2] / 255;

    // Stage 1 — basic point-ops.
    if (hasBasicScalars) {
      r = applyBrightness(r, brightnessT);
      g = applyBrightness(g, brightnessT);
      b = applyBrightness(b, brightnessT);
      r = applyContrast(r, contrastC);
      g = applyContrast(g, contrastC);
      b = applyContrast(b, contrastC);
    }
    // Stage 2 — levels.
    if (levelsLut) {
      r = sampleLut(levelsLut, r);
      g = sampleLut(levelsLut, g);
      b = sampleLut(levelsLut, b);
    }
    // Stage 3 — curves.
    if (curveR) {
      r = sampleLut(curveR, r);
      g = sampleLut(curveG, g);
      b = sampleLut(curveB, b);
    }
    // Stage 4 — color balance.
    if (hasBalance) {
      const { ws, wm, wh } = balanceWeights(r, g, b);
      r += balS[0] * ws + balM[0] * wm + balH[0] * wh;
      g += balS[1] * ws + balM[1] * wm + balH[1] * wh;
      b += balS[2] * ws + balM[2] * wm + balH[2] * wh;
    }
    // Stage 5 — fused colour matrix + constant.
    if (!matrixIsIdentity) {
      const nr = matrix[0] * r + matrix[1] * g + matrix[2] * b + constant[0];
      const ng = matrix[3] * r + matrix[4] * g + matrix[5] * b + constant[1];
      const nb = matrix[6] * r + matrix[7] * g + matrix[8] * b + constant[2];
      r = nr;
      g = ng;
      b = nb;
    }

    d[i] = clamp01(r) * 255;
    d[i + 1] = clamp01(g) * 255;
    d[i + 2] = clamp01(b) * 255;
  }
  tctx.putImageData(img, 0, 0);
}

/**
 * Render a preset's full grade CHAIN onto one thumbnail: each stage is graded
 * sequentially (the output canvas of one stage feeds the next, mirroring the
 * renderer's stage order), then the final composite is blitted into `target`
 * at its size. An empty or all-disabled chain is a plain blit of `base`.
 */
export function renderPresetChainThumb(
  base: HTMLCanvasElement,
  target: HTMLCanvasElement,
  chain: ReadonlyArray<{ grade: PresetGradeState; enabled?: boolean }>,
): void {
  let src = base;
  for (const entry of chain) {
    if (entry.enabled === false) continue;
    const stage = document.createElement('canvas');
    renderPresetThumb(src, stage, entry.grade);
    src = stage;
  }
  renderPresetThumb(src, target, {});
}
