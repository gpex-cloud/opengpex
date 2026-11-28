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

import { useEffect, useState } from "react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import { Check } from "lucide-react";
import { ClipOptionsAPI } from "../../../options/ClipOptions/protocols";
import { asLocalRect } from "@opengpex/editor/core/types";

/**
 * ReCanvasBar: the chip under the Re-Canvas box — editable W/H (dense
 * ComboInputs, no aspect lock: a straightened crop box must be free to take
 * any shape), the straighten fit presets (Fit In / Fit Out), and APPLY.
 *
 * Self-contained: everything here reads the committed frame and writes the
 * box via actions.updateFrame; the APPLY gesture cross-references the
 * ClipOptions apply command by uid (the mode's owner — same precedent as
 * the box reset command).
 */

/** Shared chrome for the bar's small action buttons (Fit In / Fit Out). */
const FIT_BUTTON_CLASS =
  "text-[10px] font-bold text-white/70 hover:text-white bg-white/5 hover:bg-white/15 border border-white/10 rounded px-1.5 py-0.5 transition-colors";

/**
 * ReCanvasBar component. The whole chip is a pointer territory
 * (pointer-events-auto cursor-default select-none): hovering shows the
 * plain cursor, clicks never fall through to the canvas handlers, and
 * browser text selection cannot start here. Action buttons prevent default
 * on mousedown so a click never leaves them focused — otherwise the
 * subsequent Space keypress (a canvas shortcut) would re-trigger the
 * focused button instead.
 */
