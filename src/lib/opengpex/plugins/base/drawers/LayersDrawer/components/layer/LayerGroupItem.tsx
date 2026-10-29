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
  Lock, Unlock, Folder,
  Trash2, Ungroup, MoreVertical,
} from "lucide-react";
import { DragControls } from "framer-motion";
import { usePluginCommands } from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import EditableLabel from "@opengpex/editor/widgets/EditableLabel";
import ActionDropdown, { ActionOption } from "@opengpex/editor/widgets/ActionDropdown";
import { Layer } from "@opengpex/editor/core/types";
import type { LayersDrawerCommandsMap } from "../../commands.d";

interface GroupControlsProps {
  group: Layer;
  childCount: number;
  activeFrameId: string;
  isActive: boolean;
  hasActiveChild: boolean;
  /** Fired synchronously on a collapse-toggle click, before the command
   * commits — lets the list suppress its scrollbar for the animation
   * window (see LayersPanel). */
  onCollapseAnimationStart?: () => void;
}

/**
 * Shared command wiring for both group presentations (collapsed row and
 * expanded cap line): collapse toggle, whole-group visibility/lock, rename,
 * and the ungroup/delete menu.
 */
function useGroupControls({ group, childCount, activeFrameId, onCollapseAnimationStart }: GroupControlsProps) {
  const {
    visibilityCmd, lockCmd, renameCmd, removeCmd,
    toggleGroupCollapseCmd, ungroupLayersCmd,
  } = usePluginCommands<LayersDrawerCommandsMap>();

  const toggleCollapse = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    onCollapseAnimationStart?.();
    toggleGroupCollapseCmd?.execute({ frameId: activeFrameId, groupId: group.id });
  };
  const toggleVisibility = (e: React.MouseEvent) => {
    e.stopPropagation();
    visibilityCmd?.execute({ frameId: activeFrameId, layerId: group.id, visible: !group.visible });
  };
  const toggleLock = (e: React.MouseEvent) => {
    e.stopPropagation();
    lockCmd?.execute({ frameId: activeFrameId, layerId: group.id, locked: !group.locked });
  };
  const rename = (name: string) =>
    renameCmd?.execute({ frameId: activeFrameId, layerId: group.id, name });

  // Ungroup only makes sense with members — an empty group is removed via
  // Delete Group.
  const menuOptions: ActionOption[] = [
    ...(childCount > 0
      ? [{ label: "Ungroup", value: "ungroup", icon: <Ungroup size={12} /> }]
      : []),
    { label: "Delete Group", value: "delete", icon: <Trash2 size={12} />, variant: "danger" },
  ];
  const handleMenuSelect = (val: string) => {
    if (val === "ungroup") ungroupLayersCmd?.execute({ groupId: group.id });
    else if (val === "delete") removeCmd?.execute({ frameId: activeFrameId, layerId: group.id });
  };
  return {
    toggleCollapse, toggleVisibility, toggleLock, rename,
    menuOptions, handleMenuSelect,
  };
}

/** Stacked-cards folder badge matching the mask group badge language:
 * a white folder card on top with a black and a white ghost card
 * cascading bottom-right (inverted vs the dark mask badge so the folder
 * reads bright, like the regular layer folder icon). Ghosts overflow a
 * main-badge-sized box so the stack stays vertically centered. */
function StackedFolderBadge({ dimmed }: { dimmed: boolean }) {
  return (
    <div className={`relative w-full h-full ${dimmed ? "opacity-30 grayscale" : ""}`}>
      <div className="absolute left-[5px] top-[5px] w-[16px] h-[16px] rounded-sm bg-white border border-black/10" />
      <div className="absolute left-[3px] top-[3px] w-[16px] h-[16px] rounded-sm bg-black" />
      <div className="absolute left-[0px] top-[0px] w-full h-full rounded-sm flex items-center justify-center border border-black/20 bg-white text-black">
        <Folder size={11} strokeWidth={2} />
      </div>
    </div>
  );
}

