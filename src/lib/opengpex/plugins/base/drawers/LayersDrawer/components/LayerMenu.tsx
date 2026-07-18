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
  SquareStack,
  VenetianMask,
  Trash2,
  MoreVertical,
  Image as ImageIcon,
  Copy,
} from "lucide-react";
import { useEditorServices, usePluginCommands } from "@opengpex/editor/core/context";
import ActionDropdown, {
  ActionOption,
} from "@opengpex/editor/widgets/ActionDropdown";
import type { LayersDrawerCommandsMap } from "../commands.d";

interface LayerMenuProps {
  layerId: string;
  activeFrameId: string;
  hasSubLayers: boolean;
  childLayersLength: number;
  hasMasks: boolean;
  masksLength: number;
  canDelete: boolean;
  isSubLayersExpanded: boolean;
  setIsSubLayersExpanded: (v: boolean) => void;
  isMasksExpanded: boolean;
  setIsMasksExpanded: (v: boolean) => void;
}

export const LayerMenu = React.memo(
  ({
    layerId,
    activeFrameId,
    hasSubLayers,
    childLayersLength,
    hasMasks,
    masksLength,
    canDelete,
    isSubLayersExpanded,
    setIsSubLayersExpanded,
    isMasksExpanded,
    setIsMasksExpanded,
  }: LayerMenuProps) => {
    const { actions } = useEditorServices();
    const { removeCmd, duplicateLayerCmd } = usePluginCommands<LayersDrawerCommandsMap>();

    const options: ActionOption[] = [];

    // Duplicate Layer — always available
    options.push({
      label: "Duplicate Layer",
      value: "duplicate",
      icon: <Copy size={12} />,
    });

    if (hasSubLayers) {
      options.push({
        label: isSubLayersExpanded ? "Hide Sub-layers" : "Show Sub-layers",
        value: isSubLayersExpanded ? "close-sublayers" : "open-sublayers",
        icon: <SquareStack size={12} />,
        description: `(${childLayersLength})`,
      });
    }

    if (hasMasks) {
      options.push({
        label: isMasksExpanded ? "Hide Masks" : "Show Masks",
        value: isMasksExpanded ? "close-masks" : "open-masks",
        icon: <VenetianMask size={12} />,
        description: `(${masksLength})`,
      });
    }

    if (canDelete) {
      options.push({
        label: "Rasterize",
        value: "rasterize",
        icon: <ImageIcon size={12} />,
      });

      options.push({
        divider: true,
      });

      options.push({
        label: "Delete Layer",
        value: "delete",
        icon: <Trash2 size={12} />,
        variant: "danger",
      });
    }

    const handleSelect = (val: string) => {
      if (val === "duplicate") {
        duplicateLayerCmd?.execute({ layerId });
      } else if (val === "open-sublayers") {
        setIsSubLayersExpanded(true);
      } else if (val === "close-sublayers") {
        setIsSubLayersExpanded(false);
      } else if (val === "open-masks") {
        setIsMasksExpanded(true);
      } else if (val === "close-masks") {
        setIsMasksExpanded(false);
      } else if (val === "rasterize") {
        actions.adv.layer.merge.rasterize.execute({ layerId });
      } else if (val === "delete") {
        removeCmd?.execute({ frameId: activeFrameId, layerId });
      }
    };

    if (options.length === 0) return null;

    return (
      <div className="relative ml-0.5">
        <ActionDropdown
          trigger={(isOpen) => (
            <button
              className={`w-6 h-6 flex items-center justify-center rounded-md transition-colors outline-none cursor-pointer focus:outline-none border border-transparent
 ${isOpen ? "bg-[var(--bg-stage)] border-[var(--border-subtle)]" : "hover:bg-[var(--bg-stage)] hover:border-[var(--border-subtle)]"}
`}
            >
              <MoreVertical
                size={12}
                className={`transition-colors ${isOpen ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
              />
            </button>
          )}
          align="right"
          options={options}
          onSelect={handleSelect}
        />
      </div>
    );
  },
);
