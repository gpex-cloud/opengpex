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
 * compositeBudget.ts — Pure policy for the full/roi dual-channel composite.
 *
 * Split out of `WebGpuEngine` so the channel decision — the part that decides
 * whether a document can hold a full-document 1:1 composite texture — is a
 * plain function testable without a GPU device, and so the byte-budget policy
 * (which replaces the old hard-coded single-edge 4096 clamp) has exactly one
 * home.
 *
 * ── MODEL ──
 *   • `mode` is decided ONLY by 1:1 feasibility of the full-document channel
 *     and is independent of zoom/band quantization: a mode that flipped with
 *     camera zoom would flip the texture morphology mid-gesture. It changes
 *     only when its inputs change: frame resize (doc dims) or device
 *     (capabilities).
 *       ① physics:  max(docW, docH) ≤ deviceMaxDim  (negotiated
 *          `GPUDevice.limits.maxTextureDimension2D` — a single texture wider
 *          than this cannot exist);
 *       ② policy:   docW × docH × bpp ≤ budgetBytes (the density-1 composite
 *          footprint; 128 MiB ≈ 4096² rgba16float, the old ceiling).
 *     Both → 'full', otherwise 'roi'.
 *   • The FULL channel's per-frame density keeps the existing band-quantized
 *     `resolveInteractiveDensity` semantics; its edge ceiling becomes
 *     `min(deviceMaxDim, budgetDerivedCeilPx(...))`. NOTE this byte-budget
 *     clamp is by AREA and is deliberately NOT mathematically equivalent to
 *     the old per-edge 4096 clamp (non-square documents clamped looser under
 *     the old rule): e.g. 4284×5712@16f degrades 0.717 → ~0.686. Slightly
 *     stricter on wide aspect ratios is intended — it buys a VRAM upper bound
 *     that is aspect-ratio-uniform and lets 8192-capable devices and future
 *     rgba8 composites benefit automatically.
 *   • Mode='full' guarantees density ≥ 1: the budget term ≥ 1 by definition of
 *     'full' and the physics term ≥ 1 by ①, so the mosaic failure mode
 *     (density < 1 → present shows composite texels instead of document
 *     pixels) can never occur on the full channel. Documents that fail ①/②
 *     belong to the roi channel.
 *   • Budget SOURCING: the module is the DECISION home, but the channel budget
 *     itself is device-derived — `deriveEngineWorkingSetBudget` (poolBudget.ts)
 *     turns the negotiated pool tier into the engine-owned resident budget
 *     (integrated 128 MiB / discrete 512 MiB), and the caller passes
 *     `residentTargets: RESIDENT_COMPOSITE_TARGETS` so the check prices BOTH
 *     document-sized residents (composite target + below cache). The
 *     density-clamp and roi-density budgets deliberately stay on the fixed
 *     `COMPOSITE_BUDGET_DEFAULT_BYTES`: sharpness must never move when the
 *     channel gate does.
 *
 * @module core/engine/pipeline/graph/support/compositeBudget
 */

import { quantizeDensityBand } from '@opengpex/editor/core/engine/text/glyphAtlas';
import type { InteractiveDensity } from './densityComposite';

/**
 * Full-document composite budget (bytes): the density-1 footprint a document
 * may have before the roi channel takes over. 128 MiB = the exact footprint
 * of a 4096² rgba16float texture — the old INTERACTIVE_COMPOSITE_CEIL_PX
 * hard clamp expressed as the VRAM constraint it always stood for.
 *
 * The SINGLE policy knob for the channel decision. Raising it is a release
 * action (edit this constant, update the changelog) — there is deliberately
 * no runtime/user-facing tier: a budget that only moves with a shipped
 * binary is one the product actually tested.
 */
export const COMPOSITE_BUDGET_DEFAULT_BYTES = 128 * 1024 * 1024;

/** Composite channel morphology for the current frame. */
export interface CompositePlan {
  /**
   * 'full' — whole document composited into one resident texture (existing
   * architecture). 'roi' — only the visible viewport region.
   */
  mode: 'full' | 'roi';
}

/** Bytes per texel of the working composite format. */
export function workingFormatBpp(workingFormat: 'rgba16float' | 'rgba32float'): number {
  return workingFormat === 'rgba32float' ? 16 : 8;
}

/**
 * Decide the composite channel for a document. Pure and zoom-free — see the
 * module header for the ①/② model. Inputs are clamped defensively so a
 * degenerate document (0 dim) or unset limits (0) can never silently pass.
 */
