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
  useRegularCropSync,
  useIrregularSelectionSync,
} from "./useFastSync";
import { lassoPreviewPathRef } from "./interactions";
import { PixelGridOverlayAPI } from "../PixelGridOverlay/protocols";

/**
 * ClipOverlayMain: UI layer for the cropping tool.
 *
 * Two SVG marching-ants channels coexist permanently in the DOM (mounted but
 * inactive when not relevant) so the CSS keyframe animation never resets:
 *   - Channel 1 (white / red): regular crop box (rect / ellipse), driven by
 *     `useRegularCropSync` and active only when `cropTool ∈ {rect, ellipse-*}`.
 *   - Channel 2 (purple): irregular polygon selection (lasso / wand), driven
 *     by `useIrregularSelectionSync`, active only when `cropTool ∈ {lasso, wand}`
 *     **and** `irregularCropBox` is non-null.
 *   - Channel 3 (purple, screen-space): the live lasso preview during pointer
 *     drag. Updated imperatively by `createLassoHandler` via `lassoPreviewPathRef`,
 *     bypassing React entirely. Hidden when the trail is empty (`d=""`).
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

  // Per-tool custom cursor (crosshair + badge) via cursorOverride signal
  useClipCursor(isClipActive, cropTool);

  const { state } = useEditorState();

  const overlayRef = useRef<HTMLDivElement>(null);

  // 1. Core Geometric Sync: Smooth rotation via global counter-animation hook
  useOverlayRotationSync(overlayRef, activeFrame);

  const gridConfig = state.pluginConfig[PixelGridOverlayAPI.configKey] as
    | { enabled?: boolean; zoomThreshold?: number }
    | undefined;
  const showGridThreshold = gridConfig?.enabled
    ? (gridConfig.zoomThreshold ?? 8)
    : null;

  // ─── 2a / 2b: fast-track activation gates ───────────────────────────────
  // The overlay is mounted whenever the user is *either* in clip mode OR
  // Re-Canvas is active (the two now operate as orthogonal modals — see
  // `useClipOverlayCommands` for the `cropTool` synthesis that pins family
  // to 'regular' during Re-Canvas). The activation gate for the *regular*
  // channel is therefore `(isClipActive || isReCanvas) && isRegularTool`:
  // Re-Canvas always wants the rect draggable, regardless of what tool the
  // user had selected before opening Re-Canvas.
  //
  // The irregular channel never activates during Re-Canvas (Re-Canvas is
  // rect-only), so its gate keeps the stricter `isClipActive` check.
  const isOverlayActive = isClipActive || isReCanvas;

  const { syncStyle, groupRef, pathRef, guidesRef } = useRegularCropSync(
    boxRef,
    cropBox,
    isOverlayActive && isRegularTool,
    isReCanvas,
    showGridThreshold,
  );

  // 2b. Irregular polygon sync (lasso / wand) — selector returns null when
  //     irregularCropBox is empty so the path naturally hides.
  const polyGroupRef = useRef<SVGGElement>(null);
  const polyPathRef = useRef<SVGPathElement>(null);
  useIrregularSelectionSync(
    polyGroupRef,
    polyPathRef,
    isClipActive && isIrregularTool,
    cropTool,
  );



  // 2c. Lasso preview path: install/uninstall the module-level ref slot used
  //     by `createLassoHandler` to paint the in-progress trail without redux.
  //
  // [Pre-PR-6 缺陷 B 真因修复] We MUST use a ref callback instead of a
  // useRef + useEffect([]) pair. Reason:
  //
  //   - `if (!activeFrame || !isClipActive) return null;` early-exits below.
  //   - On the very first render (non-clip mode), the <path> below is NEVER
  //     rendered, so `previewPathRef.current === null`.
  //   - The useEffect with `[]` deps then captures that null and assigns it
  //     to the module-level `lassoPreviewPathRef.current`.
  //   - When the user later switches to clip mode the component re-renders,
  //     the <path> mounts, but the empty-deps effect never runs again, so
  //     `lassoPreviewPathRef.current` stays null forever.
  //   - Result: `createLassoHandler.onStart` reports `previewRef=false` even
  //     though pointermove fires — exactly what the live trace showed.
  //
  // The ref callback below fires synchronously on EVERY mount/unmount of the
  // <path> element, so the module-level ref is always in sync with the DOM
  // regardless of conditional rendering above.
  const previewPathRef = useRef<SVGPathElement | null>(null);
  const setPreviewPathRef = useCallback((el: SVGPathElement | null) => {
    previewPathRef.current = el;
    lassoPreviewPathRef.current = el;
  }, []);

  const { dimLabelRef } = useCropDimSync(
    isOverlayActive && isRegularTool,
    isReCanvas,
  );

  // Mount whenever clip OR Re-Canvas is active. Re-Canvas users expect the
  // canvas rect (with handles + dim label) to be visible & draggable even
  // outside of explicit clip mode — see commands.ts::toggleReCanvas notes.
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
      {/* 1. Marching Ants Vector Layer (Full Viewport SVG, transformed via group) */}
      <div className="absolute inset-0 pointer-events-none overflow-visible">
        <svg className="absolute inset-0 w-full h-full overflow-visible">
          {/* Channel 1: regular crop (rect / ellipse) */}
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

          {/* ─── Channel 2: irregular polygon selection (lasso / wand) ────────
           * Near-white lavender marching ants (`#f0e6ff`). The stroke is
           * intentionally almost-white with a subtle purple tint — this
           * maximizes contrast on all image types (dark, busy, mid-tone)
           * while the `drop-shadow` black halo on the parent <g> ensures
           * visibility on pure-white / bright regions. The purple identity
           * is maintained through the tint rather than saturation.
           */}
          <g
            ref={polyGroupRef}
            style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,0.5))" }}
          >
            <path
              ref={polyPathRef}
              fill="rgba(240, 230, 255, 0.12)"
              fillRule="evenodd"
              stroke="#f0e6ff"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6,6"
              className="marching-ants"
            />
          </g>

          {/* ─── Channel 3: live lasso preview (screen-space) ────────────────
           * Same near-white lavender as channel 2 for visual consistency.
           * Single <path>, no underlay (see channel-2 rationale above).
           */}
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

      {/* Regular crop's draggable rect + handles + dim label.
          Hidden entirely on irregular tools — lasso/wand selections
          are not draggable / resizable in Phase 1.
          When imageCropBox is 0×0 the fast-track paints width/height=0 so
          the div is invisible; visibility toggles in useRegularCropSync. */}
      {isRegularTool && (
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
      )}
    </div>
  );
}
