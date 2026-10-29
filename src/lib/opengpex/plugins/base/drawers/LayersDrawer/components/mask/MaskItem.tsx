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

/* eslint-disable react/display-name */

"use client";

import React from "react";
import {
  Eye,
  EyeOff,
  Trash2,
  Maximize2,
  Pencil,
} from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import { useLayerCommands, useMaskEdit } from "../../hooks";
import {
  VectorMask,
  BitmapMask,
  AdjustmentMask,
} from "@opengpex/editor/core/types";
import { summarizeAdjustMask } from "../../utils";

/** Which mask family this row belongs to; drives badge, dot, and command routing. */
export type MaskItemFamily = "vector" | "bitmap" | "adjust";

/** Command payload shared by every toggle/remove call. */
interface MaskRowCommands {
  layerId: string;
  maskId: string;
  frameId?: string;
}

/**
 * One mask row, shared by all three mask families (vector / bitmap /
 * adjust). The row is rendered both flat in the layer's masks area (a
 * family with a single member) and as a member row inside the floating
 * group panel, so toggling and deleting always go through the same
 * existing commands regardless of where the row is mounted.
 *
 * Family differences are deliberately kept as small conditional branches:
 * badge letter and tint, status dot, label, and the per-family command
 * endpoints. Adjustment masks additionally show their grade summary and
 * have no per-mask editor (editing an older step is "delete and
 * re-commit" by design); bitmap masks carry a paint-to-erase editing
 * session toggle.
 */
export const MaskItem = React.memo(
  ({
    layerId,
    family,
    mask,
    index,
  }: {
    layerId: string;
    family: MaskItemFamily;
    mask: VectorMask | BitmapMask | AdjustmentMask;
    index: number;
  }) => {
    const { activeFrame } = useEditorState();
    const { actions } = useEditorServices();
    const { maskToggle, maskRemove, syncMaskCmd } = useLayerCommands();
    const { maskEditing, toggleMaskEdit } = useMaskEdit();

    const isAdjust = family === "adjust";
    const isBitmap = family === "bitmap";
    const isVector = family === "vector";

    const inverted = !isAdjust && !!(mask as VectorMask | BitmapMask).inverted;
    const enabled = mask.enabled;
    const dim = !enabled ? "opacity-30" : "opacity-100";

    const isEditing =
      isBitmap &&
      !!maskEditing &&
      maskEditing.layerId === layerId &&
      maskEditing.maskId === mask.id;

    const confined = isAdjust && !!(mask as AdjustmentMask).shape;

    const label = isAdjust
      ? `#${index + 1} ${summarizeAdjustMask(mask as AdjustmentMask)}`
      : "tag" in mask && mask.tag?.toLowerCase() === "drilled"
        ? "Mask Cutouts"
        : (inverted && isBitmap ? "Inverted " : "") + `Mask #${index + 1}`;

    const toggle = (maskId: string) => {
      const payload: MaskRowCommands = {
        frameId: activeFrame?.id,
        layerId,
        maskId,
      };
      if (isAdjust) {
        actions.adv.layer.adjustMask.toggle.execute(payload);
      } else if (isBitmap) {
        actions.adv.layer.bitmapMask.toggle.execute(payload);
      } else {
        maskToggle.execute({ layerId, maskId });
      }
    };

    const remove = (maskId: string) => {
      const payload: MaskRowCommands = {
        frameId: activeFrame?.id,
        layerId,
        maskId,
      };
      if (isAdjust) {
        actions.adv.layer.adjustMask.remove.execute(payload);
      } else if (isBitmap) {
        actions.adv.layer.bitmapMask.remove.execute(payload);
      } else {
        maskRemove.execute({ layerId, maskId });
      }
    };

    const badgeBorder = isAdjust ? "border-violet-500/20" : "border-emerald-500/20";

    return (
      <div
        className={`flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] group/mask select-none shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${
          isEditing
            ? "bg-emerald-500/10 border border-transparent ring-1 ring-[var(--border-light)]"
            : "bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-light)]"
        }`}
      >
        <div
          className={`w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border ${badgeBorder} bg-black text-white text-[10px] font-black tracking-tighter transition-all ${dim} ${
            !enabled && isAdjust ? "grayscale" : ""
          }`}
        >
          {isAdjust ? "A" : isBitmap ? "B" : "V"}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {!isAdjust && (
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${inverted ? "bg-rose-500" : "bg-emerald-500"} ${dim}`}
            />
          )}
          {isAdjust && (
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${confined ? "bg-amber-500" : "bg-violet-500"} ${dim}`}
              title={confined ? "Confined to a frozen selection" : "Whole layer"}
            />
          )}
          <span
            className="text-[10px] font-bold text-[var(--text-main)] truncate select-none leading-none tracking-tight"
            title={isAdjust ? summarizeAdjustMask(mask as AdjustmentMask) : undefined}
          >
            {label}
          </span>
          {isEditing && (
            <span className="text-[9px] font-semibold text-emerald-500 shrink-0 leading-none">
              Editing
            </span>
          )}
        </div>

        <div
          className={`flex items-center gap-0 transition-opacity ${isEditing ? "opacity-100" : "opacity-0 group-hover/mask:opacity-100"}`}
        >
          {isBitmap && (
            <ActionButton
              icon={<Pencil size={11} />}
              onClick={(e) => {
                e.stopPropagation();
                toggleMaskEdit(layerId, mask.id);
              }}
              variant="glass"
              size="sm"
              className={`w-5 h-5 ${isEditing ? "text-emerald-500" : ""}`}
            />
          )}

          {isVector && (
            <ActionButton
              icon={<Maximize2 size={11} />}
              onClick={(e) => {
                e.stopPropagation();
                syncMaskCmd?.execute({
                  frameId: activeFrame?.id,
                  layerId,
                  maskId: mask.id,
                });
              }}
              variant="glass"
              size="sm"
              className="w-5 h-5"
            />
          )}

          {!("reserved" in mask && mask.reserved) && (
            <>
              <ActionButton
                icon={
                  enabled ? (
                    <Eye size={11} />
                  ) : (
                    <EyeOff size={11} className="text-rose-500" />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(mask.id);
                }}
                variant="glass"
                size="sm"
                className="w-5 h-5"
              />
              <ActionButton
                icon={<Trash2 size={11} />}
                onClick={(e) => {
                  e.stopPropagation();
                  remove(mask.id);
                }}
                variant="glass"
                size="sm"
                className="w-5 h-5 hover:text-rose-500"
              />
            </>
          )}
        </div>
      </div>
    );
  },
);
