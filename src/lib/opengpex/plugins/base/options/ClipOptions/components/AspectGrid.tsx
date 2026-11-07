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

import React from "react";
import { useEditorState, useEditorServices, usePluginSignals } from "@opengpex/editor/core/context";
import { getRegularClipShape } from "@opengpex/editor/core/helpers/selection";
import type { ClipOptionsSignalsMap } from "../commands.d";


export const ASPECT_RATIOS = [
  { label: "FREE", value: undefined },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
];

/**
 * ClipOptionsMain: Integrated persistent component for clipping and canvas operations
 * Includes clip mode switching, ratio adjustment, and WebP export functions

/**
 * AspectGrid: Shared UI for aspect ratio selection
 */
export function AspectGrid({
  activeAspect,
  onSelect,
}: {
  activeAspect: number | undefined;
  onSelect: (val: number | undefined) => void;
}) {
  const { activeFrame } = useEditorState();
  const { geometry } = useEditorServices();
  const { reCanvasActiveSignal } = usePluginSignals<ClipOptionsSignalsMap>();
  const isReCanvas = !!reCanvasActiveSignal.value;
  const clipPoly = (!isReCanvas && activeFrame) ? getRegularClipShape(activeFrame) : undefined;
  const clipBox = isReCanvas ? activeFrame?.canvasClipBox : (clipPoly ? geometry.polygon.polygonToShape(clipPoly) : undefined);
  const isEllipse = clipBox?.type === "circle";
  const isDashed = isEllipse && clipBox?.antiAliased === false;

  return (
    <div className="grid grid-cols-2 gap-1 mb-1.5">
      {ASPECT_RATIOS.map((ratio) => (
        <button
          key={ratio.label}
          onClick={() => onSelect(ratio.value)}
          className={`flex flex-col items-center justify-center p-2 rounded-lg transition-all group/ratio
            ${
              activeAspect === ratio.value
                ? "bg-amber-500/10 border border-amber-500/30 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
                : "hover:bg-[var(--bg-stage)] border border-transparent"
            }
          `}
        >
          <div className="relative mb-1">
            <div
              className={`border-2 mb-0.5 transition-all
              ${isDashed ? "border-dashed" : "border-solid"}
              ${
                activeAspect === ratio.value
                  ? "border-amber-500"
                  : "border-[var(--text-muted)] opacity-30 group-hover/ratio:opacity-100 group-hover/ratio:border-[var(--border-light)]"
              }
            `}
              style={{
                width: 14,
                height: Math.max(4, 14 / (ratio.value || 1)),
                borderRadius: isEllipse ? "50%" : "2px",
              }}
            ></div>
          </div>
          <span
            className={`text-[9px] font-black uppercase tracking-widest
            ${activeAspect === ratio.value ? "text-amber-600 dark:text-amber-400" : "text-[var(--text-muted)]"}
          `}
          >
            {ratio.label}
          </span>
        </button>
      ))}
    </div>
  );
}
