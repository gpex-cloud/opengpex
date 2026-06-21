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

import { useRef } from "react";
import {
  useOverlayRotationSync,
  useEditorState,
} from "@opengpex/editor/core/context";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { useClipOverlayCommands } from "./hooks";
import { useCropDimSync, useCropBoxSync } from "./useFastSync";
import { PIXEL_GRID_CONFIG_KEY } from "../PixelGridOverlay/protocols";

/**
 * ClipOverlayMain: UI layer for the cropping tool.
 * Responsible for rendering SVG masks, grid lines, resize handles, and real-time dimension labels.
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
  } = useClipOverlayCommands();
  const { state } = useEditorState();

  const overlayRef = useRef<HTMLDivElement>(null);

  // 1. Core Geometric Sync: Smooth rotation via global counter-animation hook
  useOverlayRotationSync(overlayRef, activeFrame);

  const gridConfig = state.pluginConfig[PIXEL_GRID_CONFIG_KEY] as
    | { enabled?: boolean; zoomThreshold?: number }
    | undefined;
  const showGridThreshold = gridConfig?.enabled
    ? (gridConfig.zoomThreshold ?? 8)
    : null;

  // 2. Selection Box and Mask Sync
  const { syncStyle, groupRef, pathRef, guidesRef } = useCropBoxSync(
    boxRef,
    cropBox,
    isClipActive,
    isReCanvas,
    showGridThreshold,
  );
  const { dimLabelRef } = useCropDimSync(isClipActive, isReCanvas);

  if (!activeFrame || !isClipActive) return null;

  const cursor = dragType === "move" ? "move" : "default";

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 pointer-events-none"
      style={{ cursor, zIndex: EDITOR_Z_INDEX.STAGE.SYSTEM_TOOLS }}
    >
      {/* 1. Marching Ants Vector Layer (Full Viewport SVG, transformed via group) */}
      <div className="absolute inset-0 pointer-events-none overflow-visible">
        <svg className="absolute inset-0 w-full h-full overflow-visible">
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
              stroke={isReCanvas ? "#ef4444" : "white"}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6,6"
              className="marching-ants"
            />
          </g>
        </svg>
      </div>

      <div
        ref={boxRef}
        className="absolute pointer-events-auto cursor-move transition-[border-radius] duration-300"
        style={{
          ...syncStyle,
          borderRadius: cropType === "circle" ? "50%" : "0%",
        }}
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

        {/* Resize Handles - Initially transparent, appears on hover */}
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

        {/* Rule of Thirds Grid Lines - Only internal lines and clipped to shape */}
        <div
          ref={guidesRef}
          className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden"
          style={{ borderRadius: cropType === "circle" ? "50%" : "0%" }}
        >
          {/* Horizontal lines */}
          <div className="absolute top-1/3 left-0 w-full h-px bg-white" />
          <div className="absolute top-2/3 left-0 w-full h-px bg-white" />
          {/* Vertical lines */}
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
    </div>
  );
}
