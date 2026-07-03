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

import { useCallback, useRef } from "react";
import {
  useOverlayRotationSync,
  useEditorState,
} from "@opengpex/editor/core/context";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { useClipOverlayCommands, useClipCursor } from "./hooks";
import {
  useCropDimSync,
  useRegularBoxSync,
  useSelectionAntsSync,
} from "./useFastSync";
import { lassoPreviewPathRef } from "./interactions";
import { PixelGridOverlayAPI } from "../PixelGridOverlay/protocols";

/**
 * ClipOverlayMain: UI layer for the cropping / selection tool.
 *
 * Architecture (2026-07-03 unified renderer):
 *
 *   - Single marching-ants <g>+<path>: renders ALL selection types (rect,
 *     ellipse, polygon, inverted) via `useSelectionAntsSync`. The unified
 *     selector reads the active slot and produces SVG path `d` regardless
 *     of data type. Fill switches dynamically (none for shapes, semi-
 *     transparent for polygons).
 *
 *   - Lasso preview <path> (screen-space): live trail during pointer drag.
 *     Updated imperatively by `createLassoHandler` via `lassoPreviewPathRef`.
 *
 *   - Regular box (CSS div): handles, dim label, rule-of-thirds guides.
 *     Only active when tool is regular (rect/ellipse) or Re-Canvas.
 */