function GroupMenu({
  menuOptions, onMenuSelect,
}: {
  menuOptions: ActionOption[];
  onMenuSelect: (val: string) => void;
}) {
  return (
    <div className="relative ml-0.5">
      <ActionDropdown
        trigger={(isOpen) => (
          <button className={`w-6 h-6 flex items-center justify-center rounded transition-colors outline-none cursor-pointer focus:outline-none border border-transparent ${isOpen ? "bg-[var(--bg-stage)] border-[var(--border-subtle)]" : "hover:bg-[var(--bg-stage)] hover:border-[var(--border-subtle)]"}`}>
            <MoreVertical size={12} className={`transition-colors ${isOpen ? "text-[var(--text-main)]" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`} />
          </button>
        )}
        align="right"
        options={menuOptions}
        onSelect={onMenuSelect}
      />
    </div>
  );
}

type GroupCollapsedRowProps = GroupControlsProps & {
  /** Framer drag controls owned by the wrapping Reorder.Item; the badge
   * acts as the drag handle. */
  dragControls: DragControls;
};

/**
 * Collapsed group presentation: a full-height row in the layer list, styled
 * like the mask group rows (stacked badge + name + trailing count). The
 * stacked badge is a pure drag handle (grab cursor). Expansion lives on the
 * blank stretch between the group name and the visibility buttons.
 */
export const GroupCollapsedRow = React.memo(
  ({ dragControls, ...props }: GroupCollapsedRowProps) => {
    const { group, childCount, isActive, hasActiveChild } = props;
    const {
      toggleCollapse, toggleVisibility, toggleLock, rename,
      menuOptions, handleMenuSelect,
    } = useGroupControls(props);

    // Resting state matches a regular layer row (neutral, no tint); the
    // amber wash appears only while a child layer is the active layer.
    const borderClass = isActive
      ? "bg-indigo-500/15 border border-indigo-500/35 ring-1 ring-indigo-500/20"
      : hasActiveChild
        ? "bg-amber-500/10 border border-amber-500/25 hover:bg-amber-500/[0.14]"
        : "border border-transparent hover:bg-[var(--bg-stage)]/60 hover:border-[var(--border-light)]";

    return (
      <div className={`flex items-center gap-2 px-1.5 h-[32px] rounded-lg transition-all ${borderClass}`}>
        <div
          onPointerDown={(e) => dragControls.start(e)}
          style={{ touchAction: "none" }}
          title="Drag to reorder"
          className="relative w-[18px] h-[18px] shrink-0 cursor-grab active:cursor-grabbing select-none"
        >
          <StackedFolderBadge dimmed={!group.visible} />
        </div>
        <EditableLabel
          value={group.name}
          doubleClick={true}
          onCommit={rename}
          className={`max-w-[40%] text-[11px] font-bold truncate transition-colors leading-tight tracking-tight ${isActive ? "text-indigo-600 dark:text-indigo-300" : "text-[var(--text-main)]"}`}
        />
        {/* Blank stretch between the name and the row actions — click to
            expand. Hit area covers the leftover horizontal space so the
            gesture is easy to land. A hairline mirrors the cap line's rule
            so both group states share the same visual language. */}
        <div
          onClick={toggleCollapse}
          title="Expand group"
          className="flex-1 min-w-0 self-stretch cursor-pointer flex items-center"
        >
          <div className="w-full h-px bg-amber-500/20" />
        </div>
        <span className="text-[10px] font-bold text-[var(--text-muted)] tabular-nums shrink-0 leading-none">{`×${childCount}`}</span>
        <div className="flex items-center gap-0 opacity-60 group-hover:opacity-100 transition-opacity shrink-0">
          <ActionButton onClick={toggleVisibility} icon={group.visible ? <Eye size={12} /> : <EyeOff size={12} className="text-rose-500" />} variant="glass" size="sm" className={`w-6 h-6 ${group.visible ? "" : "text-[var(--text-muted)]"}`} />
          <ActionButton onClick={toggleLock} icon={group.locked ? <Lock size={12} className="text-amber-500" /> : <Unlock size={12} />} variant="glass" size="sm" className={`w-6 h-6 ${group.locked ? "" : "text-[var(--text-muted)]"}`} />
          <GroupMenu menuOptions={menuOptions} onMenuSelect={handleMenuSelect} />
        </div>
      </div>
    );
  },
);

