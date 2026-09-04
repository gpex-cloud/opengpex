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

import React, { useRef } from "react";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { presets } from "@opengpex/editor/core/helpers/preferences";
import { GeometryService, Frame } from "@opengpex/editor/core/types";

const BACKDROP_GRID_CONFIG = presets.get('BACKDROP_GRID_CONFIG');

interface CanvasBackdropProps {
  rotation: number;
  canvas: { w: number; h: number };
  geometry: GeometryService;
  frame: Frame | null;
  showChess?: boolean;
}

import { useFastSync } from "@opengpex/editor/core/state/volatile";
import { useOverlayRotationSync } from "@opengpex/editor/core/context";
import { snapCanvasRect } from "@opengpex/editor/core/geometry/operators/snapping";

/**
 * CanvasBackdrop: SVG checkerboard backdrop with physical rotation capability and constant visual size
 *
 * [Extreme Performance Architecture: Viewport Clamping + Polygon Mapping]
 * Previous architecture put checkerboard inside scaled container. At 1600% zoom, a normal backdrop would be forced to scale
 * beyond 40000 pixels, instantly breaking GPU texture limits (usually 8192px), causing severe lag.
 * Also, old architecture constantly modified pattern width/height in 60FPS loop to maintain constant visual size, triggering severe Layout Thrashing.
 *
 * The new architecture completely overrides this:
 * 1. [Out of Scaling Box]: This SVG fills the screen, locked on screen (always physical size around 1920x1080), never overloading the card.
 * 2. [Static Base Texture]: The `<pattern>` inside is strictly fixed 32x32px, never recomputed regardless of zoom.
 * 3. [Reverse Four-Corner Mapping]: We calculate absolute positions of original canvas four corners on screen in 60FPS fast track, then clip this fixed texture with a `<polygon>`.

 */
export default function CanvasBackdrop({
  frame,
  showChess = true,
}: CanvasBackdropProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const polygonBgRef = useRef<SVGPolygonElement>(null);
  const polygonChessRef = useRef<SVGPolygonElement>(null);

  // [Counter-Animation Protocol]: enables physical rotation transition alongside Viewport main stage
  useOverlayRotationSync(containerRef, frame);

  // [Performance Fast-Track]: bypasses React, directly mapping World coordinates to Screen coordinates via pure math
  useFastSync(svgRef, true, (_v, f, cam) => {
    if (!polygonBgRef.current || !polygonChessRef.current) return;

    // [Pixel-Snap] Use the same snap logic as StageComposer's artboardClip.
    // This ensures the SVG polygon boundary aligns exactly with the Canvas 2D
    // clip boundary at physical pixel granularity, eliminating:
    //   - Ghost vertical lines during pan (anti-aliased SVG edge residue)
    //   - 1px checkerboard bleed at canvas edges during zoom
    // See: docs/opengpex/plans/20260815_canvas_edge_subpixel_artifact_fix.md
    const dpr = window.devicePixelRatio || 1;
    const snap = snapCanvasRect(cam, f.canvas, dpr);
    const { x: x1, y: y1, w, h } = snap.css;
    const x2 = x1 + w;
    const y2 = y1 + h;

    const points = `${x1},${y1} ${x2},${y1} ${x2},${y2} ${x1},${y2}`;

    polygonBgRef.current.setAttribute("points", points);
    polygonChessRef.current.setAttribute("points", points);

    // [Visual Correction]: If pattern doesn't pan with camera, dragging canvas behaves like "scratch-off" (static wallpaper).
    // Apply patternTransform to bind checkerboard texture tightly to physical canvas motion!
    const pattern = svgRef.current?.querySelector("#checkerboard");
    if (pattern) {
      pattern.setAttribute(
        "patternTransform",
        `translate(${x1 % BACKDROP_GRID_CONFIG.PATTERN_SIZE}, ${y1 % BACKDROP_GRID_CONFIG.PATTERN_SIZE})`,
      );
    }
  });

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: EDITOR_Z_INDEX.STAGE.BACKDROP }}
    >
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        <defs>
          {/* Fixed pattern in screen space, never scales with zoom! */}
          <pattern
            id="checkerboard"
            patternUnits="userSpaceOnUse"
            width={BACKDROP_GRID_CONFIG.PATTERN_SIZE}
            height={BACKDROP_GRID_CONFIG.PATTERN_SIZE}
          >
            <rect
              width={BACKDROP_GRID_CONFIG.GRID_SIZE}
              height={BACKDROP_GRID_CONFIG.GRID_SIZE}
              fill="var(--canvas-checker, #dadce0)"
            />
            <rect
              x={BACKDROP_GRID_CONFIG.GRID_SIZE}
              y={BACKDROP_GRID_CONFIG.GRID_SIZE}
              width={BACKDROP_GRID_CONFIG.GRID_SIZE}
              height={BACKDROP_GRID_CONFIG.GRID_SIZE}
              fill="var(--canvas-checker, #dadce0)"
            />
          </pattern>
        </defs>

        {/* 1. Base Canvas Background Color */}
        <polygon
          ref={polygonBgRef}
          fill={showChess ? "var(--canvas-bg, #f8f9fa)" : "transparent"}
        />

        {/* 2. Checkerboard Pattern (Only visible if showChess is true) */}
        {showChess && (
          <polygon ref={polygonChessRef} fill="url(#checkerboard)" />
        )}
      </svg>
    </div>
  );
}
