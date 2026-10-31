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
import { PanelLeftClose } from "lucide-react";
import {
  useEditorState,
  useEditorServices,
} from "@opengpex/editor/core/context";
import FunctionTabs from "@opengpex/editor/widgets/FunctionTabs";
import { WORKSPACE_GEOMETRY } from "@opengpex/editor/workspace/Workspace.styles";

type DrawerWidthMode = "normal" | "compact";

const MODE_OPTIONS: Array<{ value: DrawerWidthMode; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "compact", label: "Compact" },
];

/**
 * DrawerWidthSettings — Normal/Compact segment control for the fallback width
 * of floating drawer panels.
 *
 * Scope: only drawer plugins that do NOT declare their own preferredWidth are
 * affected. The setting swaps the hard 320px fallback for a 260px compact
 * fallback; explicit plugin widths always win, so panels tuned for their
 * content are never squashed by this control.
 */
export function DrawerWidthSettings() {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const mode: DrawerWidthMode =
    state.ui.drawerWidthMode === "compact" ? "compact" : "normal";

  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-widest pl-1">
        Drawer Width
      </h5>

      <div className="flex flex-col gap-2 p-2.5 rounded-xl bg-[var(--bg-stage)] border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="w-7 h-7 rounded-lg flex-shrink-0 flex items-center justify-center bg-[var(--bg-stage)] text-[var(--text-muted)]">
              <PanelLeftClose size={13} />
            </div>
            <div className="flex flex-col items-start leading-tight text-left">
              <span className="text-[10px] font-black text-[var(--text-main)] uppercase tracking-tight">
                Drawer Panels
              </span>
              <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase">
                Fallback width for panels without a custom size
              </span>
            </div>
          </div>

          <div role="radiogroup" aria-label="Drawer panel width">
            <FunctionTabs
              size="sm"
              className="w-32 shrink-0"
              options={MODE_OPTIONS}
              value={mode}
              onChange={(next) => actions.updateUI({ drawerWidthMode: next })}
            />
          </div>
        </div>

        <span className="text-[8px] text-[var(--text-muted)] font-bold uppercase leading-snug">
          {mode === "compact"
            ? `Compact: ${WORKSPACE_GEOMETRY.PANEL_WIDTH_COMPACT}px`
            : `Normal: ${WORKSPACE_GEOMETRY.PANEL_WIDTH_NORMAL}px`}
        </span>
      </div>
    </div>
  );
}
