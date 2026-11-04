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

import { Point2D, LocalPolygon } from '@opengpex/editor/core/types';
import { isPointInPolygon, isPointInShape, polygonToShape } from '@opengpex/editor/core/geometry/public';

/**
 * Selection-interior hit test — the SINGLE geometric source of truth for
 * "is this canvas point inside the existing selection's interior".
 *
 * Classification reuses the same serializer the render/clip pipeline uses
 * (`polygonToShape`), so a selection is hit-tested exactly as it is drawn:
 *
 *   - `rect`   → axis-aligned box membership (boundary inclusive, matching
 *     how a DOM border-box accepts presses on its edges);
 *   - `circle` → TRUE ellipse membership via the normalized implicit equation
 *     ((x-cx)/a)² + ((y-cy)/b)² ≤ 1. This MUST stay an ellipse test: the
 *     rendered move surface carries `border-radius: 50%`, which clips its DOM
 *     hit region to the same ellipse, and an axis-aligned bbox test would
 *     steal presses in the four corners that the DOM correctly yields to the
 *     creation handlers below. There is deliberately no bbox fallback.
 *   - `path`   → even-odd ring membership (`isPointInPolygon`), unchanged
 *     from the historical lasso/wand behavior.
 *
 * Anti-aliasing is intentionally NOT consulted: `antiAliased` (and feathering)
 * govern only how the boundary is RENDERED, never which points count as
 * inside — a pixel-edge gesture at ±0.5px of the boundary therefore resolves
 * identically for AA-on and AA-off selections.
 *
 * Pure and DOM-free so the same predicate can serve both the gesture handler
 * (`move.ts` test) and future mode-independent hover consumers (e.g. a
 * workspace-level peel cursor hook).
 */
export const hitTestSelectionInterior = (point: Point2D, box: LocalPolygon): boolean => {
  const shape = polygonToShape(box);

  // Regular shapes delegate to the L0 shape-membership operators (true
  // ellipse via the normalized implicit equation, rect boundary-inclusive
  // — the same predicates the geometry service exposes as space.*). The
  // degenerate guard below stays HERE on purpose: a zero-extent shape has
  // no interior (a zero-size DOM surface can never be pressed), while the
  // boundary-inclusive L0 rect test would still admit its single corner.
  if (shape.type === 'circle' || shape.type === 'rect') {
    if (box.rect.w <= 0 || box.rect.h <= 0) return false;
    return isPointInShape(point, shape);
  }

  // Irregular polygon: multi-ring even-odd test (outer ring + holes).
  return isPointInPolygon(point, box.rings);
};
