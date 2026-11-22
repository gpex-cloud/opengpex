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

import React from 'react';

/**
 * RuleOfThirdsGrid: four static guide lines dividing the host box into a
 * 3×3 composition grid (the classic photographic rule of thirds).
 *
 * Mounting contract: the grid is a PURE child of an axis-defining box and
 * must live INSIDE whatever container carries the box's transform, so it
 * inherits the box's live geometry instead of tracking it independently:
 *  - rect selection → the TransformHud gizmo container via `gizmoExtras`
 *    (follows the selection's rotated frame at every angle);
 *  - Re-Canvas → a child of the flat canvas-resize box (always axis-aligned).
 *
 * The lines are `pointer-events-none` so they never intercept press routing
 * (gizmo hit zones and the `data-handle` move surface must stay the only
 * interactive surfaces inside the box).
 *
 * Visibility is the consumer's concern: this component renders whenever
 * mounted, and the consumer gates the mount itself. The gate is narrow by
 * design — a thirds grid only carries compositional meaning over a RECTANGLE:
 *   - clip mode with the rect tool (tool-coerced clipType 'rect');
 *   - Re-Canvas (clipTool reads as 'rect' there too);
 * and never for ellipse/lasso/wand/SAM selections or boolean combinations,
 * where a rectangular lattice has no geometric meaning.
 */
export function RuleOfThirdsGrid(): React.JSX.Element {
  return (
    <div
      data-thirds-grid="true"
      className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden"
    >
      <div className="absolute top-1/3 left-0 w-full h-px bg-white" />
      <div className="absolute top-2/3 left-0 w-full h-px bg-white" />
      <div className="absolute left-1/3 top-0 h-full w-px bg-white" />
      <div className="absolute left-2/3 top-0 h-full w-px bg-white" />
    </div>
  );
}
