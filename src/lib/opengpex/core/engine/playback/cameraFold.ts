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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * cameraFold — pure CPU matrix math folding the playback frame into the
 * swapchain. Mirrors the scene pipeline's presentation math (unit quad →
 * document → camera → NDC, see ViewPass.composeViewMatrix) WITHOUT importing
 * it: the playback pipeline's decoupling contract forbids scene-path imports,
 * so the same convention is re-derived here and locked by unit test.
 *
 * Convention (identical to `Mat3` in Scene.ts / ViewMatrix in ViewPass):
 * column-vector affine, p' = M·p, with the 6 meaningful components
 * {a, b, c, d, tx, ty}: p'.x = a·px + c·py + tx, p'.y = b·px + d·py + ty.
 */

export interface Affine2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/** outer ∘ inner — apply `inner` first, then `outer`. */
export function composeAffine(outer: Affine2D, inner: Affine2D): Affine2D {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

/**
 * Compose the full playback view matrix: the frame's unit quad (0..1, image
 * extent) through the layer's LOCAL matrix (image → document, carrying the
 * layer placement/rotation/flip), then the camera (document → swapchain
 * physical pixels), then the swapchain's NDC map (Y flipped, uv.y=0 is top).
 *
 *   view = N(physical→NDC) ∘ M_camera ∘ M_layer ∘ S(imgW, imgH)
 *
 * This is the playback twin of ViewPass.composeViewMatrix with the layer
 * matrix inserted between the camera and the image scale — the two must stay
 * pixel-consistent for the overlay to sit exactly on the stage's static
 * composite.
 */
export function composeFrameView(
  camera: Affine2D,
  layer: Affine2D,
  imgW: number,
  imgH: number,
  targetW: number,
  targetH: number,
): Affine2D {
  const w = Math.max(1, imgW);
  const h = Math.max(1, imgH);
  const tW = Math.max(1, targetW);
  const tH = Math.max(1, targetH);

  // M1 = camera ∘ layer ∘ S(w, h): unit quad → physical pixels.
  const m1 = composeAffine(composeAffine(camera, layer), { a: w, b: 0, c: 0, d: h, tx: 0, ty: 0 });

  // N: physical → NDC (Y flip). Na = 2/tW, Nd = -2/tH, Ntx = -1, Nty = 1.
  const na = 2 / tW;
  const nd = -2 / tH;

  return {
    a: na * m1.a,
    b: nd * m1.b,
    c: na * m1.c,
    d: nd * m1.d,
    tx: na * m1.tx - 1,
    ty: nd * m1.ty + 1,
  };
}
