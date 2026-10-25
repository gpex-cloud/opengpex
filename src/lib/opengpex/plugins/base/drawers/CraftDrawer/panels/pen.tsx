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

import { useEditorState, useEditorServices, usePluginSelfConfig } from "@opengpex/editor/core/context";
import React from "react";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import ColorSwatchRow from "@opengpex/editor/widgets/ColorSwatchRow";
import DelayedConfirm from "@opengpex/editor/widgets/DelayedConfirm";
import ComboInput from "@opengpex/editor/widgets/ComboInput";
import { PenOverlayAPI } from "../../../overlays/PenOverlay/protocols";
import { getPenDraft } from "../../../overlays/PenOverlay/interactions";
import { srgbHexToColorValue, PEN_DEFAULT_FILL_HEX } from "../../../overlays/PenOverlay/contribution";
import { toHex } from "@opengpex/editor/core/engine/color";
import type { ColorValue } from "@opengpex/editor/core/engine/color";
import { hasCommittableGeometry } from "../../../overlays/PenOverlay/pen/penState";
import type { CraftDrawerConfig } from "../protocols";

// ─── PenPanel ──────────────────────────────────────────────────────────────────

/**
 * PenPanel: pen tool panel inside CraftDrawer (shown when activeCraft='pen').
 *
 * Top-to-bottom: Import selection (frame's current clip slot → editable
 * draft), the feather preset for "Apply as Mask", and the three commit
 * targets. Commit buttons share one gate: the session must hold at least one
 * closed ring (open polylines mask as degenerate slivers, so only "Apply as
 * Mask" also accepts them through the command's own ring check).
 *
 * "Create Shape Layer" is pre-Phase-3: rendered disabled on purpose.
 */
