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

import React, { useRef, useState } from "react";
import { Compass } from "lucide-react";

import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import { getStraightenPivot, STRAIGHTEN_TRANSIENT_KEY } from "@opengpex/editor/core/state/volatile/straighten";
import { useViewportCommands } from "./hooks";

/**
 * StraightenControl — free-angle canvas straighten widget sitting next to
 * the ±90° canvas-rotation group in the ViewOptions bar.
 *
 * Gesture model (a COMMITTED materialization, not a persistent property):
 *
 *   • Drag: horizontal drag scrubs the preview DELTA (Shift snaps the
 *     PROJECTED TOTAL — history + delta — onto the 15° grid, so grid angle
 *     0 IS the original orientation). Every move writes the angle + pivot
 *     into the fast-track `straighten` transient; the renderer folds it into
 *     every layer pose through the pose-override seam, so the preview is
 *     live and pixel-exact.
 *   • Release: the delta materializes in ONE undoable step (pose records
 *     rewritten about the pivot, delta absorbed). Releasing at 0° aborts
 *     silently.
 *   • Esc (or any pointer cancel): aborts the preview, no materialization.
 *   • Numeric key (at rest) + Enter: exact TARGET TOTAL materializes in one
 *     step (typing 0 = back to the original orientation).
 *   • Double-click at rest: snap back to the original orientation (one
 *     materialization of −history total); mid-drag: cancel the preview.
 *
 * Readout: the committed poses carry no angle, so the pill shows the
 * DISPLAY-ONLY history total (`frame.extra.straightenTotalDeg`, accumulated
 * by the command) at rest, and history + live delta mid-drag. The value is
 * pure user-facing history — no geometry consumer reads it.
 *
 * While the drag is in flight the volatile `interacting` flag is raised, so
 * all editing gestures are soft-disabled until the pointer is released.
 */

/** Horizontal drag sensitivity: 2px of travel per degree. */
const DEG_PER_PX = 0.5;
/** Drag-activation threshold (px): pointer travel below this is a click, not
 * a scrub — without it, 1-2px of pointer jitter on a plain click materializes
 * a fraction-of-a-degree rotation. */
const DRAG_THRESHOLD_PX = 3;
/** Shift-drag snapping grid (degrees), same convention as the gizmo rotator. */
const SNAP_STEP_DEG = 15;
/** Display-only frame.extra key: the accumulated sum of every materialized
 * straighten angle. Pure user-facing history — NO geometry consumer may read
 * it (the committed poses are the only geometric truth). */
const HISTORY_DEG_KEY = "straightenTotalDeg";

/** Readout formatter: integers render bare, fractions keep one decimal —
 * the drag scrub (0.5°/px) produces fractional angles constantly and
 * rounding them away made the readout lie about the preview. */
function fmtDeg(deg: number): string {
  return Number.isInteger(deg) ? String(deg) : deg.toFixed(1);
}

