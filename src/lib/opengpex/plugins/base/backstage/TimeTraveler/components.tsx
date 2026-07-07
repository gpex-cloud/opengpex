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
import { Undo2, Redo2, RotateCcw } from "lucide-react";
import {
  useEditorState,
  useEditorServices,
  usePluginCommands,
} from "@opengpex/editor/core/context";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import DelayedConfirm from "@opengpex/editor/widgets/DelayedConfirm";
import { formatBytes } from "@opengpex/editor/core/helpers/file";

/**
 * TimeTravelAction: Time machine button group contributed to TOOL_BAR
 */
export const TimeTravelAction = React.memo(function TimeTravelAction() {
  const { actions } = useEditorServices();
  const { undoCmd, redoCmd, revertCmd } = usePluginCommands();

  const canUndo = actions.history.canUndo();
  const canRedo = actions.history.canRedo();

  // Remove all outer div layouts, returning purely an array of functional buttons!
  return (
    <>
      <FancyButton iconOnly shape="rect"
        onClick={() => undoCmd?.execute()}
        disabled={!canUndo}
        title={`Undo (${undoCmd?.shortcutLabel || ""})`}
        tooltipPosition="right"
      >
        <Undo2 size={18} />
      </FancyButton>

      <FancyButton iconOnly shape="rect"
        onClick={() => redoCmd?.execute()}
        disabled={!canRedo}
        title={`Redo (${redoCmd?.shortcutLabel || ""})`}
        tooltipPosition="right"
      >
        <Redo2 size={18} />
      </FancyButton>

      <FancyButton iconOnly shape="rect"
        onClick={() => revertCmd?.execute()}
        title={`Revert to Original (${revertCmd?.shortcutLabel || ""})`}
        tooltipPosition="right"
        className="text-rose-500 hover:text-rose-600"
      >
        <RotateCcw size={18} />
      </FancyButton>
    </>
  );
});

/**
 * LocalHistorySettings: Contributed to SETTINGS_FILE_INFO (inside file details)
 * Associated with the current file's storage and historical operations
 */
export const LocalHistorySettings = React.memo(function LocalHistorySettings() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const { purgeCmd } = usePluginCommands();

  const purgeHistory = () => {
    purgeCmd?.execute();
    actions.updateStorageStats();
  };

  return (
    <div className="space-y-3 pt-4 border-t border-zinc-200 dark:border-white/5 px-1">
      <div className="flex justify-between items-end">
        <div className="flex flex-col">
          <span className="text-[8px] font-black text-zinc-500 uppercase tracking-widest mb-1">
            Current History Storage
          </span>
          <span className="text-[12px] font-black text-zinc-900 dark:text-zinc-100 tabular-nums">
            {state.storageUsage
              ? formatBytes(state.storageUsage.totalBytes)
              : "Calculating..."}
          </span>
        </div>
        <DelayedConfirm
          onConfirm={purgeHistory}
          delayTime={1500}
          className="min-w-max"
        >
          <button className="text-[9px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-tight hover:underline py-1 whitespace-nowrap">
            Clear
          </button>
        </DelayedConfirm>
      </div>

      <div className="h-2 w-full bg-zinc-800/10 dark:bg-white/5 rounded-full overflow-hidden flex shadow-inner">
        {state.storageUsage && (
          <div
            className={`h-full transition-all duration-1000 ease-out ${
              state.storageUsage.totalBytes < 1024 * 1024 * 300
                ? "bg-emerald-500"
                : state.storageUsage.totalBytes < 1024 * 1024 * 500
                  ? "bg-amber-500"
                  : "bg-rose-500"
            }`}
            style={{
              width: `${Math.min(100, (state.storageUsage.totalBytes / (1024 * 1024 * 500)) * 100)}%`,
            }}
          />
        )}
      </div>
      <p className="text-[8px] text-zinc-500 font-bold leading-relaxed uppercase opacity-60">
        History snapshots for this session. <br />
        Clearing will release space but remove undo steps.
      </p>
    </div>
  );
});
