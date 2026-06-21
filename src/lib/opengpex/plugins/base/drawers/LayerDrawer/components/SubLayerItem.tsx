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
import { Eye, EyeOff, Lock, Unlock, Minus } from "lucide-react";
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
        className="flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] group/sub select-none bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-subtle)]"
      >
        {onCollapse && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCollapse();
            }}
            className="w-4 h-4 flex items-center justify-center shrink-0 rounded hover:bg-[var(--bg-stage)]/60 transition-colors group/collapse outline-none"
            title="Collapse"
          >
            <Minus size={10} strokeWidth={3} className="text-[var(--text-muted)] group-hover/collapse:text-[var(--text-main)]" />
          </button>
        )}
        <div className={`w-[18px] h-[18px] rounded-sm overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-panel)] shrink-0 flex items-center justify-center transition-all ${!layer.visible ? "opacity-30 grayscale" : "opacity-100"}`}>
          <ImageAsset
            assetId={layer.assetId}
            src={layer.src}
            className="w-full h-full object-cover"
            alt={layer.role}
          />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-[10px] font-bold text-[var(--text-main)] truncate select-none leading-none tracking-tight">
            {layer.role === 'exchange' ? 'Exchange Layer' : layer.role === 'frag' ? 'Fragment Layer' : layer.name}
          </span>
        </div>
        <div className="flex items-center gap-0 opacity-0 group-hover/sub:opacity-100 transition-opacity">
          <ActionButton
            icon={layer.visible ? <Eye size={11} /> : <EyeOff size={11} className="text-rose-500" />}
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
            className="w-5 h-5"
          />
          <ActionButton
            icon={
              layer.locked ? (
                <Lock size={11} className="text-rose-500" />
              ) : (
                <Unlock size={11} />
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
            className="w-5 h-5"
          />
        </div>
      </div>
    );
  },
);
