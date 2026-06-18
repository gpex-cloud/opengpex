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
import { Eye, EyeOff, Lock, Unlock, ChevronLeft } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ImageAsset from "@opengpex/editor/widgets/ImageAsset";
import { useLayerCommands } from "../hooks";
import { useEditorState } from "@opengpex/editor/core/context";

export const SubLayerItem = React.memo(
  ({
    layerId,
    onCollapse,
  }: {
    layerId: string;
    index: number;
    onCollapse?: () => void;
  }) => {
    const { activeFrame } = useEditorState();
    const layer = activeFrame?.layers.byId[layerId];
    const { visibilityCmd, lockCmd } = useLayerCommands();

    if (!layer) return null;

    return (
      <div
        className={`flex items-center gap-1.5 px-1 py-0.5 rounded transition-all h-[24px] group/sub ${layer.visible ? "" : "opacity-35 grayscale"}`}
      >
        {onCollapse && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
            className="w-3.5 h-3.5 flex items-center justify-center shrink-0 rounded transition-colors group/collapse outline-none opacity-40 hover:opacity-100"
            title="Collapse"
          >
            <ChevronLeft size={9} className="text-[var(--text-muted)]" />
          </button>
        )}
        <div className="w-4 h-4 rounded-sm overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-stage)] shrink-0">
          <ImageAsset
            assetId={layer.assetId}
            src={layer.src}
            className="w-full h-full object-cover"
            alt={layer.role}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[9px] font-semibold truncate text-[var(--text-muted)] uppercase tracking-tight">
            {layer.role}
          </div>
        </div>
        <div className="flex items-center gap-0 opacity-0 group-hover/sub:opacity-100 transition-opacity">
          <ActionButton
            icon={layer.visible ? <Eye size={10} /> : <EyeOff size={10} />}
            onClick={(e) => {
              e.stopPropagation();
              visibilityCmd?.execute({
                frameId: activeFrame!.id,
                layerId: layer.id,
                visible: !layer.visible,
              });
            }}
            variant="glass"
            size="sm"
            className="w-4 h-4"
          />
          <ActionButton
            icon={
              layer.locked ? (
                <Lock size={10} className="text-rose-500" />
              ) : (
                <Unlock size={10} />
              )
            }
            onClick={(e) => {
              e.stopPropagation();
              lockCmd?.execute({
                frameId: activeFrame!.id,
                layerId: layer.id,
                locked: !layer.locked,
              });
            }}
            variant="glass"
            size="sm"
            className="w-4 h-4"
          />
        </div>
      </div>
    );
  },
);
