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
import { useLayerCommands, useMaskEdit } from "../hooks";
import { VectorMask, BitmapMask } from "@opengpex/editor/core/types";

export const MaskItem = React.memo(
  ({
    layerId,
    mask,
    index,
  }: {
    layerId: string;
    mask: VectorMask | BitmapMask;
    index: number;
  }) => {
    const { activeFrame } = useEditorState();
    const { actions } = useEditorServices();
    const { maskToggle, maskRemove, syncMaskCmd } = useLayerCommands();
    const { maskEditing, toggleMaskEdit } = useMaskEdit();

    const isBitmap = "src" in mask;
    const isEditing =
      isBitmap &&
      maskEditing?.layerId === layerId &&
      maskEditing?.maskId === mask.id;

    return (
      <div
        className={`flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] group/mask select-none shadow-[0_1px_2px_rgba(0,0,0,0.02)] ${
          isEditing
            ? "bg-emerald-500/10 border border-emerald-500/50 ring-1 ring-emerald-500/20"
            : "bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-subtle)]"
        }`}
      >

        {isBitmap ? (
          <div
            className={`w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border border-emerald-500/20 bg-black text-white text-[10px] font-black tracking-tighter transition-all ${!mask.enabled ? "opacity-30 grayscale" : "opacity-100"}`}
          >
            B
          </div>
        ) : (
          <div
            className={`w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border ${
              mask.inverted ? "border-rose-500/20" : "border-emerald-500/20"
            } bg-black text-white text-[10px] font-black tracking-tighter transition-all ${!mask.enabled ? "opacity-30 grayscale" : "opacity-100"}`}
          >
            V
          </div>
        )}

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${mask.inverted ? "bg-rose-500" : "bg-emerald-500"} ${!mask.enabled ? "opacity-30" : "opacity-100"}`}
          />
          <span className="text-[10px] font-bold text-[var(--text-main)] truncate select-none leading-none tracking-tight">
            {"tag" in mask && mask.tag?.toLowerCase() === "drilled"
              ? "Mask Cutouts"
              : (isBitmap && mask.inverted ? "Inverted " : "") + `Mask #${index + 1}`}
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

          {!isBitmap && (
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
                  mask.enabled ? (
                    <Eye size={11} />
                  ) : (
                    <EyeOff size={11} className="text-rose-500" />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (isBitmap) {
                    actions.adv.layer.bitmapMask.toggle.execute({
                      frameId: activeFrame?.id,
                      layerId,
                      maskId: mask.id,
                    });
                  } else {
                    maskToggle.execute({ layerId, maskId: mask.id });
                  }
                }}
                variant="glass"
                size="sm"
                className="w-5 h-5"
              />
              <ActionButton
                icon={<Trash2 size={11} />}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isBitmap) {
                    actions.adv.layer.bitmapMask.remove.execute({
                      frameId: activeFrame?.id,
                      layerId,
                      maskId: mask.id,
                    });
                  } else {
                    maskRemove.execute({ layerId, maskId: mask.id });
                  }
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
