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

import React, { useRef, useMemo, useState } from "react";
import {
  Layers,
  Eye,
  ScanEye,
  CirclePlus,
  ChevronRight,
  ChevronDown,
  Merge,
  FolderPlus,
} from "lucide-react";
import { Reorder, motion, useDragControls, type DragControls } from "framer-motion";
import {
  usePluginCommands,
  usePluginSignals,
} from "@opengpex/editor/core/context";
import { Layer, Frame } from "@opengpex/editor/core/types";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import ActionDropdown from "@opengpex/editor/widgets/ActionDropdown";
import { useLayerCommands, useMaskEditMonitor, useUnionMerge } from "../hooks";
import { MergeVisibleIcon } from "@opengpex/editor/icons";
import { LayerItem } from "./layer/LayerItem";
import { GroupCollapsedRow, GroupCapLine } from "./layer/LayerGroupItem";
import { LayerPropsBar } from "./LayerPropsBar";
import type {
  LayersDrawerCommandsMap,
  LayersDrawerSignalsMap,
} from "../commands.d";

interface LayersPanelProps {
  activeFrame: Frame;
  activeLayerId?: string;
  activeLayerHostId?: string;
  onViewSwitch?: (view: string) => void;
}

export function LayersPanel({
  activeFrame,
  activeLayerId,
  activeLayerHostId,
  onViewSwitch,
}: LayersPanelProps) {
  const {
    reorder,
    mergeVisible,
    toggleAll,
    isolateSelection,
    addBlankLayerCmd,
  } = useLayerCommands();

  const { createGroupCmd } = usePluginCommands<LayersDrawerCommandsMap>();

  // Monitor mask edit exit conditions (tool switch, mode change, mask deletion)
  useMaskEditMonitor();

  // ─── Union merge multi-selection (encapsulated in hook) ───────────────────────
  const {
    unionSelection,
    unionStatus,
    canUnionMerge,
    toggleUnionMark,
    handleUnionMerge,
  } = useUnionMerge(activeFrame);

  // Read showSubLayers signal once in parent — pass value to children
  const { showSubLayersSignal } = usePluginSignals<LayersDrawerSignalsMap>();
  const showSubLayers = showSubLayersSignal?.value ?? false;

  // Blend & Opacity section collapse (collapsed by default)
  const [blendCollapsed, setBlendCollapsed] = useState(true);

  const [isScrolling, setIsScrolling] = React.useState(false);
  // While a group expand/collapse animation plays, the list height changes
  // every frame; the browser re-evaluates scrollbar visibility per frame and
  // any intermediate frame that crosses the overflow threshold paints the
  // scrollbar for a single frame ("scrollbar flash"). Suppress scrolling for
  // the animation window so the scrollbar is computed once, on the settled
  // layout. Hidden rows are still clickable-free for 220ms at worst.
  const [collapseAnimGuard, setCollapseAnimGuard] = React.useState(false);
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);

  const handleScroll = () => {
    if (!isScrolling) setIsScrolling(true);
    if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    scrollTimeout.current = setTimeout(() => {
      setIsScrolling(false);
    }, 150);
  };

  const hostLayers = useMemo(
    () =>
      activeFrame.layers.order
        .map((id) => activeFrame.layers.byId[id])
        .filter((l) => !l.hostId),
    [activeFrame.layers],
  );

  // Non-group host layers for count display (exclude group layers from user-facing count)
  const nonGroupHostLayers = useMemo(
    () => hostLayers.filter((l) => l.type !== "group"),
    [hostLayers],
  );

  // Top-level display items: host layers that are NOT grouped (no groupId) — includes group layers themselves
  const topLevelLayers = useMemo(
    () => hostLayers.filter((l) => !l.groupId),
    [hostLayers],
  );
  const displayLayers = useMemo(
    () => [...topLevelLayers].reverse(),
    [topLevelLayers],
  );

  // Group membership map: groupId → child layers (non-host sub-layers excluded)
  const groupChildrenMap = useMemo(() => {
    const map = new Map<string, Layer[]>();
    for (const layer of hostLayers) {
      if (layer.groupId) {
        const existing = map.get(layer.groupId);
        if (existing) existing.push(layer);
        else map.set(layer.groupId, [layer]);
      }
    }
    return map;
  }, [hostLayers]);

  // All group layers — used for "Move to Group" menu options
  const availableGroups = useMemo(
    () =>
      hostLayers
        .filter((l) => l.type === "group")
        .map((l) => ({ id: l.id, name: l.name })),
    [hostLayers],
  );

  // Pre-compute host index map for O(1) lookups (avoids O(N²) findIndex in render loop)
  const hostIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    hostLayers.forEach((l, i) => map.set(l.id, i));
    return map;
  }, [hostLayers]);

  // Layer-sized rows available for the min-slot fill: a collapsed group row
  // counts like a layer, but an expanded group's cap line does not — only
  // its child rows do. Otherwise the cap line would eat one placeholder slot.
  const renderedRowCount = useMemo(
    () =>
      displayLayers.reduce((n, l) => {
        if (l.type === "group") {
          if (!(l.collapsed ?? false)) {
            return n + (groupChildrenMap.get(l.id)?.length ?? 0);
          }
        }
        return n + 1;
      }, 0),
    [displayLayers, groupChildrenMap],
  );

  // Pre-compute child layers map for all host layers
  const childLayersMap = useMemo(() => {
    const map = new Map<string, Layer[]>();
    const allLayers = activeFrame.layers.order.map(
      (id) => activeFrame.layers.byId[id],
    );
    for (const layer of allLayers) {
      if (layer.hostId) {
        const existing = map.get(layer.hostId);
        if (existing) {
          existing.push(layer);
        } else {
          map.set(layer.hostId, [layer]);
        }
      }
    }
    return map;
  }, [activeFrame.layers]);

  const handleReorder = (newDisplayOrder: Layer[], childrenOverrides?: Map<string, Layer[]>) => {
    // Reconstruct the full host-layer order from the top-level display order.
    // For each group layer, insert its children right after it (preserving
    // their internal order, or the freshly dragged order passed in
    // childrenOverrides).
    const fullHostOrder: Layer[] = [];
    for (const layer of [...newDisplayOrder].reverse()) {
      fullHostOrder.push(layer);
      if (layer.type === "group") {
        const children =
          childrenOverrides?.get(layer.id) ?? groupChildrenMap.get(layer.id);
        if (children) fullHostOrder.push(...children);
      }
    }
    reorder(fullHostOrder);
  };

  // Suppress the list scrollbar for the window of a group expand/collapse
  // animation: the browser re-evaluates scrollbar visibility every frame
  // and intermediate animation frames can cross the overflow threshold,
  // painting the scrollbar for a single frame. Started synchronously from
  // the toggle click so the guard is active on the very first committed
  // frame.
  const collapseGuardTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const startCollapseGuard = React.useCallback(() => {
    if (collapseGuardTimerRef.current) clearTimeout(collapseGuardTimerRef.current);
    setCollapseAnimGuard(true);
    collapseGuardTimerRef.current = setTimeout(() => setCollapseAnimGuard(false), 220);
  }, []);

  // Renders one group-child layer row; shared by the expanded group block.
  const renderChild = (child: Layer) => (
    <LayerItem
      key={child.id}
      layerId={child.id}
      layer={child}
      index={hostIndexMap.get(child.id) ?? 0}
      activeFrameId={activeFrame.id}
      canvasSize={activeFrame.canvas}
      isActive={
        child.id === activeLayerId || activeLayerHostId === child.id
      }
      canDelete={hostLayers.length > 1}
      isScrolling={isScrolling}
      childLayers={childLayersMap.get(child.id) || emptyChildLayers}
      showSubLayers={showSubLayers}
      isMarked={unionSelection.includes(child.id)}
      onToggleMarking={toggleUnionMark}
      markedColor={unionStatus}
      availableGroups={availableGroups}
    />
  );


  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1 overflow-hidden">
      <motion.div
        layout="position"
        className="flex items-center justify-between h-6 shrink-0"
      >
        <div className="flex items-center gap-2">
          <Layers size={12} className="text-indigo-600 dark:text-indigo-400" />
          <ActionDropdown
            options={[
              { value: "layers", label: "Layers" },
              { value: "channels", label: "Channels" },
            ]}
            onSelect={(val) => onViewSwitch?.(val)}
            trigger={(isOpen) => (
              <div className="flex items-center gap-1 group cursor-pointer">
                <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-main)] group-hover transition-colors">
                  Layers
                </span>
                <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums">
                  ({nonGroupHostLayers.length})
                </span>
                <ChevronDown
                  size={10}
                  className={`text-[var(--text-muted)] transition-transform duration-200 group-hover ${isOpen ? "rotate-180" : ""}`}
                />
              </div>
            )}
          />
          <div className="flex items-center gap-0.5">
            <ActionButton
              onClick={(e) => {
                e.stopPropagation();
                addBlankLayerCmd?.execute();
              }}
              icon={<CirclePlus size={12} />}
              tooltip="New Layer"
              variant="glass"
              size="sm"
              className="text-[var(--text-muted)] hover:text-emerald-500"
            />
            <ActionButton
              onClick={(e) => {
                e.stopPropagation();
                createGroupCmd?.execute(undefined);
              }}
              icon={<FolderPlus size={12} />}
              tooltip="New Group"
              variant="glass"
              size="sm"
              className="text-[var(--text-muted)] hover:text-amber-500"
            />
          </div>
        </div>
        <div className="flex items-center">
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              toggleAll.execute();
            }}
            icon={<Eye size={12} />}
            tooltip="Toggle All"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] "
          />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              isolateSelection();
            }}
            icon={<ScanEye size={12} />}
            tooltip="Isolate Selection"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-[var(--text-main)] "
          />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              handleUnionMerge();
            }}
            icon={<Merge size={12} className="rotate-180" />}
            tooltip={
              canUnionMerge
                ? `Union Merge (${unionSelection.length})`
                : "Union Merge"
            }
            variant="glass"
            size="sm"
            disabled={!canUnionMerge}
            className={
              canUnionMerge
                ? unionStatus === "green"
                  ? "text-emerald-400 hover:text-emerald-300"
                  : unionStatus === "amber"
                    ? "text-amber-400 hover:text-amber-300"
                    : "text-rose-400 hover:text-rose-300"
                : "text-[var(--text-muted)] opacity-40 cursor-not-allowed"
            }
          />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              mergeVisible.execute();
            }}
            icon={<MergeVisibleIcon size={12} />}
            tooltip="Merge Visible"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-teal-500"
          />
        </div>
      </motion.div>

      <div className="flex flex-col gap-0">
        <div
          onScroll={handleScroll}
          className={`flex flex-col min-h-[200px] max-h-[396px] px-1 pb-1 custom-scrollbar [mask-image:linear-gradient(to_bottom,transparent,black_4px,black_calc(100%-4px),transparent)] ${collapseAnimGuard ? "overflow-y-hidden" : "overflow-y-auto"}`}
        >
          <div
            className={`pt-1 flex flex-col gap-0.5 ${isScrolling ? "pointer-events-none" : ""}`}
          >
            {hostLayers.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center border border-dashed border-[var(--border-subtle)] rounded-2xl bg-transparent mb-2">
                <Layers size={20} className="text-[var(--text-muted)] mb-2" />
                <p className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-[0.15em]">
                  Canvas Empty
                </p>
              </div>
            ) : (
              <>
                {renderedRowCount < 6 &&
                  Array.from({ length: 6 - renderedRowCount }).map(
                    (_, i) => (
                      <div
                        key={`placeholder-${i}`}
                        className="h-[32px] rounded-lg border border-dashed border-[var(--border-subtle)] bg-transparent flex items-center px-2 gap-2 transition-colors shrink-0"
                      >
                        <div className="w-[24px] h-[24px] rounded-md border border-dashed border-[var(--border-subtle)] bg-transparent shrink-0 flex items-center justify-center">
                          <div className="w-1 h-1 rounded-full bg-[var(--border-light)] " />
                        </div>
                        <div className="flex-1 h-1.5 w-16 bg-[var(--border-light)] rounded-full" />
                      </div>
                    ),
                  )}

                <Reorder.Group
                  axis="y"
                  values={displayLayers}
                  onReorder={handleReorder}
                  className="flex flex-col gap-0.5"
                >
                  {displayLayers.map((layer) => {
                    // ── Group layer: collapsed = a mask-group-style row;
                    // expanded = a slim cap line over a gray surface holding
                    // the children. The group itself never renders as a
                    // LayerItem. ──
                    if (layer.type === "group") {
                      const groupChildren =
                        groupChildrenMap.get(layer.id) || emptyChildLayers;
                      const isCollapsed = layer.collapsed ?? false;
                      const hasActiveChild = groupChildren.some(
                        (cl) =>
                          cl.id === activeLayerId ||
                          activeLayerHostId === cl.id,
                      );
                      const groupProps = {
                        group: layer,
                        childCount: groupChildren.length,
                        activeFrameId: activeFrame.id,
                        isActive: layer.id === activeLayerId,
                        hasActiveChild,
                        onCollapseAnimationStart: startCollapseGuard,
                      };

                      return (
                        <GroupReorderItem
                          // Key includes the collapsed state: collapsing/
                          // expanding remounts the entry instead of letting
                          // Framer layout-animate the shared Reorder.Item
                          // from the expanded block height down to the row
                          // (that remount-squash is the visible "stretch").
                          key={`${layer.id}:${isCollapsed ? "c" : "e"}`}
                          layer={layer}
                          renderContent={(dragControls) =>
                            isCollapsed ? (
                              <GroupCollapsedRow
                                {...groupProps}
                                dragControls={dragControls}
                              />
                            ) : (
                              <>
                                <div className="rounded-lg bg-black/[0.05] dark:bg-white/[0.05] my-0.5 py-0.5">
                                  <GroupCapLine {...groupProps} dragControls={dragControls} />
                                  {groupChildren.length > 0 && (
                                    <Reorder.Group
                                  axis="y"
                                  values={[...groupChildren].reverse()}
                                  onReorder={(newChildren) =>
                                    handleReorder(
                                      displayLayers,
                                      new Map([[layer.id, [...newChildren].reverse()]]),
                                    )
                                  }
                                  className="pb-0.5 flex flex-col gap-0.5"
                                >
                                  {[...groupChildren].reverse().map((child) => renderChild(child))}
                                </Reorder.Group>
                                  )}
                                  {groupChildren.length === 0 && (
                                    <div className="pl-1 pr-0 pb-0.5 text-[10px] font-semibold text-[var(--text-muted)] leading-none tracking-tight">
                                      Empty group
                                    </div>
                                  )}
                                </div>
                              </>
                            )
                          }
                        />
                      );
                    }

                    // ── Regular (ungrouped) layer ──
                    return (
                      <LayerItem
                        key={layer.id}
                        layerId={layer.id}
                        layer={layer}
                        index={hostIndexMap.get(layer.id) ?? 0}
                        activeFrameId={activeFrame.id}
                        canvasSize={activeFrame.canvas}
                        isActive={
                          layer.id === activeLayerId ||
                          activeLayerHostId === layer.id
                        }
                        canDelete={hostLayers.length > 1}
                        isScrolling={isScrolling}
                        childLayers={
                          childLayersMap.get(layer.id) || emptyChildLayers
                        }
                        showSubLayers={showSubLayers}
                        isMarked={unionSelection.includes(layer.id)}
                        onToggleMarking={toggleUnionMark}
                        markedColor={unionStatus}
                        availableGroups={availableGroups}
                      />
                    );
                  })}
                </Reorder.Group>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ─── Divider ─── */}
      <div className="border-t border-[var(--border-subtle)] dark:border-white/10" />

      {/* ─── Blend & Opacity Section (collapsible, default collapsed) ─── */}
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => setBlendCollapsed((prev) => !prev)}
          onMouseDown={(e) => e.preventDefault()}
          className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-[var(--bg-stage)]/50 transition-colors w-full text-left"
        >
          {blendCollapsed ? (
            <ChevronRight
              size={10}
              className="text-[var(--text-muted)] shrink-0"
            />
          ) : (
            <ChevronDown
              size={10}
              className="text-[var(--text-muted)] shrink-0"
            />
          )}
          <span className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-wide">
            Blend & Opacity
          </span>
        </button>
        {!blendCollapsed && <LayerPropsBar />}
      </div>
    </div>
  );
}

// Stable empty array reference to prevent unnecessary React.memo invalidation
const emptyChildLayers: Layer[] = [];

/**
 * Collapsed group row wrapped in its own Reorder.Item. Dragging is started
 * exclusively from the stacked badge inside GroupCollapsedRow (dragListener
 * is off), so row clicks stay clean and the badge doubles as the grab
 * handle — mirroring how a regular layer's thumbnail starts its drag.
 */
/**
 * Unified Reorder.Item wrapper for both group presentations. Dragging is
 * always gesture-started (dragListener off) from a handle inside the
 * content — the collapsed row's stacked badge or the expanded cap line's
 * grip — so the wrapper carries no click/drag discrimination of its own.
 * No layout-transition overrides: order swaps animate with the same default
 * layout animation as regular layer rows.
 */
function GroupReorderItem({
  layer,
  renderContent,
}: {
  layer: Layer;
  renderContent: (dragControls: DragControls) => React.ReactNode;
}) {
  const dragControls = useDragControls();
  return (
    <Reorder.Item
      value={layer}
      dragListener={false}
      dragControls={dragControls}
      className="list-none"
    >
      {renderContent(dragControls)}
    </Reorder.Item>
  );
}