export function resolveCompositePlan(input: {
  docW: number;
  docH: number;
  bpp: number;
  /** Negotiated `GPUDevice.limits.maxTextureDimension2D` — never hard-coded. */
  deviceMaxDim: number;
  /** Policy budget. Parameter, not a global: the decision stays a pure
   * function testable without a GPU device. The engine feeds the device-derived
   * engine working-set budget (poolBudget.ts); the density clamps keep the
   * fixed COMPOSITE_BUDGET_DEFAULT_BYTES. */
  budgetBytes: number;
  /**
   * How many document-sized textures the full channel holds resident (default
   * 1): the live-edit fast path adds a below-layers cache, so the engine
   * passes 2 and the budget prices the pair. Defaults to 1 when omitted so
   * bare calls keep the single-texture semantics.
   */
  residentTargets?: number;
}): CompositePlan {
  const w = Math.max(1, input.docW);
  const h = Math.max(1, input.docH);
  const residentTargets = Math.max(1, input.residentTargets ?? 1);
  const fitsDevice = Math.max(w, h) <= Math.max(1, input.deviceMaxDim);
  const fitsBudget =
    w * h * Math.max(1, input.bpp) * residentTargets <= Math.max(1, input.budgetBytes);
  return { mode: fitsDevice && fitsBudget ? 'full' : 'roi' };
}

/**
 * The budget-derived single-edge ceiling for the FULL channel's
 * `resolveInteractiveDensity` call: the edge length `E` for which an
 * aspect-preserving clamp at `E / maxDocDim` consumes exactly the byte budget
 * at density 1 — `budgetBytes × maxDocDim / (docW × docH × bpp)`.
 *
 * Fed as the `maxTextureDimension2D` argument (prefolded with the negotiated
 * device limit via `min(deviceMaxDim, this)`), it adds the area-budget term to
 * the existing `min(band, ceil / maxDocDim)` density clamp without touching
 * that function's contract (it keeps its own 4096 edge ceiling).
 */
export function budgetDerivedCeilPx(
  docW: number,
  docH: number,
  bpp: number,
  budgetBytes: number,
): number {
  const w = Math.max(1, docW);
  const h = Math.max(1, docH);
  const areaBytes = w * h * Math.max(1, bpp);
  return (Math.max(1, budgetBytes) * Math.max(w, h)) / areaBytes;
}

/**
 * Resolve the ROI channel's composite density.
 *
 * Same band quantization as the full channel (`quantizeDensityBand` on the
 * camera's screen scale — the ONLY camera-derived term), clamped by two
 * ceiling terms of different authority:
 *   • POLICY (byte budget): may degrade the density, but is FLOORED AT 1 —
 *     the roi channel exists to keep every magnified texel a real document
 *     pixel (overflow guard: the budget must never reintroduce the
 *     mosaic the channel was built to kill).
 *   • PHYSICS (deviceMaxDim / roi max edge): NOT floored. A texture wider
 *     than the negotiated `maxTextureDimension2D` cannot exist at all. Only
 *     documents whose long edge exceeds the device limit can hit this, and
 *     only while the VISIBLE extent itself exceeds 1:1 feasibility — i.e.
 *     zoomed far out, where the pixel grid is not shown and the minified
 *     LINEAR sampling hides the degradation. The deep-zoom correctness root
 *     (density ≥ 1 wherever magnification exposes texel edges) is untouched.
 *
 * ── INTEGER LATTICE (texel-phase contract) ──
 *   A fractional density is only presentable while the composite is SAMPLED
 *   AT MINIFICATION (`density ≥ screenScale`): the texel lattice is then
 *   finer than the screen pixel grid and linear filtering hides its phase
 *   against the document pixel grid. Once the camera magnifies beyond the
 *   achieved density, the sampler switches to nearest and a fractional
 *   density draws document pixels with UNEVEN device widths (alternating
 *   n/n+1 px) — the pixel grid overlay is uniform, so the image reads as
 *   misaligned. In that magnified regime the density is therefore floored to
 *   the integer lattice, where texel boundaries coincide with document pixel
 *   boundaries exactly. This matters because the roi rect can be FROZEN by
 *   containment reuse at a rect derived at a lower zoom: its budget/device
 *   clamp terms (continuous in the rect area) then hold the density at a
 *   fractional value precisely in the deep-zoom range where the grid is
 *   visible. Below 1 the density stays fractional — that regime only occurs
 *   on over-limit documents at minified linear zooms, where no integer
 *   lattice exists to snap to.
 */
export function resolveRoiDensity(input: {
  screenScale: number;
  roiW: number;
  roiH: number;
  bpp: number;
  deviceMaxDim: number;
  budgetBytes: number;
}): InteractiveDensity {
  const band = quantizeDensityBand(input.screenScale);
  const w = Math.max(1, input.roiW);
  const h = Math.max(1, input.roiH);
  const budgetTerm = Math.max(1, Math.max(1, input.budgetBytes) / (w * h * Math.max(1, input.bpp)));
  const deviceTerm = Math.max(1, input.deviceMaxDim) / Math.max(w, h);
  const raw = Math.min(band, budgetTerm, deviceTerm);
  const scale =
    raw >= input.screenScale || raw < 1 ? raw : Math.max(1, Math.floor(raw));
  return { band, scaleX: scale, scaleY: scale };
}
