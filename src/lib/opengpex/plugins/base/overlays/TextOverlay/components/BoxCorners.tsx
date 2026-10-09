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

"use client";

import React from "react";

/**
 * Corner bracket sizing (industry crop-bracket HUD practice):
 * - Fixed screen-space sizing (13px arms) using counter-scale (--box-corner-scale).
 * - Symmetrical right angles that never stretch or distort horizontally/vertically.
 * - Black & White Dual Stroke with solid thickness (black underlay 4px + white core 2px)
 *   providing pristine 100% contrast against any background with robust visual weight.
 * - Screen-invariant: Counter-scaled against parent matrix zoom, keeping physical screen size
 *   and stroke width constant regardless of canvas camera zoom (matching TransformGizmo).
 */
const CORNER_ARM_PX = 10;

export interface BoxCornersProps {
  /** Box width in canvas pixels (backwards-compat) */
  boxWidth?: number;
  /** Box height in canvas pixels (backwards-compat) */
  boxHeight?: number;
  /** Arm length in physical screen pixels (default: 10) */
  armLengthPx?: number;
  /** Core white stroke width in physical screen pixels (default: 2) */
  strokeWidth?: number;
  /** Horizontal outset padding between corner brackets and text box in physical screen pixels (default: 14) */
  offsetX?: number;
  /** Vertical outset padding between corner brackets and text box in physical screen pixels (default: 8) */
  offsetY?: number;
  /** Outset padding fallback in physical screen pixels (backwards-compat) */
  offsetPx?: number;
  /** Backwards compatibility props (ignored) */
  ratio?: number;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  scale?: number;
}

export const BoxCorners = React.memo(function BoxCorners({
  armLengthPx = CORNER_ARM_PX,
  strokeWidth = 2,
  offsetX,
  offsetY,
  offsetPx,
}: BoxCornersProps) {
  const arm = armLengthPx;
  const offX = offsetX ?? offsetPx ?? 8;
  const offY = offsetY ?? offsetPx ?? 8;

  const renderCorner = (
    points: string,
    positionStyle: React.CSSProperties,
    transformOrigin: string,
  ) => (
    <div
      style={{
        position: "absolute",
        width: `${arm}px`,
        height: `${arm}px`,
        pointerEvents: "none",
        overflow: "visible",
        transform:
          "scale(calc(var(--box-corner-scale, 1) * var(--box-corner-arm-ratio, 1)))",
        transformOrigin,
        ...positionStyle,
      }}
    >
      <svg
        width={arm}
        height={arm}
        viewBox={`0 0 ${arm} ${arm}`}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          overflow: "visible",
        }}
      >
        {/* High-contrast solid black underlay (outer casing) */}
        <polyline
          points={points}
          fill="none"
          stroke="#000000"
          strokeWidth={strokeWidth + 2}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
        {/* Crisp white core (inner highlight) */}
        <polyline
          points={points}
          fill="none"
          stroke="#ffffff"
          strokeWidth={strokeWidth}
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
    </div>
  );

  return (
    <div
      className="absolute pointer-events-none"
      data-box-corners
      style={{
        top: `calc(-1 * var(--box-corner-scale, 1) * ${offY}px)`,
        bottom: `calc(-1 * var(--box-corner-scale, 1) * ${offY}px)`,
        left: `calc(-1 * var(--box-corner-scale, 1) * ${offX}px)`,
        right: `calc(-1 * var(--box-corner-scale, 1) * ${offX}px)`,
      }}
    >
      {/* Top-Left Corner */}
      {renderCorner(`0,${arm} 0,0 ${arm},0`, { top: 0, left: 0 }, "0 0")}

      {/* Top-Right Corner */}
      {renderCorner(
        `0,0 ${arm},0 ${arm},${arm}`,
        { top: 0, right: 0 },
        "100% 0",
      )}

      {/* Bottom-Left Corner */}
      {renderCorner(
        `0,0 0,${arm} ${arm},${arm}`,
        { bottom: 0, left: 0 },
        "0 100%",
      )}

      {/* Bottom-Right Corner */}
      {renderCorner(
        `0,${arm} ${arm},${arm} ${arm},0`,
        { bottom: 0, right: 0 },
        "100% 100%",
      )}
    </div>
  );
});