export default function StraightenControl() {
  const { activeFrame } = useEditorState();
  const { actions } = useEditorServices();
  const { straightenCmd } = useViewportCommands();

  /** Accumulated history angle (display-only). Each materialization adds its
   * θ, so the user can see the total rotation applied since the document was
   * opened — "0°" means back at the original orientation. */
  const historyDeg = Number(activeFrame?.extra?.[HISTORY_DEG_KEY] ?? 0);

  /** Live preview DELTA for the readout (always 0 at rest — the
   * materialization absorbs the delta, nothing persists). */
  const [displayDeg, setDisplayDeg] = useState(0);
  const [inputText, setInputText] = useState("0");
  /** Inline exact-total entry mode (replaces the old dedicated input box). */
  const [editing, setEditing] = useState(false);
  const dragRef = useRef<{ startX: number; theta: number; moved: boolean } | null>(null);

  /**
   * Shift-snap helper: rounds the PROJECTED TOTAL (history + current drag
   * delta) onto the step grid and re-expresses it as a drag delta. Anchoring
   * on the total is what makes "get back to the original orientation"
   * achievable: the grid intersection at total == 0 IS the original.
   */
  const snapDeltaToTotalGrid = React.useCallback(
    (thetaDeg: number): number => {
      const snappedTotal = Math.round((historyDeg + thetaDeg) / SNAP_STEP_DEG) * SNAP_STEP_DEG;
      return snappedTotal - historyDeg;
    },
    [historyDeg],
  );

  /** Aborts the preview (no materialization) and closes the fast track. */
  const abortPreview = React.useCallback(() => {
    dragRef.current = null;
    actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, null);
    actions.mutateVolatile((v) => { v.activeState.interacting = false; });
    setDisplayDeg(0);
    setInputText("0");
  }, [actions]);

  /** Commits the current drag angle as a materialization step (or aborts at
   * exactly 0° — nothing to absorb). The command clears the transient and
   * lands the record rewrite in one undoable updateFrame. */
  const commitPreview = React.useCallback((thetaDeg: number) => {
    dragRef.current = null;
    if (thetaDeg && activeFrame) {
      straightenCmd.execute({ thetaDeg });
    } else {
      actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, null);
    }
    actions.mutateVolatile((v) => { v.activeState.interacting = false; });
    setDisplayDeg(0);
    setInputText("0");
  }, [actions, activeFrame, straightenCmd]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!activeFrame || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, theta: 0, moved: false };
    // Open the fast track: while the preview is live all editing gestures
    // are soft-disabled (the flag drops again at release/abort).
    actions.mutateVolatile((v) => { v.activeState.interacting = true; });
    actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, {
      thetaDeg: 0,
      pivot: getStraightenPivot(activeFrame),
    });
    setDisplayDeg(0);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !activeFrame) return;
    // Drag-activation gate: until the pointer travels past the threshold this
    // is still "a click in progress" — no preview, no transient writes.
    // Crossing the threshold re-anchors the origin so the scrub starts at 0°
    // from the threshold point (no jump from the pre-threshold travel).
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      drag.startX = e.clientX;
    }
    let theta = (e.clientX - drag.startX) * DEG_PER_PX;
    if (e.shiftKey) theta = snapDeltaToTotalGrid(theta);
    drag.theta = theta;
    actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, {
      thetaDeg: theta,
      pivot: getStraightenPivot(activeFrame),
    });
    setDisplayDeg(theta);
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    // Sub-threshold release = a click, not a scrub: abort (no materialization).
    if (!drag.moved) {
      abortPreview();
      return;
    }
    commitPreview(drag.theta);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && dragRef.current) {
      e.preventDefault();
      abortPreview();
      return;
    }
    // Numeric key at rest (no drag in flight): enter inline exact-total
    // editing — the old dedicated input box's capability, folded into the
    // pill itself.
    if (!dragRef.current && e.key.length === 1 && /[-0-9.]/.test(e.key) && activeFrame) {
      setEditing(true);
      setInputText(e.key);
      return;
    }
    // Shift pressed MID-DRAG: snap the PROJECTED TOTAL to the grid
    // immediately (no pointer move needed). This is the "get back to a known
    // orientation" affordance — the grid intersection at total == 0 is the
    // original, so dragging back with Shift held lands exactly on it.
    if (e.key === "Shift" && dragRef.current && activeFrame) {
      const snapped = snapDeltaToTotalGrid(dragRef.current.theta);
      dragRef.current.theta = snapped;
      actions.fast.setTransient(STRAIGHTEN_TRANSIENT_KEY, {
        thetaDeg: snapped,
        pivot: getStraightenPivot(activeFrame),
      });
      setDisplayDeg(snapped);
    }
  };

  /** Exact-angle entry: the typed value is a TARGET TOTAL (matching the
   * readout) — Enter materializes the delta that lands on it, so typing 0 is
   * "back to the original orientation". */
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      setInputText("0");
      return;
    }
    if (e.key !== "Enter") return;
    const parsed = parseFloat(inputText);
    const targetTotal = Number.isFinite(parsed) ? parsed : historyDeg;
    commitPreview(targetTotal - historyDeg);
    setEditing(false);
  };

  const disabled = !activeFrame;
  /** Display value: at rest the accumulated HISTORY total; mid-drag the
   * projected total (history + live delta). Display-only — the committed
   * poses carry the real geometry. */
  const shownDeg = historyDeg + displayDeg;

  /** At-rest double-click = snap back to the original orientation: one
   * materialization of −(history total) through the same undoable command.
   * Mid-drag double-click stays "cancel the preview". Inside the inline
   * editor the double-click is plain text interaction — it must NOT fire
   * the reset (the first click of the sequence opened the editor; the
   * double-click lands while editing is already true). */
  const onDoubleClick = () => {
    if (dragRef.current) {
      abortPreview();
      return;
    }
    if (editing) return;
    if (activeFrame && historyDeg) {
      straightenCmd.execute({ thetaDeg: -historyDeg });
    }
  };

  /** Readout click: enter inline exact-total editing, seeded with the
   * current total. The drag surface is the ICON zone only — the readout is
   * deliberately NOT draggable, so a click here always lands as a click
   * (whole-pill drag coverage would swallow it into a scrub gesture). */
  const onReadoutClick = () => {
    if (disabled || editing) return;
    setEditing(true);
    setInputText(String(Math.round(historyDeg)));
  };

  return (
    <div className="inline-flex items-center h-6 rounded-full border border-[var(--border-subtle)] hover:border-indigo-500/30 transition-all duration-200 overflow-hidden">
      {/* Zoned control: the compass icon is the drag handle (horizontal scrub
          = preview delta), the readout is the click-to-type zone (inline
          exact-total entry). Whole-pill drag coverage would leave no click
          target for editing — hence the partition. Double-click回正 works
          from both zones. */}
      <div className="flex items-center h-full">
        {/* Icon zone — drag handle */}
        <div
          role="slider"
          aria-label="Straighten"
          aria-valuenow={shownDeg}
          aria-valuemin={-180}
          aria-valuemax={180}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={abortPreview}
          onKeyDown={onKeyDown}
          onDoubleClick={onDoubleClick}
          title="Drag to straighten (Shift snaps to the 15° grid of the total, release applies, Esc cancels; double-click snaps back to 0°)"
          className={`flex items-center h-full pl-2 pr-0.5 select-none touch-none outline-none focus-visible:border-amber-500/50 ${
            disabled ? "opacity-30 cursor-not-allowed" : "cursor-ew-resize hover:text-[var(--text-main)]"
          } ${Math.round(displayDeg) !== 0 ? "text-amber-500" : "text-[var(--text-muted)]"}`}
        >
          <Compass size={12} />
        </div>
        {/* Readout zone — click to edit the exact total */}
        <div
          onDoubleClick={onDoubleClick}
          onClick={onReadoutClick}
          title="Click to type an exact total angle (Enter applies, Esc cancels)"
          className={`flex items-center h-full pr-2 select-none outline-none hover:text-[var(--text-main)] ${
            disabled ? "opacity-30" : "cursor-text"
          } ${Math.round(displayDeg) !== 0 ? "text-amber-500" : "text-[var(--text-muted)]"}`}
        >
          {editing ? (
            <input
              autoFocus
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={onInputKeyDown}
              onBlur={() => { setEditing(false); setInputText("0"); }}
              onFocus={(e) => e.target.select()}
              aria-label="Straighten total angle in degrees"
              className="w-9 bg-transparent text-[10px] font-bold tabular-nums text-right text-[var(--text-main)] outline-none"
            />
          ) : (
            <span className="w-9 text-[10px] font-bold tabular-nums text-right">
              {fmtDeg(shownDeg)}°
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
