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
import { Scissors, Copy as CopyIcon, ClipboardPaste } from "lucide-react";
import { useEditorState } from "@opengpex/editor/core/context";
import { FancyButton } from "@opengpex/editor/widgets/FancyButton";
import { useClipOptionsCommands } from "../hooks";

/**
 * ClipSelectionActions: Clipboard button group contributed to TOOL_BAR
 * Migrated from LayerPanel to ClipOptions to reinforce semantic consistency of selection operations.
 */
export const ClipSelectionActions = React.memo(function ClipSelectionActions() {
  const { state } = useEditorState();
  const { cutCmd, copyCmd, pasteCmd } = useClipOptionsCommands();
  return (
    <>
      <FancyButton shape="rect" iconOnly
        onClick={() => cutCmd.execute()}
        disabled={state.interaction.interactionMode !== "clip"}
        title={`${cutCmd.name} (${cutCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <Scissors size={13} />
      </FancyButton>
      <FancyButton shape="rect" iconOnly
        onClick={() => copyCmd.execute()}
        disabled={state.interaction.interactionMode !== "clip"}
        title={`${copyCmd.name} (${copyCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <CopyIcon size={13} />
      </FancyButton>
      <FancyButton shape="rect" iconOnly
        onClick={() => pasteCmd.execute(undefined)}
        disabled={false}
        title={`${pasteCmd.name} (${pasteCmd.shortcutLabel})`}
        tooltipPosition="right"
        variant="ghost"
        className="w-6 h-6"
      >
        <ClipboardPaste size={13} />
      </FancyButton>
    </>
  );
});

