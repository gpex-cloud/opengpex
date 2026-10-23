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
 *   • The interactive composite density is a ZOOM-FREE CONSTANT
 *     (`compositeDensity` — `resolveCompositeDensity`: 1, or ceil(dpr) with
 *     the adaptive-rendering preference). Both channel decisions are priced
 *     AT that density so a channel never has to degrade it mid-zoom:
 *       ① physics:  max(docW, docH) × compositeDensity ≤ deviceMaxDim
 *          (negotiated `GPUDevice.limits.maxTextureDimension2D` — a single
 *          texture wider than this cannot exist);
 *       ② policy:   docW × docH × bpp × compositeDensity² × residentTargets
 *          ≤ budgetBytes.
 *     Both → 'full', otherwise 'roi'. A mode that flipped with camera zoom
 *     would flip the texture morphology mid-gesture; pricing at the constant
 *     density keeps `mode` a function of document dims + device + preference
 *     only.
 *   • Mode='full' renders at EXACTLY `compositeDensity` — no fractional
 *     clamp exists any more. A fractional density under nearest sampling
 *     (zoomed past the achieved density) draws document pixels with uneven
 *     n/n+1 device widths, misaligning them against the uniform pixel-grid
 *     overlay; integer pricing above makes that unreachable instead of
 *     patching it after the fact.
 *   • `resolveRoiDensity` keeps a MEMORY-insurance clamp the full channel
 *     does not need (the roi rect can be huge when zoomed out): the ROI
 *     density is `compositeDensity` when the visible rect's footprint at
 *     that density fits the byte budget, else exactly 1 — INTEGER outcomes
 *     only, so the texel lattice stays document-pixel-phased wherever the
 *     grid is visible. The physics term (deviceMaxDim / roi max edge) is NOT
 *     floored: a texture wider than the device limit cannot exist, and the
 *     only regime where it bites is zoomed far OUT on an over-limit
 *     document, where minified LINEAR sampling hides the sub-1 density.
 *   • Budget SOURCING: the module is the DECISION home, but the channel budget
 *     itself is device-derived — `deriveEngineWorkingSetBudget` (poolBudget.ts)
 *     turns the negotiated pool tier into the engine-owned resident budget
 *     (integrated 128 MiB / discrete 512 MiB), and the caller passes
 *     `residentTargets: RESIDENT_COMPOSITE_TARGETS` so the check prices BOTH
 *     document-sized residents (composite target + below cache). The
 *     roi-density budget deliberately stays on the fixed
 *     `COMPOSITE_BUDGET_DEFAULT_BYTES`: sharpness must never move when the
 *     channel gate does.
 *
 * @module core/engine/pipeline/graph/support/compositeBudget
 */

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
  /**
   * The fixed interactive composite density (see `resolveCompositeDensity`).
   * The channel decision is priced AT this density: `full` guarantees the
   * document renders at exactly this density with no fractional degradation.
   */
  compositeDensity: number;
  /** Negotiated `GPUDevice.limits.maxTextureDimension2D` — never hard-coded. */
  deviceMaxDim: number;
  /** Policy budget. Parameter, not a global: the decision stays a pure
   * function testable without a GPU device. The engine feeds the device-derived
   * engine working-set budget (poolBudget.ts); the roi-density clamp keeps the
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
  const density = Math.max(1, input.compositeDensity);
  const residentTargets = Math.max(1, input.residentTargets ?? 1);
  const fitsDevice = Math.max(w, h) * density <= Math.max(1, input.deviceMaxDim);
  const fitsBudget =
    w * h * Math.max(1, input.bpp) * density * density * residentTargets <=
    Math.max(1, input.budgetBytes);
  return { mode: fitsDevice && fitsBudget ? 'full' : 'roi' };
}

/**
 * Conservative composite-texture edge ceiling (px) used ONLY when the
 * negotiated `GPUDevice.limits.maxTextureDimension2D` is unavailable (bare
 * contexts, tests). Mirrors the historical hard clamp; real devices always
 * override it with their negotiated limit.
 */
export const FALLBACK_MAX_TEXTURE_DIMENSION = 4096;

/**
 * Resolve the ROI channel's composite density.
 *
 * The base value is the SAME zoom-free constant the full channel renders at
 * (`compositeDensity`), clamped by two ceiling terms of different authority:
 *   • POLICY (byte budget): the roi rect can span the whole document when
 *     zoomed out, and its footprint at the constant density may exceed the
 *     byte budget. In that case the density degrades — but only to the
 *     integer value 1, never to a fraction: under nearest sampling a
 *     fractional density draws document pixels with UNEVEN n/n+1 device
 *     widths against the uniform pixel-grid overlay. `compositeDensity`
 *     fits → render at it; it does not → render at 1. (Density 1 itself can
 *     still exceed the budget on huge zoomed-out views — accepted: the roi
 *     channel exists to make MAGNIFIED texels real document pixels, and at
 *     minification the budget overshoot is bounded by the document's own
 *     footprint.)
 *   • PHYSICS (deviceMaxDim / roi max edge): NOT floored. A texture wider
 *     than the negotiated `maxTextureDimension2D` cannot exist at all. Only
 *     visible extents larger than 1:1 feasibility can hit this — i.e. an
 *     over-limit document zoomed far out, where the pixel grid is not shown
 *     and the minified LINEAR sampling hides the sub-1 density.
 */
export function resolveRoiDensity(input: {
  compositeDensity: number;
  roiW: number;
  roiH: number;
  bpp: number;
  deviceMaxDim: number;
  budgetBytes: number;
}): InteractiveDensity {
  const density = Math.max(1, input.compositeDensity);
  const w = Math.max(1, input.roiW);
  const h = Math.max(1, input.roiH);
  const budgetTerm = Math.max(1, Math.max(1, input.budgetBytes) / (w * h * Math.max(1, input.bpp)));
  const deviceTerm = Math.max(1, input.deviceMaxDim) / Math.max(w, h);
  const raw = Math.min(density, budgetTerm, deviceTerm);
  // Integer outcomes wherever the grid can be visible: the full constant
  // density when every term allows it, else exactly 1. Only the physics
  // regime (raw < 1, minified linear sampling on over-limit documents) keeps
  // a fractional value.
  const scale = raw < 1 ? raw : raw >= density ? density : 1;
  return { scaleX: scale, scaleY: scale };
}
