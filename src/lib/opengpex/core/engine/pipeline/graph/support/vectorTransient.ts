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
 * vectorTransient.ts — Pure sizing for a vector-source offscreen transient
 * (vector spine, export fidelity).
 *
 * Split out of `RenderGraph` so the density arithmetic — the part that decides how
 * many physical texels a vector source is rendered into — is a plain function
 * testable without a GPU device. Shape-agnostic: it serves every `VectorRenderer`
 * strategy (SDF today, stroke later), not any one business model.
 *
 * WHY EXPORT SUPERSAMPLES A PLAIN SOURCE BUT NOT A FILTERED ONE:
 *   • A PLAIN vector source is resolution-independent. On a 2×/4× export the composite
 *     target is `exportScale` larger, so the transient is allocated at `exportScale`
 *     density too; an SDF's `fwidth` then resolves analytic AA at the OUTPUT density
 *     and the edges stay razor-sharp instead of upscaling a logical-density bitmap.
 *   • A FILTERED source keeps COMPOSITE (logical) density: the gaussian radius is a
 *     logical-pixel quantity, so convolving at logical density and letting the result
 *     upscale on export keeps the blur the intended size — the exact behaviour a
 *     filtered raster layer already has. Supersampling first would shrink the blur.
 * `RenderGraph` passes `scale = [1, 1]` for the filtered case; the maths here is the
 * same either way.
 *
 * @module core/gpu/graph/support/vectorTransient
 */

/** Minimal shape of an export viewport this module reads (a subset of `ExportViewport`). */
export interface VectorExportViewport {
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly sourceRect?: readonly [number, number, number, number];
}

/**
 * Physical-texel-per-world-pixel scale a vector source is rasterised at in the final
 * composite, per axis. Mirrors `packLayerUniforms`'s NDC mapping: a world span maps
 * to `targetSize / sourceSize` physical pixels. No viewport (interactive compositing)
 * ⇒ `[1, 1]`.
 */
export function vectorExportScale(
  ev: VectorExportViewport | undefined,
  frameWidth: number,
  frameHeight: number,
): readonly [number, number] {
  if (!ev) return [1, 1];
  const srcW = ev.sourceRect ? ev.sourceRect[2] : frameWidth;
  const srcH = ev.sourceRect ? ev.sourceRect[3] : frameHeight;
  return [ev.targetWidth / Math.max(1, srcW), ev.targetHeight / Math.max(1, srcH)];
}

/**
 * Physical dimensions (≥ 1, integer) for a vector transient: `ceil(logical × scale)`
 * per axis. `scale = [1, 1]` reproduces the composite-density allocation exactly, so
 * the interactive path is unchanged.
 */
export function vectorTransientSize(
  logicalWidth: number,
  logicalHeight: number,
  scale: readonly [number, number],
): readonly [number, number] {
  const w = Math.max(1, Math.ceil(Math.max(1, logicalWidth) * Math.max(scale[0], 0)));
  const h = Math.max(1, Math.ceil(Math.max(1, logicalHeight) * Math.max(scale[1], 0)));
  return [Math.max(1, w), Math.max(1, h)];
}
