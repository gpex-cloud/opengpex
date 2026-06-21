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
  Lock,
  Trash2,
  Maximize2,
  Scissors,
  Minus,
  VenetianMask,
} from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ImageAsset from "@opengpex/editor/widgets/ImageAsset";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import { useLayerCommands } from "../hooks";
import { VectorMask, BitmapMask } from "@opengpex/editor/core/types";

export const MaskItem = React.memo(
  ({
    layerId,
    mask,
    index,
    onCollapse,
  }: {
    layerId: string;
    mask: VectorMask | BitmapMask;
    index: number;
    onCollapse?: () => void;
  }) => {
    const { activeFrame } = useEditorState();
    const { actions } = useEditorServices();
    const { maskToggle, maskRemove, maskSyncOverlayCmd } = useLayerCommands();

    const isBitmap = "src" in mask;

    return (
      <div
        className="flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] group/mask select-none bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-subtle)] shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
      >
        {onCollapse && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
            className="w-4 h-4 flex items-center justify-center shrink-0 rounded hover:bg-[var(--bg-stage)]/60 transition-colors group/collapse outline-none"
            title="Collapse Masks"
          >
            <Minus
              size={10}
              strokeWidth={3}
              className="text-[var(--text-muted)] group-hover/collapse:text-[var(--text-main)]"
            />
          </button>
        )}
        
        {isBitmap ? (
          <div
            className={`w-[18px] h-[18px] rounded-sm overflow-hidden flex items-center justify-center shrink-0 border border-emerald-500/20 bg-black transition-all ${!mask.enabled ? "opacity-30 grayscale" : "opacity-100"}`}
          >
            {mask.src ? (
              <ImageAsset
                assetId={mask.assetId}
                src={mask.src}
                className="w-full h-full object-cover select-none pointer-events-none"
              />
            ) : (
              <VenetianMask size={10} className="text-emerald-500" />
            )}
          </div>
        ) : (
          <div
            className={`w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border transition-all
              ${mask.inverted
                ? "border-rose-500/20 bg-rose-500/5 text-rose-500"
                : "border-emerald-500/20 bg-emerald-500/5 text-emerald-500"
              }
              ${!mask.enabled ? "opacity-30 grayscale" : "opacity-100"}`}
          >
            {mask.reserved ? (
              <Lock size={10} />
            ) : mask.inverted ? (
              <Scissors size={10} />
            ) : (
              <VenetianMask size={10} />
            )}
          </div>
        )}

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${mask.inverted ? "bg-rose-500" : "bg-emerald-500"} ${!mask.enabled ? "opacity-30" : "opacity-100"}`}
          />
          <span className="text-[10px] font-bold text-[var(--text-main)] truncate select-none leading-none tracking-tight">
            {mask.inverted ? "Inverted " : ""}{isBitmap ? "Bitmap Mask" : "Mask"} #{index + 1}
          </span>
        </div>

        <div className="flex items-center gap-0 opacity-0 group-hover/mask:opacity-100 transition-opacity">
          {!isBitmap && (
            <ActionButton
              icon={<Maximize2 size={11} />}
              onClick={(e) => {
                e.stopPropagation();
                maskSyncOverlayCmd?.execute({ frameId: activeFrame?.id, layerId, maskId: mask.id });
              }}
              variant="glass"
              size="sm"
              className="w-5 h-5"
            />
          )}
          
          {!( "reserved" in mask && mask.reserved ) && (
            <>
              <ActionButton
                icon={mask.enabled ? <Eye size={11} /> : <EyeOff size={11} className="text-rose-500" />}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isBitmap) {
                    actions.adv.layer.bitmapMask.toggle.execute({ frameId: activeFrame?.id, layerId, maskId: mask.id });
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
                    actions.adv.layer.bitmapMask.remove.execute({ frameId: activeFrame?.id, layerId, maskId: mask.id });
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
