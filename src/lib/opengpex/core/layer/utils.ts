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

import { Layer } from '@opengpex/editor/core/types';

/**
 * LayerUtils: High-frequency pure function toolset for layer operations
 * Provides general layer calculation methods independent of business logic and state management.
 */
export const LayerUtils = {
  /**
   * getCompositeKey: Generates fast-track composite key (frameId:layerId)
   * Used to achieve artboard-level isolation in the flat fast-track cache.
   */
  getCompositeKey(frameId: string, layerId: string): string {
    return `${frameId}:${layerId}`;
  },

  /**
   * mergeLayerDraft: Merges a layer with its fast-track draft
   * Used for high-performance data merging prior to rendering.
   */
  mergeLayerDraft(layer: Layer, draft?: Partial<Layer>): Layer {
    if (!draft) return layer;
    return { ...layer, ...draft };
  },

  /**
   * getMaskOrigin: Single source of truth for the layer-local origin that an
   * eraser/restore BitmapMask canvas is anchored to.
   *
   * ── Why this exists ──────────────────────────────────────────────────────────
   * A layer's content is NOT drawn at bounding-local (0,0). `painter2d`
   * (`drawLayerContent`) blits the source pixels via
   *   drawImage(src, v.x, v.y, v.w, v.h,  v.x, v.y, v.w, v.h)
   * so the content always occupies the bounding-local rect
   * `(vx, vy, vw, vh)` — where `(vx, vy) = visibleShape.rect.x/y`.
   *
   * For a zero-copy logical fragment (lasso / rect Cmd+J), `bounding` equals the
   * selection size while `visibleShape.rect.x/y` points at the selection's
   * position inside the SHARED source bitmap. With `vx >= bounding.w` the
   * bounding-local rects `(0,0,bw,bh)` and `(vx,vy,vw,vh)` are entirely
   * DISJOINT. A mask built on the (0,0) basis therefore has zero overlap with
   * the content, and `destination-in` erases the whole fragment.
   *
   * ── Contract ─────────────────────────────────────────────────────────────────
   * Mask canvas pixel `(px, py)` maps to layer-local `(origin.x + px, origin.y + py)`.
   * Both producers and consumers of a bitmap mask must use this same basis:
   *   - stamp placement            → subtract the origin (BrushOverlay stamp path)
   *   - `BitmapMask.bounds.x/y`    → equals the origin (bake + live-preview override)
   *
   * Since `BitmapMask.bounds` is consumed verbatim by both the main-thread
   * (`Canvas2dEngine`) and the Worker (`Canvas2dBackend`) composite branches,
   * encoding the origin into `bounds` keeps screen rendering and export aligned
   * without any extra offset at composite time (no double-subtraction).
   *
   * ── Zero regression ──────────────────────────────────────────────────────────
   * A regular full-layer image has `visibleShape.rect.x/y === 0` (i.e.
   * `isFragment === false`), so this returns `(0, 0)` and every call site
   * degenerates to the previous behaviour bit-for-bit.
   */
  getMaskOrigin(layer: Pick<Layer, 'visibleShape'>): { x: number; y: number } {
    const rect = layer.visibleShape?.rect;
    if (!rect) return { x: 0, y: 0 };
    return { x: rect.x || 0, y: rect.y || 0 };
  }
};