export function ReCanvasBar() {
  const { state, activeFrame } = useEditorState();
  const { geometry, actions, volatileRef } = useEditorServices();

  // ─── Live dims feed ──────────────────────────────────────────────────────
  // The W/H inputs are ALWAYS the form. While a box drag is in flight, a
  // rAF loop mirrors the live buffered rect into the input values;
  // ComboInput's commit mode shows an internal draft while focused, so a
  // live value update can never clobber something the user is typing. At
  // rest the values come straight from the committed frame.
  const [liveCanvasDims, setLiveCanvasDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    // This component only mounts while Re-Canvas is active (the parent gates
    // it), so the live feed is gated on the drag alone.
    if (!activeFrame || !state.interaction.isInteracting) return;
    let rafId = 0;
    const tick = () => {
      const rect = volatileRef.current.buffered.frames[activeFrame.id]?.canvasClipBox?.rect;
      if (rect) {
        setLiveCanvasDims((prev) =>
          prev && prev.w === rect.w && prev.h === rect.h ? prev : { w: rect.w, h: rect.h },
        );
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      // Clear on teardown (drag end) — the committed frame is the truth at
      // rest; a stale live value would shadow later box changes.
      setLiveCanvasDims(null);
    };
  }, [activeFrame, state.interaction.isInteracting, volatileRef]);

  if (!activeFrame) return null;
  const clipBox = activeFrame.canvasClipBox.rect;

  // ─── Numeric dim commit ──────────────────────────────────────────────────
  // No aspect lock (see header). Reuses the popover's smart-anchor rule:
  // pin whichever edge already sits on a canvas edge, grow from the opposite
  // side; grow symmetrically when both or neither do.
  const commitCanvasDim = (rawVal: number, axis: 'w' | 'h') => {
    const parsed = Math.max(1, Math.round(Number(rawVal)));
    if (!isFinite(parsed)) return;
    const box = activeFrame.canvasClipBox.rect;
    const next = { x: box.x, y: box.y, w: box.w, h: box.h };
    const changed = next[axis] !== parsed;
    const { w: cw, h: ch } = activeFrame.canvas;
    if (changed && axis === 'w') {
      const leftAligned = next.x === 0;
      const rightAligned = next.x + next.w === cw;
      if (rightAligned && !leftAligned) next.x = cw - parsed;
      else if (!leftAligned && !rightAligned) next.x = Math.round(next.x + (next.w - parsed) / 2);
      next.w = parsed;
    } else if (changed) {
      const topAligned = next.y === 0;
      const bottomAligned = next.y + next.h === ch;
      if (bottomAligned && !topAligned) next.y = ch - parsed;
      else if (!topAligned && !bottomAligned) next.y = Math.round(next.y + (next.h - parsed) / 2);
      next.h = parsed;
    }
    actions.updateFrame(activeFrame.id, {
      canvasClipBox: { ...activeFrame.canvasClipBox, rect: asLocalRect(next) },
    });
  };

  // A box equal to the canvas is a no-op resize (the session default) —
  // APPLY disables, the command keeps its own backstop.
  const boxEqualsCanvas =
    Math.round(clipBox.w) === activeFrame.canvas.w
    && Math.round(clipBox.h) === activeFrame.canvas.h;

  // ─── Fit presets ("Fit In" / "Fit Out") ──────────────────────────────────
  // The presets are computed from the BASE LAYER POSE — the geometric ground
  // truth of where the original content sits on the canvas — never from the
  // display-only straighten accumulator or the canvas dims. The layer's
  // `rotation` folds in EVERY orientation source (±90 canvas transforms via
  // the D4 composition, free-angle straighten, user gizmo turns), and its
  // `bounding` is the content-local size, so the rotated original on canvas
  // is exactly: center (cx, cy) in POSE space, size bounding, angle
  // rotation. Pose space shares the canvas axes but its ORIGIN is the
  // CANVAS CENTER, while the clip box rect lives in top-left canvas
  // space — the center must be re-based (+canvas/2) before use. Sizing the
  // presets off the canvas dims instead goes wrong the moment the canvas no
  // longer coincides with the content (any prior re-canvas apply, crop, or a
  // ±90 canvas transform mixing with straighten — the box then comes out
  // transposed, a full 90 degrees off).
  // "Fit In" sizes the box to the largest upright rect the rotated original
  // still covers (the output loses NO visible content and carries no
  // transparent corners); "Fit Out" sizes it to the rotated original's
  // upright bounding box (nothing is lost, transparent corners ship).
  // Mirroring (flip) never changes a rect's coverage geometry, so the flip
  // flags need no handling here. Either preset only SETS the draggable box —
  // APPLY stays the authority (the box is always the user's to adjust).
  const baseLayer = activeFrame.layers.byId[activeFrame.layers.order[0]];
  const fitAngleDeg = baseLayer
    ? baseLayer.rotation
    : Number(activeFrame.extra?.straightenTotalDeg ?? 0);
  const fitDims = baseLayer ? baseLayer.bounding : activeFrame.canvas;
  const fitCenter = baseLayer
    ? { x: activeFrame.canvas.w / 2 + baseLayer.cx, y: activeFrame.canvas.h / 2 + baseLayer.cy }
    : { x: activeFrame.canvas.w / 2, y: activeFrame.canvas.h / 2 };
  const foldedFitDeg = ((fitAngleDeg % 180) + 180) % 180;
  const canOfferFitPresets = Math.min(foldedFitDeg, 180 - foldedFitDeg) >= 0.5;
  const applyFitPreset = (kind: 'inside' | 'all') => {
    const size = kind === 'inside'
      ? geometry.transform.inscribedRectSize(fitDims.w, fitDims.h, fitAngleDeg)
      : geometry.transform.circumscribedRectSize(fitDims.w, fitDims.h, fitAngleDeg);
    actions.updateFrame(activeFrame.id, {
      canvasClipBox: {
        ...activeFrame.canvasClipBox,
        rect: asLocalRect({ x: fitCenter.x - size.w / 2, y: fitCenter.y - size.h / 2, w: size.w, h: size.h }),
      },
    });
  };

  return (
    <div
      className="absolute left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-auto cursor-default select-none whitespace-nowrap"
      style={{
        top: "calc(100% + 6px)",
        padding: "1px 5px",
        gap: "2px",
        transformOrigin: "top left",
      }}
    >
      <span className="flex items-center gap-1">
        <ComboInput
          dense
          label="W"
          value={Math.round(liveCanvasDims?.w ?? clipBox.w)}
          type="number"
          className="w-[52px]"
          onChange={() => {}}
          onCommit={(val) => commitCanvasDim(Number(val), 'w')}
        />
        <span className="text-zinc-500 text-[10px]">×</span>
        <ComboInput
          dense
          label="H"
          value={Math.round(liveCanvasDims?.h ?? clipBox.h)}
          type="number"
          className="w-[52px]"
          onChange={() => {}}
          onCommit={(val) => commitCanvasDim(Number(val), 'h')}
        />
      </span>
      <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
      {canOfferFitPresets && (
        <>
          <span className="w-px h-3.5 bg-white/15 mx-1" />
          <button
            className={FIT_BUTTON_CLASS}
            title="Crop to the largest upright rect fully covered by the rotated image (no transparent corners)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyFitPreset('inside')}
          >
            Fit In
          </button>
          <button
            className={FIT_BUTTON_CLASS}
            title="Expand the canvas to cover the entire rotated image (transparent corners kept)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyFitPreset('all')}
          >
            Fit Out
          </button>
        </>
      )}
      <button
        className="flex items-center gap-1 text-[10px] font-bold rounded px-1.5 py-0.5 ml-1 transition-colors disabled:cursor-not-allowed bg-rose-500 hover:bg-rose-600 text-white disabled:bg-rose-500/40 disabled:text-white/50"
        title="Resize the canvas to this box"
        disabled={boxEqualsCanvas}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => actions.executeCommand(ClipOptionsAPI.commands.reCanvasApply.uid)}
      >
        <Check size={11} strokeWidth={3} />
        APPLY
      </button>
    </div>
  );
}