export function ClipOverlayMain() {
  const {
    activeFrame,
    cropBox,
    isReCanvas,
    isClipActive,
    dragType,
    showError,
    boxRef,
    cropType,
    cropTool,
    isRegularTool,
    isIrregularTool,
  } = useClipOverlayCommands();

  useClipCursor(isClipActive, cropTool);

  const { state } = useEditorState();
  const overlayRef = useRef<HTMLDivElement>(null);

  useOverlayRotationSync(overlayRef, activeFrame);

  const gridConfig = state.pluginConfig[PixelGridOverlayAPI.configKey] as
    | { enabled?: boolean; zoomThreshold?: number }
    | undefined;
  const showGridThreshold = gridConfig?.enabled
    ? (gridConfig.zoomThreshold ?? 8)
    : null;

  // ─── Activation gates ────────────────────────────────────────────────────
  const isOverlayActive = isClipActive || isReCanvas;

  // Unified ants: always active when overlay is active (handles all data types)
  const antsActive = isOverlayActive;

  // Box (handles + dim label): only for regular tools or Re-Canvas
  const boxActive = isOverlayActive && (isReCanvas || isRegularTool);

  // ─── Fast-track hooks ────────────────────────────────────────────────────

  // Unified marching ants (single <g> + <path>)
  const groupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  useSelectionAntsSync(groupRef, pathRef, antsActive, isReCanvas, cropTool);

  // CSS box for drag handles + guides (regular tools only)
  const { guidesRef } = useRegularBoxSync(
    boxRef,
    boxActive,
    isReCanvas,
    showGridThreshold,
  );

  // Dimension label
  const { dimLabelRef } = useCropDimSync(boxActive, isReCanvas);

  // ─── Lasso preview path ref callback ─────────────────────────────────────
  const previewPathRef = useRef<SVGPathElement | null>(null);
  const setPreviewPathRef = useCallback((el: SVGPathElement | null) => {
    previewPathRef.current = el;
    lassoPreviewPathRef.current = el;
  }, []);

  if (!activeFrame || !isOverlayActive) return null;

  const cursor = dragType === "move"
    ? "move"
    : isIrregularTool
      ? "crosshair"
      : "default";

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 pointer-events-none"
      style={{ cursor, zIndex: EDITOR_Z_INDEX.STAGE.SYSTEM_TOOLS }}
    >
      {/* SVG layer: marching ants + lasso preview */}
      <div className="absolute inset-0 pointer-events-none overflow-visible">
        <svg className="absolute inset-0 w-full h-full overflow-visible">
          {/* Unified selection ants (white / red for Re-Canvas) */}
          <g
            ref={groupRef}
            style={{
              filter: isReCanvas
                ? "drop-shadow(0 0 1px rgba(0,0,0,0.5))"
                : "drop-shadow(0 0 1px rgba(0,0,0,0.5)) drop-shadow(0 0 1px rgba(255,255,255,0.3))",
            }}
          >
            <path
              ref={pathRef}
              fill="none"
              fillRule="evenodd"
              stroke={isReCanvas ? "#ef4444" : "white"}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6,6"
              className="marching-ants"
            />
          </g>

          {/* Lasso preview (screen-space, during pointer drag) */}
          <path
            ref={setPreviewPathRef}
            fill="none"
            fillRule="evenodd"
            stroke="#f0e6ff"
            strokeWidth="1"
            strokeDasharray="4,4"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
            className="marching-ants"
          />
        </svg>
      </div>

      {/* Regular crop box: handles + dim label + guides.
          Hidden when tool is irregular or data is polygon (via visibility gate). */}
      {isRegularTool && (
        <div
          ref={boxRef}
          className="absolute pointer-events-auto cursor-move transition-[border-radius] duration-300"
          style={{ borderRadius: cropType === "circle" ? "50%" : "0%" }}
          data-handle="move"
        >
          {showError && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none animate-in fade-in zoom-in duration-300">
              <div className="bg-red-500 text-white font-black uppercase text-[10px] tracking-widest px-3 py-1.5 rounded shadow-2xl flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                <span>Area is empty</span>
              </div>
            </div>
          )}

          {/* Resize Handles */}
          {[
            { h: "nw", c: "top-0 left-0", cursor: "nwse-resize" },
            { h: "ne", c: "top-0 right-0", cursor: "nesw-resize" },
            { h: "sw", c: "bottom-0 left-0", cursor: "nesw-resize" },
            { h: "se", c: "bottom-0 right-0", cursor: "nwse-resize" },
          ].map((p) => (
            <div
              key={p.h}
              className={`absolute w-6 h-6 transition-all group/handle ${p.c}`}
              style={{
                cursor: p.cursor,
                transform: `translate(${p.h.includes("w") ? "-30%" : "-70%"}, ${p.h.includes("n") ? "-30%" : "-70%"})`,
                left: p.h.includes("e") ? "100%" : "0%",
                top: p.h.includes("s") ? "100%" : "0%",
                zIndex: 10,
              }}
              data-handle={p.h}
            >
              <div
                className={`absolute w-full h-[3px] transition-opacity duration-200 opacity-0 group-hover/handle:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"} ${p.h.includes("n") ? "top-0" : "bottom-0"}`}
              />
              <div
                className={`absolute w-[3px] h-full transition-opacity duration-200 opacity-0 group-hover/handle:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"} ${p.h.includes("w") ? "left-0" : "right-0"}`}
              />
            </div>
          ))}

          <div
            className={`absolute top-1/2 -left-px w-1 h-8 shadow-sm cursor-ew-resize transition-all opacity-0 hover:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"}`}
            style={{ transform: "translate(-50%, -50%)" }}
            data-handle="w"
          />
          <div
            className={`absolute top-1/2 -right-px w-1 h-8 shadow-sm cursor-ew-resize transition-all opacity-0 hover:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"}`}
            style={{ transform: "translate(50%, -50%)" }}
            data-handle="e"
          />
          <div
            className={`absolute left-1/2 -top-px w-8 h-1 shadow-sm cursor-ns-resize transition-all opacity-0 hover:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"}`}
            style={{ transform: "translate(-50%, -50%)" }}
            data-handle="n"
          />
          <div
            className={`absolute left-1/2 -bottom-px w-8 h-1 shadow-sm cursor-ns-resize transition-all opacity-0 hover:opacity-100 ${isReCanvas ? "bg-red-500" : "bg-white"}`}
            style={{ transform: "translate(-50%, 50%)" }}
            data-handle="s"
          />

          {/* Rule of Thirds Grid */}
          <div
            ref={guidesRef}
            className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden"
            style={{ borderRadius: cropType === "circle" ? "50%" : "0%" }}
          >
            <div className="absolute top-1/3 left-0 w-full h-px bg-white" />
            <div className="absolute top-2/3 left-0 w-full h-px bg-white" />
            <div className="absolute left-1/3 top-0 h-full w-px bg-white" />
            <div className="absolute left-2/3 top-0 h-full w-px bg-white" />
          </div>

          {/* Dimension Labels */}
          <div
            className="absolute left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
            style={{
              top: "calc(100% + 6px)",
              padding: "1px 5px",
              gap: "2px",
              transformOrigin: "top left",
            }}
          >
            <span
              ref={dimLabelRef}
              className="text-[11px] font-black text-white tabular-nums tracking-tighter"
            >
              {Math.round(cropBox.w)} × {Math.round(cropBox.h)}
            </span>
            <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
          </div>
        </div>
      )}
    </div>
  );
}
