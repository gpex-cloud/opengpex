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

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  Layer,
  VectorMask,
  BitmapMask,
  AdjustmentMask,
} from "@opengpex/editor/core/types";
import { summarizeAdjustMask } from "../../utils";
import { useMaskEdit } from "../../hooks";
import { MaskGroupPanel } from "./MaskGroupPanel";

/**
 * Display-level auto-grouping of a layer's mask families. When one family
 * (vector / bitmap / adjust) holds two or more masks, the flat per-mask rows
 * collapse into a single group row; hovering (or tapping) the row opens a
 * floating panel that lists the members with the existing row components.
 * The grouping is purely derived from the mask arrays — nothing is stored,
 * persisted, or undo-tracked, so adding/removing a mask naturally crosses
 * the group threshold in both directions.
 */
export type MaskFamily = "vector" | "bitmap" | "adjust";

export type AnyLayerMask = VectorMask | BitmapMask | AdjustmentMask;

export interface MaskGroupPlanEntry {
  family: MaskFamily;
  /** "flat" = render the single mask row as before, "group" = render a group row */
  mode: "flat" | "group";
}

const FAMILY_ORDER: MaskFamily[] = ["vector", "bitmap", "adjust"];

/** Plural family name shown on the collapsed group row. */
const FAMILY_PLURAL: Record<MaskFamily, string> = {
  vector: "Vectors",
  bitmap: "Bitmaps",
  adjust: "Adjustments",
};

/** Masks of one family, in storage order (oldest first, same as the model). */
export function familyMasks(
  layer: Pick<Layer, "vectorMasks" | "bitmapMasks" | "adjustMasks">,
  family: MaskFamily,
): AnyLayerMask[] {
  switch (family) {
    case "vector":
      return layer.vectorMasks ?? [];
    case "bitmap":
      return layer.bitmapMasks ?? [];
    case "adjust":
      return layer.adjustMasks ?? [];
  }
}

/**
 * Per-family render plan in display order: families with masks either keep
 * their single flat row or collapse into one group row (count >= 2).
 */
export function planMaskGroups(
  layer: Pick<Layer, "vectorMasks" | "bitmapMasks" | "adjustMasks">,
): MaskGroupPlanEntry[] {
  const plan: MaskGroupPlanEntry[] = [];
  for (const family of FAMILY_ORDER) {
    const count = familyMasks(layer, family).length;
    if (count === 0) continue;
    plan.push({ family, mode: count >= 2 ? "group" : "flat" });
  }
  return plan;
}

/**
 * Summary of the newest mask (last array element) for the group row, using
 * the same label rules as the flat rows: "Mask #N" / "Inverted Mask #N" /
 * "Mask Cutouts" for vector and bitmap, and the adjustment parameter summary
 * for adjust masks.
 */
export function newestMaskSummary(family: MaskFamily, masks: AnyLayerMask[]): string {
  const newest = masks[masks.length - 1];
  if (!newest) return "";
  if (family === "adjust") return summarizeAdjustMask(newest as AdjustmentMask);
  const m = newest as VectorMask | BitmapMask;
  if ("tag" in m && m.tag?.toLowerCase() === "drilled") return "Mask Cutouts";
  const invertedPrefix = "src" in m && m.inverted ? "Inverted " : "";
  return `${invertedPrefix}Mask #${masks.length}`;
}

interface MaskGroupItemProps {
  layerId: string;
  family: MaskFamily;
  masks: AnyLayerMask[];
}

/**
 * Collapsed single row for one mask family with >= 2 members. Opens the
 * floating member panel after a short hover delay; a tap toggles it for
 * touch input. While any bitmap member is in its paint-to-erase editing
 * session, the row shows an emerald editing state and the panel stays
 * pinned open (no auto-close) so the editing entry point never disappears
 * mid-stroke.
 */
export const MaskGroupItem = ({ layerId, family, masks }: MaskGroupItemProps) => {
  const { maskEditing } = useMaskEdit();
  const rowRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelHovered = useRef(false);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  // Only bitmap masks have a paint editing session; the group row lights up
  // and pins the panel when one of THIS group's members is being edited.
  const editingActive =
    family === "bitmap" &&
    !!maskEditing &&
    maskEditing.layerId === layerId &&
    masks.some((m) => m.id === maskEditing.maskId);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const openPanel = useCallback(() => {
    if (!rowRef.current) return;
    setAnchorRect(rowRef.current.getBoundingClientRect());
    setOpen(true);
  }, []);

  const handlePointerEnter = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    openTimer.current = setTimeout(openPanel, 120);
  }, [openPanel]);

  const armAutoClose = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (!open || editingActive) return;
    closeTimer.current = setTimeout(() => {
      if (!panelHovered.current) setOpen(false);
    }, 200);
  }, [open, editingActive]);

  return (
    <>
      <div
        ref={rowRef}
        data-testid={`mask-group-row-${family}`}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={armAutoClose}
        onClick={(e) => {
          e.stopPropagation();
          if (open && !editingActive) {
            setOpen(false);
          } else {
            openPanel();
          }
        }}
        className={`flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] select-none cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${
          editingActive
            ? "bg-emerald-500/10 border border-transparent ring-1 ring-[var(--border-light)]"
            : "bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-light)]"
        }`}
      >
        {/* Stacked-cards badge: the family badge sits on top and two ghost
            cards cascade toward the bottom-right at 45°, reading as "a stack
            of masks". The middle card is white and the back card black so
            the stack stays legible even though every fill is dark. */}
        {/* Stacked-cards badge: the family badge sits on top and two ghost
            cards cascade toward the bottom-right at 45°, reading as "a stack
            of masks". The middle card is white and the back card black so
            the stack stays legible even though every fill is dark. Ghosts
            overflow a main-badge-sized box so the stack stays vertically
            centered on the row. */}
        <div className="relative w-[18px] h-[18px] shrink-0">
          <div className="absolute left-[5px] top-[5px] w-[16px] h-[16px] rounded-sm border border-white/15 bg-black" />
          <div className="absolute left-[3px] top-[3px] w-[16px] h-[16px] rounded-sm bg-white" />
          <div className="absolute left-[0px] top-[0px] w-full h-full rounded-sm flex items-center justify-center border border-white/20 bg-black text-white text-[10px] font-black tracking-tighter">
            {family === "adjust" ? "A" : family === "bitmap" ? "B" : "V"}
          </div>
        </div>
        <span className="text-[10px] font-bold text-[var(--text-main)] shrink-0 leading-none tracking-tight">
          {FAMILY_PLURAL[family]}
        </span>
        <span className="flex-1 min-w-0 text-[10px] font-semibold text-[var(--text-muted)] truncate leading-none tracking-tight">
          {newestMaskSummary(family, masks)}
        </span>
        <span className="text-[10px] font-bold text-[var(--text-muted)] shrink-0 leading-none tracking-tight">
          {`×${masks.length}`}
        </span>
        {editingActive && (
          <span className="text-[9px] font-semibold text-emerald-500 shrink-0 leading-none">
            Editing
          </span>
        )}
      </div>

      {open && anchorRect && (
        <MaskGroupPanel
          layerId={layerId}
          family={family}
          masks={masks}
          anchorRect={anchorRect}
          editingActive={editingActive}
          onPointerEnter={() => {
            panelHovered.current = true;
            if (closeTimer.current) {
              clearTimeout(closeTimer.current);
              closeTimer.current = null;
            }
          }}
          onPointerLeave={() => {
            panelHovered.current = false;
            armAutoClose();
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
};
