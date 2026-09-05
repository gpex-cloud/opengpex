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
  Eye, EyeOff,
  Lock, Unlock, FolderOpen, Folder,
  Trash2, Ungroup, MoreVertical,
} from "lucide-react";
import {
  useEditorServices, usePluginCommands,
} from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import EditableLabel from "@opengpex/editor/widgets/EditableLabel";
import ActionDropdown, { ActionOption } from "@opengpex/editor/widgets/ActionDropdown";
import { Layer } from "@opengpex/editor/core/types";
import type { LayersDrawerCommandsMap } from "../commands.d";

interface GroupHeaderProps {
  group: Layer;
  childCount: number;
  activeFrameId: string;
  isActive: boolean;
  hasActiveChild: boolean;
}

export const GroupHeader = React.memo(
  ({ group, childCount, activeFrameId, isActive, hasActiveChild }: GroupHeaderProps) => {
    const { actions } = useEditorServices();
    const {
      visibilityCmd, lockCmd, renameCmd, removeCmd,
      toggleGroupCollapseCmd, ungroupLayersCmd,
    } = usePluginCommands<LayersDrawerCommandsMap>();

    const isCollapsed = group.collapsed ?? false;

    const handleToggleCollapse = (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleGroupCollapseCmd?.execute({ frameId: activeFrameId, groupId: group.id });
    };
    const handleSelect = () => actions.setActiveLayer(activeFrameId, group.id);
    const handleToggleVisibility = (e: React.MouseEvent) => {
      e.stopPropagation();
      visibilityCmd?.execute({ frameId: activeFrameId, layerId: group.id, visible: !group.visible });
    };
    const handleToggleLock = (e: React.MouseEvent) => {
      e.stopPropagation();
      lockCmd?.execute({ frameId: activeFrameId, layerId: group.id, locked: !group.locked });
    };

    const menuOptions: ActionOption[] = [
      { label: "Ungroup", value: "ungroup", icon: <Ungroup size={12} /> },
      { label: "Delete Group", value: "delete", icon: <Trash2 size={12} />, variant: "danger" },
    ];
    const handleMenuSelect = (val: string) => {
      if (val === "ungroup") ungroupLayersCmd?.execute({ groupId: group.id });
      else if (val === "delete") removeCmd?.execute({ frameId: activeFrameId, layerId: group.id });
    };

    return (
      <GroupHeaderView
        group={group}
        childCount={childCount}
        isActive={isActive}
        hasActiveChild={hasActiveChild}
        isCollapsed={isCollapsed}
        activeFrameId={activeFrameId}
        onSelect={handleSelect}
        onToggleCollapse={handleToggleCollapse}
        onToggleVisibility={handleToggleVisibility}
        onToggleLock={handleToggleLock}
        onRename={(name) => renameCmd?.execute({ frameId: activeFrameId, layerId: group.id, name })}
        menuOptions={menuOptions}
        onMenuSelect={handleMenuSelect}
      />
    );
  },
);

// ─── Presentational sub-component ──────────────────────────────────────────────

interface GroupHeaderViewProps {
  group: Layer;
  childCount: number;
  isActive: boolean;
  hasActiveChild: boolean;
  isCollapsed: boolean;
  activeFrameId: string;
  onSelect: () => void;
  onToggleCollapse: (e: React.MouseEvent) => void;
  onToggleVisibility: (e: React.MouseEvent) => void;
  onToggleLock: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  menuOptions: ActionOption[];
  onMenuSelect: (val: string) => void;
}

function GroupHeaderView({
  group, childCount, isActive, hasActiveChild, isCollapsed,
  onSelect, onToggleCollapse, onToggleVisibility, onToggleLock,
  onRename, menuOptions, onMenuSelect,
}: GroupHeaderViewProps) {
  const borderClass = isActive
    ? "bg-indigo-500/15 border border-indigo-500/35 ring-1 ring-indigo-500/20"
    : hasActiveChild
      ? "bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/[0.14]"
      : "bg-amber-500/[0.06] border border-amber-500/15 hover:bg-amber-500/[0.11] hover:border-amber-500/25";

  return (
    <div onClick={onSelect} className={`flex items-center gap-1 px-1.5 h-[26px] rounded-md cursor-pointer transition-all ${borderClass}`}>
      <button
        onClick={onToggleCollapse}
        title={isCollapsed ? "Expand group" : "Collapse group"}
        className="w-5 h-5 flex items-center justify-center rounded transition-colors hover:bg-[var(--bg-stage)] shrink-0 cursor-pointer"
      >
        {isCollapsed
          ? <Folder size={14} className="text-amber-500/80 hover:text-amber-500 transition-colors" />
          : <FolderOpen size={14} className="text-amber-500 hover:text-amber-400 transition-colors" />}
      </button>
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <EditableLabel
          value={group.name}
          onCommit={onRename}
          className={`text-[11px] font-bold truncate transition-colors leading-tight tracking-tight ${isActive ? "text-indigo-600 dark:text-indigo-300" : "text-[var(--text-main)]"}`}
        />
        <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums shrink-0">({childCount})</span>
      </div>
      <div className="flex items-center gap-0 opacity-60 group-hover:opacity-100 transition-opacity shrink-0">
        <ActionButton onClick={onToggleVisibility} icon={group.visible ? <Eye size={11} /> : <EyeOff size={11} className="text-rose-500" />} variant="glass" size="sm" className={`w-5 h-5 ${group.visible ? "" : "text-[var(--text-muted)]"}`} />
        <ActionButton onClick={onToggleLock} icon={group.locked ? <Lock size={11} className="text-amber-500" /> : <Unlock size={11} />} variant="glass" size="sm" className={`w-5 h-5 ${group.locked ? "" : "text-[var(--text-muted)]"}`} />
        <div className="relative ml-0.5">
          <ActionDropdown
            trigger={(isOpen) => (
              <button className={`w-5 h-5 flex items-center justify-center rounded transition-colors outline-none cursor-pointer focus:outline-none border border-transparent ${isOpen ? "bg-[var(--bg-stage)] border-[var(--border-subtle)]" : "hover:bg-[var(--bg-stage)] hover:border-[var(--border-subtle)]"}`}>
                <MoreVertical size={11} className={`transition-colors ${isOpen ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`} />
              </button>
            )}
            align="right"
            options={menuOptions}
            onSelect={onMenuSelect}
          />
        </div>
      </div>
    </div>
  );
}