type GroupCapLineProps = GroupControlsProps & { dragControls: DragControls };

/**
 * Expanded group presentation: a slim annotation line instead of a full
 * layer row — collapse chevron, the group name as an amber chip, the member
 * count, then a hairline rule running to the panel edge so the group reads
 * as a bracket around the children rendered below it. Group-level actions
 * (visibility, lock, ungroup/delete) appear on hover only.
 */
export const GroupCapLine = React.memo(
  ({ dragControls, ...props }: GroupCapLineProps) => {
    const { group, childCount, isActive, hasActiveChild } = props;
    const {
      toggleCollapse, toggleVisibility, toggleLock, rename,
      menuOptions, handleMenuSelect,
    } = useGroupControls(props);

    const chipClass = hasActiveChild
      ? "bg-amber-500/15 text-amber-500"
      : isActive
        ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300"
        : "bg-amber-500/[0.08] text-[var(--text-main)]";

    return (
      // Collapse-on-click lives ONLY on the hairline segment right of the
      // name. The name chip (double-click rename), the drag grip, and the
      // action buttons all opt out so their own gestures never fold the
      // group.
      <div className="group/cap relative flex items-center gap-1.5 pl-1 pr-2.5 mt-0.5 h-[20px] select-none">
        {/* Double-line grip: press-and-move reorders the whole group
            (surface + children). Clicking it does nothing. */}
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            dragControls.start(e);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{ touchAction: "none" }}
          title="Drag to reorder"
          className="self-stretch flex items-start pt-1 pl-1 pr-1 cursor-grab active:cursor-grabbing"
        >
          <div className="flex flex-col gap-[2px]">
            <span className="block w-2.5 h-px bg-[var(--text-muted)]/70" />
            <span className="block w-2.5 h-px bg-[var(--text-muted)]/70" />
            <span className="block w-2.5 h-px bg-[var(--text-muted)]/70" />
          </div>
        </div>
        {/* The chip opts out of the line's collapse-click so double-click
            rename works (single click must not fold the group). */}
        <span onClick={(e) => e.stopPropagation()}>
          <EditableLabel
            value={group.name}
            doubleClick={true}
            onCommit={rename}
            className={`px-1.5 h-[16px] rounded text-[10px] font-bold leading-none tracking-tight truncate max-w-[120px] transition-colors cursor-text ${chipClass}`}
          />
        </span>
        <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums shrink-0 leading-none">{`×${childCount}`}</span>
        {/* The rule runs all the way to the panel edge and is the ONLY
            collapse-click target on the line; the action buttons hover in
            above it (absolutely positioned, right-aligned) and cover it
            instead of cutting it short. */}
        <div
          onClick={toggleCollapse}
          title="Collapse group"
          className="flex-1 self-stretch cursor-pointer flex items-center"
        >
          <div className="w-full h-px bg-amber-500/20" />
        </div>
        <div
          onClick={(e) => e.stopPropagation()}
          // Opaque composite of the group surface color (95% panel + 5%
          // black/white) so the strip erases the hairline under the buttons
          // while blending seamlessly with the surrounding surface. A
          // translucent overlay here would stack with the surface tint and
          // read darker.
          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0 px-0.5 rounded bg-[color-mix(in_srgb,var(--bg-panel)_95%,black)] dark:bg-[color-mix(in_srgb,var(--bg-panel)_95%,white)] opacity-0 group-hover/cap:opacity-100 transition-opacity"
        >
          <ActionButton onClick={toggleVisibility} icon={group.visible ? <Eye size={12} /> : <EyeOff size={12} className="text-rose-500" />} variant="glass" size="sm" className={`w-6 h-6 ${group.visible ? "" : "text-[var(--text-muted)]"}`} />
          <ActionButton onClick={toggleLock} icon={group.locked ? <Lock size={12} className="text-amber-500" /> : <Unlock size={12} />} variant="glass" size="sm" className={`w-6 h-6 ${group.locked ? "" : "text-[var(--text-muted)]"}`} />
          <GroupMenu menuOptions={menuOptions} onMenuSelect={handleMenuSelect} />
        </div>
      </div>
    );
  },
);
