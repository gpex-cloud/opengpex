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

'use client';

import { useCallback, useRef } from 'react';
import {
  useSelectionAntsSync,
} from '../useFastSync';
import { lassoPreviewPathRef } from '../interactions';
import { MARCHING_ANTS_DURATION_S } from '../protocols';

/* ─── Inline keyframes for marching ants (plugin-internal, no global CSS) ─── */
const CLIP_ANTS_STYLE = `
  @keyframes clip-ants-flow {
    to { stroke-dashoffset: -12; }
  }
`;

/** Grid phase identity: the target layer's origin fraction, 0 or 0.5 (see GeometryService.quantizeGridOffset). */
export interface AntsGridOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * AntsLayer: the SVG overlay carrying the dual-path marching ants and the
 * lasso preview trail — the visual half of the ants pipeline (the pure
 * derivation lives in `./antsPath`, this component owns the DOM and the
 * fast-track wiring).
 *
 * Architecture (2026-07-05 dual-path high-contrast):
 *
 *   - Dual-path marching ants <g> + 2×<path>: industry-standard Photoshop/
 *     GIMP technique — a black dashed background path (offset by half-period)
 *     paired with a white/red foreground dashed path. This ensures selection
 *     edges are clearly visible against ANY background (light checkerboard,
 *     dark images, white image edges). Renders ALL selection types (rect,
 *     ellipse, polygon, inverted) via `useSelectionAntsSync`.
 *
 *   - Lasso preview <path> (screen-space): live trail during pointer drag.
 *     Updated imperatively by `createLassoHandler` via `lassoPreviewPathRef`.
 *
 *   - Plugin-internal `<style>`: keyframes for the marching animation are
 *     defined inside this component (no global CSS dependency).
 */
export function AntsLayer({
  isOverlayActive,
  isReCanvas,
  isEditing,
  marchingAntsAnimated,
  gridOffset,
}: {
  /** Master visibility: any mode where a selection exists (see the main gate). */
  isOverlayActive: boolean;
  /** Re-Canvas recolors the ants to the red resize family and reads the box. */
  isReCanvas: boolean;
  /** Clip mode or Re-Canvas — gates the dash ANIMATION only (passive ants are static). */
  isEditing: boolean;
  /** User preference: animated dashes while editing. */
  marchingAntsAnimated: boolean;
  /** Pixel-grid phase of the target layer (ants/GPU staircase alignment). */
  gridOffset: AntsGridOffset;
}) {
  const groupRef = useRef<SVGGElement>(null);
  const pathBgRef = useRef<SVGPathElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  useSelectionAntsSync(groupRef, pathBgRef, pathRef, isOverlayActive, isReCanvas, gridOffset);

  // ─── Lasso preview path ref callback ─────────────────────────────────────
  const previewPathRef = useRef<SVGPathElement | null>(null);
  const setPreviewPathRef = useCallback((el: SVGPathElement | null) => {
    previewPathRef.current = el;
    lassoPreviewPathRef.current = el;
  }, []);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-visible">
      {/* Plugin-internal keyframes for marching ants animation */}
      <style dangerouslySetInnerHTML={{ __html: CLIP_ANTS_STYLE }} />
      <svg className="absolute inset-0 w-full h-full overflow-visible">
        {/* Dual-path marching ants: black base fills white gaps for max contrast.
            This is the Photoshop/GIMP industry standard technique — ensures
            selection edges are visible against ANY background color. */}
        <g ref={groupRef}>
          {/* Base layer: solid black/dark-red line (always visible, provides contrast) */}
          <path
            ref={pathBgRef}
            fill="none"
            fillRule="evenodd"
            stroke={isReCanvas ? "#7f1d1d" : "black"}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {/* Foreground layer: dashes (animated or static based on MARCHING_ANTS_ANIMATED) */}
          <path
            ref={pathRef}
            fill="none"
            fillRule="evenodd"
            stroke={isReCanvas ? "#ef4444" : "white"}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            style={{
              strokeDasharray: '6, 6',
              ...(marchingAntsAnimated && isEditing
                ? { animation: `clip-ants-flow ${MARCHING_ANTS_DURATION_S}s linear infinite` }
                : {}),
            }}
          />
        </g>

        {/* Lasso preview (screen-space, during pointer drag) */}
        <path
          ref={setPreviewPathRef}
          fill="none"
          fillRule="evenodd"
          stroke="#f0e6ff"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
          style={{
            strokeDasharray: '4, 4',
            ...(marchingAntsAnimated
              ? { animation: 'clip-ants-flow 0.4s linear infinite' }
              : {}),
          }}
        />
      </svg>
    </div>
  );
}
