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
import { Eye, EyeOff, Trash2 } from "lucide-react";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import { useEditorState, useEditorServices } from "@opengpex/editor/core/context";
import type { AdjustmentMask } from "@opengpex/editor/core/types";
import { summarizeAdjustMask } from "../utils";

/**
 * One row of the layer's grade chain. `index` is the chain position (render
 * order); the list renders newest first like the other mask families, so the
 * number shown is `index + 1` to read as "step N". A confined entry (frozen
 * selection snapshot) shows an amber dot, a whole-layer entry a violet one.
 * Rows only toggle and delete — editing an older step is "delete and
 * re-commit" by design (the new step lands at the chain tail).
 */
export const AdjustMaskItem = React.memo(
  ({ layerId, mask, index }: { layerId: string; mask: AdjustmentMask; index: number }) => {
    const { activeFrame } = useEditorState();
    const { actions } = useEditorServices();
    const confined = !!mask.shape;
    const dim = !mask.enabled ? "opacity-30" : "opacity-100";

    return (
      <div
        className="flex items-center gap-2 px-2 py-1 rounded-md transition-all h-[28px] group/mask select-none shadow-[0_1px_2px_rgba(0,0,0,0.02)] bg-[var(--bg-stage)]/30 hover:bg-[var(--bg-stage)]/60 border border-[var(--border-subtle)]/60 hover:border-[var(--border-subtle)]"
      >
        <div
          className={`w-[18px] h-[18px] rounded-sm flex items-center justify-center shrink-0 border border-violet-500/20 bg-black text-white text-[10px] font-black tracking-tighter transition-all ${dim} ${!mask.enabled ? "grayscale" : ""}`}
        >
          A
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${confined ? "bg-amber-500" : "bg-violet-500"} ${dim}`}
            title={confined ? "Confined to a frozen selection" : "Whole layer"}
          />
          <span
            className="text-[10px] font-bold text-[var(--text-main)] truncate select-none leading-none tracking-tight"
            title={summarizeAdjustMask(mask)}
          >
            {`#${index + 1} ${summarizeAdjustMask(mask)}`}
          </span>
        </div>

        <div className="flex items-center gap-0 transition-opacity opacity-0 group-hover/mask:opacity-100">
          <ActionButton
            icon={mask.enabled ? <Eye size={11} /> : <EyeOff size={11} className="text-rose-500" />}
            onClick={(e) => {
              e.stopPropagation();
              actions.adv.layer.adjustMask.toggle.execute({
                frameId: activeFrame?.id,
                layerId,
                maskId: mask.id,
              });
            }}
            variant="glass"
            size="sm"
            className="w-5 h-5"
          />
          <ActionButton
            icon={<Trash2 size={11} />}
            onClick={(e) => {
              e.stopPropagation();
              actions.adv.layer.adjustMask.remove.execute({
                frameId: activeFrame?.id,
                layerId,
                maskId: mask.id,
              });
            }}
            variant="glass"
            size="sm"
            className="w-5 h-5 hover:text-rose-500"
          />
        </div>
      </div>
    );
  },
);
