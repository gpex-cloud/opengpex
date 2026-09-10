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
 * geometry.ts — Pixel-grid visibility criterion (§8, step 9).
 *
 * ## Why "screen physical pixels per source pixel", not `camera.k`?
 *
 * The legacy criterion was `camera.k >= zoomThreshold` (8 == 800%). But
 * `camera.k` is the zoom *relative to the document (canvas) coordinate system*
 * — "one document pixel → how many viewport CSS logical pixels". It is NOT
 * "how many physical screen pixels one source pixel occupies". Because images
 * are usually loaded fit-to-window, a large image starts at a small `k` while a
 * small image starts at a large `k`; and DPR is not accounted for at all. So a
 * fixed `camera.k` threshold makes the grid appear at a *different apparent
 * pixel size* depending on image dimensions / fit / DPR — exactly the reported
 * defect (1000×1000 vs 3000×3000 grids appearing at different visual sizes).
 *
 * ## The GIMP criterion
 *
 * GIMP (`gimpcanvasgrid.c`) shows the grid when the on-screen *spacing* is at
 * least a couple of physical pixels (`spacing * scale >= 2.0`) — i.e. it only
 * cares about the on-screen visual size, independent of image size / fit / DPR.
 *
 * ## What "source pixel → screen physical pixel" is in overlay space
 *
 * The overlay draws a *document*-pixel grid (one line per canvas pixel; for a
 * single-image import `canvas == source`, so document px == source px). In the
 * CPU geometry world the full "document pixel → screen physical pixel" chain is:
 *
 *     p = camera.k        // document px → viewport CSS logical px
 *         × devicePixelRatio  // CSS logical px → physical px
 *
 * which is exactly the `gridSpacing = scale * dpr` the overlay already uses to
 * space its lines. So the criterion and the rendered spacing share one scale.
 *
 * NOTE: the GPU-side `effectiveScale(layer.transform)` is NOT reused here. After
 * the defect-5 fix (step 8) `layer.transform` is pure document space (camera
 * un-baked), so it no longer represents "source → screen". The overlay is a DOM
 * layer that never touches the GPU Scene anyway; `camera.k × dpr` is the correct
 * self-contained equivalent of the whole chain in geometry space.
 */

/**
 * On-screen physical size (in device pixels) of a single source/document pixel.
 *
 * @param cameraK  Camera zoom (`camera.k`): document px → viewport CSS logical px.
 * @param dpr      Device pixel ratio: CSS logical px → physical px.
 */
export function pixelScreenSize(cameraK: number, dpr: number): number {
  return cameraK * dpr;
}

/**
 * Whether the pixel grid should be shown: true iff one source/document pixel
 * covers at least `minPixelSize` physical screen pixels. Independent of image
 * dimensions / fit / DPR — only the on-screen visual size decides.
 */
export function shouldShowPixelGrid(
  cameraK: number,
  dpr: number,
  minPixelSize: number,
): boolean {
  return pixelScreenSize(cameraK, dpr) >= minPixelSize;
}
