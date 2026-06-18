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
        className={`flex items-center gap-1.5 p-1 rounded-md transition-all h-[28px] ${mask.enabled ? "bg-[var(--bg-panel)] shadow-sm" : "opacity-40 grayscale"}`}
      >
        {onCollapse && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
            className="w-4 h-5 flex items-center justify-center shrink-0 hover rounded transition-colors group/collapse outline-none"
            title="Collapse Masks"
          >
            <Minus
              size={10}
              className="text-[var(--text-muted)] group-hover/collapse:text-[var(--text-main)] "
            />
          </button>
        )}
        
        {isBitmap ? (
          <div
            className={`w-5 h-5 rounded-sm overflow-hidden flex items-center justify-center shrink-0 border transition-colors border-emerald-500/20 bg-black`}
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
            className={`w-5 h-5 rounded-sm flex items-center justify-center shrink-0 border transition-colors ${mask.inverted ? "border-rose-500/20 bg-rose-500/5 text-rose-500" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-500"}`}
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
            className={`w-1 h-1 rounded-full shrink-0 ${mask.inverted ? "bg-rose-500" : "bg-emerald-500"}`}
          />
          <div className="text-[9px] font-bold truncate text-[var(--text-main)] uppercase tracking-tighter">
            {isBitmap ? "Bitmap Mask" : "Mask"} #{index + 1}
          </div>
        </div>

        <div className="flex items-center gap-0">
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
                icon={mask.enabled ? <Eye size={11} /> : <EyeOff size={11} />}
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
