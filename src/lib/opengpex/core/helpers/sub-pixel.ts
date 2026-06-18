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

import { LocalRect, Shape } from '@opengpex/editor/core/types';

/**
 * shrinkInvertedMask: Physical anti-aliasing seam prevention mask shrinker (Subpixel Mask Seam Prevention)
 * Specially used at the physical rendering level to automatically shrink "inverted masks" (e.g. holes, peeled cutouts with inverted = true) inward by 0.5px.
 * - For rectangles (rect): shrink the bounding box inward by 0.5px (increase x and y by 0.5, decrease width and height by 1px).
 * - For circles (circle): similarly shrink their bounding rectangle, mathematically equivalent to shrinking the circle radius inward by 0.5px!
 * By establishing a perfect physical pixel overlap zone, completely prevent browser GPUs from anti-aliasing translucent leaks when rasterizing subpixel boundaries.
 * Shared pure function supporting geometric operations under both the main thread and the WebWorker background compositing thread.
 */
export function shrinkInvertedMask<T extends Shape>(shape: T, inverted: boolean): T {
  // If in hard-edge (non-anti-aliasing) mode, absolutely immune to any subpixel level position offsets!
  // Otherwise it will break the integer pixel alignment of hard edges, causing anti-aliasing to reappear.
  if (shape.antiAliased === false) {
    return shape;
  }

  if (inverted && (shape.type === 'rect' || shape.type === 'circle')) {
    return {
      ...shape,
      rect: {
        ...shape.rect,
        x: shape.rect.x + 0.5,
        y: shape.rect.y + 0.5,
        w: Math.max(0.1, shape.rect.w - 1),
        h: Math.max(0.1, shape.rect.h - 1)
      } as typeof shape.rect
    };
  }
  return shape;
}

/**
 * snapCropBoxToPixels: Selection crop box pixel-level grid alignment snapper (Pixel Gridding Snapper)
 * Employs a "coordinate pair dual-end rounding" algorithm, perfectly preventing size drift and physical stretch errors of aspect ratios caused by independent rounding.
 * Exported as a shared pure function, supporting geometric grid alignment under both the main thread and WebWorker environments.
 */
export function snapCropBoxToPixels<T extends { rect: LocalRect }>(cropBox: T): T {
  const { rect } = cropBox;
  if (!rect) return cropBox;

  const x1 = Math.round(rect.x);
  const y1 = Math.round(rect.y);
  const x2 = Math.round(rect.x + rect.w);
  const y2 = Math.round(rect.y + rect.h);

  return {
    ...cropBox,
    rect: {
      ...rect,
      x: x1,
      y: y1,
      w: Math.max(1, x2 - x1),
      h: Math.max(1, y2 - y1),
    },
  };
}