export const PenPanel = React.memo(function PenPanel() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const feather = selfConfig.penFeather ?? 0;
  // Cross-plugin signal: read straight from interaction state (usePluginSignals
  // only exposes the CURRENT plugin's own signals — the TextOverlay precedent).
  const phase = state.interaction.signals[PenOverlayAPI.signals.phase] as string | undefined;
  // The draft payload itself lives in the frame's scratch slot (injected
  // facade — never a direct core/state/scratch import). Re-renders on draft
  // changes arrive via the 'scratch.revision' signal that record/undo/redo
  // dispatch at gesture granularity.
  const draft = activeFrame ? getPenDraft(actions.scratch, activeFrame.id) : null;

  // Committable = the tool is in its drawing phase AND the slot holds any
  // committable geometry: a closed ring, or an open polyline of 2+ anchors
  // (open subpaths close implicitly on every commit target — SVG fill
  // semantics — so they light the buttons just like closed rings).
  const canCommit = phase === "drawing" && hasCommittableGeometry({ draft, selected: null })
    && state.interaction.interactionMode === "craft";

  const updateFeather = (value: number) => {
    setSelfConfig({ penFeather: Math.max(0, Math.min(100, value)) } as Partial<CraftDrawerConfig>);
  };

  // Anchor budget for "Apply as Bezier": a 4-detent slider (100/200/300/400).
  // The native range input walks detent indices 0-3; the value label shows
  // the mapped anchor count. Persisted like the feather preset and consumed
  // by the pen command wherever the Apply as Bezier button lives.
  const ANCHOR_BUDGET_DETENTS = [100, 200, 300, 400] as const;
  const anchorBudget = selfConfig.penAnchorBudget ?? 200;
  const budgetIdx = Math.max(
    0,
    ANCHOR_BUDGET_DETENTS.indexOf(anchorBudget as (typeof ANCHOR_BUDGET_DETENTS)[number]),
  );
  const updateAnchorBudget = (idx: number) => {
    setSelfConfig({ penAnchorBudget: ANCHOR_BUDGET_DETENTS[idx] } as Partial<CraftDrawerConfig>);
  };

  // Shape layer style, DUAL-MODE like the marker panel:
  // - LAYER mode (the selected layer is a committed shape AND no draft
  //   session is being drawn): the style controls edit that layer's penStyle
  //   through the undoable updatePenStyle command (colors AND stroke width —
  //   the command re-runs the padded-bounds rebase for width changes), and
  //   remember the values as the pending preset for the next session.
  // - SESSION mode (a draft session is being drawn, or nothing editable is
  //   selected): the style controls write the pending preset consumed by
  //   "Create Shape Layer". The gate keys on the LIVE DRAWING PHASE, not on
  //   draft existence — Create Shape Layer keeps its draft on purpose, so a
  //   kept draft must not lock the user out of editing the committed shape.
  //   While anchors are being placed the swatches mean "style of the shape
  //   I am about to create" (the pick-color-then-commit mental model).
  const draftSessionLive = phase === "drawing";
  const styleTargetLayer =
    activeLayer && activeLayer.type === "vector" && activeLayer.penData && !draftSessionLive
      ? activeLayer
      : null;
  const layerPenStyle = styleTargetLayer?.penStyle;
  const pendingFillHex = selfConfig.penFillHex ?? PEN_DEFAULT_FILL_HEX;
  const pendingStrokeHex = selfConfig.penStrokeHex ?? "#0f172a";
  const fillHex = layerPenStyle?.fill ? toHex(layerPenStyle.fill) : pendingFillHex;
  const strokeHex = layerPenStyle?.stroke ? toHex(layerPenStyle.stroke.color) : pendingStrokeHex;
  const strokeWidth = layerPenStyle?.stroke
    ? layerPenStyle.stroke.width
    : (selfConfig.penStrokeWidth ?? 0);
  const updateStyle = (patch: Partial<{ penFillHex: string; penStrokeHex: string; penStrokeWidth: number }>) => {
    if (styleTargetLayer && activeFrame) {
      const commandPatch: { fill?: ColorValue | null; strokeColor?: ColorValue; strokeWidth?: number } = {};
      if (patch.penFillHex !== undefined) commandPatch.fill = srgbHexToColorValue(patch.penFillHex);
      if (patch.penStrokeHex !== undefined) commandPatch.strokeColor = srgbHexToColorValue(patch.penStrokeHex);
      if (patch.penStrokeWidth !== undefined) commandPatch.strokeWidth = patch.penStrokeWidth;
      actions.executeCommand(PenOverlayAPI.commands.updatePenStyle.uid, {
        frameId: activeFrame.id,
        layerId: styleTargetLayer.id,
        patch: commandPatch,
      });
    }
    // Either mode remembers the values as the next-session preset (colors in
    // both modes, stroke width in session mode — width never lands on the
    // layer, see the mode comment above).
    if (patch.penFillHex !== undefined || patch.penStrokeHex !== undefined || patch.penStrokeWidth !== undefined) {
      setSelfConfig(patch as Partial<CraftDrawerConfig>);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Anchor budget for Apply as Bezier (4 fixed detents) */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
          Anchors
        </span>
        <input
          type="range"
          min="0"
          max="3"
          step="1"
          value={budgetIdx}
          onChange={(e) => updateAnchorBudget(Number(e.target.value))}
          onMouseUp={(e) => e.currentTarget.blur()}
          onTouchEnd={(e) => e.currentTarget.blur()}
          className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-b border-[var(--border-subtle)] shadow-inner"
        />
        <div className="text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums flex items-center gap-0.5">
          <span className="text-[10px]">{ANCHOR_BUDGET_DETENTS[budgetIdx]}</span>
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">max</span>
        </div>
      </div>

      {/* Feather (applies to "Apply as Mask" only) */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16">
          Feather
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={feather}
          onChange={(e) => updateFeather(Number(e.target.value))}
          onMouseUp={(e) => e.currentTarget.blur()}
          onTouchEnd={(e) => e.currentTarget.blur()}
          className="flex-1 h-1.5 bg-[var(--bg-stage)] rounded-full appearance-none cursor-ew-resize hover:bg-[var(--border-subtle)] transition-all border-t border-b border-[var(--border-subtle)] shadow-inner"
        />
        <div className="flex items-center gap-0.5 text-right w-12 justify-end text-indigo-600 dark:text-indigo-400 font-black text-[10px] tabular-nums">
          <input
            type="number"
            min="0"
            max="100"
            value={feather}
            onChange={(e) => updateFeather(Number(e.target.value) || 0)}
            className="w-8 bg-transparent text-right focus:outline-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </div>

      {/* Shape layer style (consumed by Create Shape Layer) */}
      <div className="flex flex-col gap-1.5 px-1 pt-1">
        <ColorSwatchRow
          label="Fill"
          labelClassName="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16 shrink-0"
          color={fillHex}
          onChange={(c) => updateStyle({ penFillHex: c })}
        />
        <div className="flex items-center gap-2">
          <ColorSwatchRow
            label="Stroke"
            labelClassName="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-tight w-16 shrink-0"
            color={strokeHex}
            onChange={(c) => updateStyle({ penStrokeHex: c })}
          />
          <ComboInput
            value={strokeWidth}
            type="number"
            suffix="px"
            className="w-16"
            inputTestId="pen-stroke-width"
            onChange={() => {}}
            onCommit={(val) => updateStyle({ penStrokeWidth: Math.max(0, Number(val) || 0) })}
          />
        </div>
      </div>

      {/* Commit targets + session clear */}
      <div className="flex flex-col gap-1.5 p-1">
        <FancyButton
          variant="indigo"
          subtle
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => actions.executeCommand(PenOverlayAPI.commands.applyMask.uid, { feather })}
          disabled={!canCommit}
        >
          Apply as Mask
        </FancyButton>
        <FancyButton
          variant="cyan"
          subtle
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => actions.executeCommand(PenOverlayAPI.commands.toSelection.uid)}
          disabled={!canCommit}
        >
          Convert to Selection
        </FancyButton>
        <FancyButton
          variant="green"
          subtle
          size="sm"
          shape="pill"
          className="w-full"
          onClick={() => actions.executeCommand(PenOverlayAPI.commands.createShape.uid, {
            fill: srgbHexToColorValue(fillHex),
            stroke: strokeWidth > 0 ? { color: srgbHexToColorValue(strokeHex), width: strokeWidth } : null,
          })}
          disabled={!canCommit}
        >
          Create Shape Layer
        </FancyButton>
        <DelayedConfirm
          onConfirm={() => actions.executeCommand(PenOverlayAPI.commands.cancelDraft.uid)}
          confirmClassName="bg-red-500/10 dark:bg-red-400/5"
          roundedClassName="rounded-full"
        >
          <FancyButton
            variant="red"
            subtle
            size="sm"
            shape="pill"
            className="w-full"
            disabled={phase !== "drawing"}
          >
            Clear Draft
          </FancyButton>
        </DelayedConfirm>
      </div>

      {/* Session hint (mirrors the on-canvas grammar) */}
      <p className="px-1 pb-0.5 text-[8px] text-[var(--text-muted)] leading-relaxed">
        Click: corner anchor · drag: smooth anchor · click first anchor / Enter: finish · Esc: finish / leave (draft kept) · Clear Draft: discard
      </p>
    </div>
  );
});
