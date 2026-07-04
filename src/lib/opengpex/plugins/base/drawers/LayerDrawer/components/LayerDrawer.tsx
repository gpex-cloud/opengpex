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

import React, { useRef, useMemo } from "react";
import { Layers, Eye, ScanEye, Plus } from "lucide-react";
import { Reorder } from "framer-motion";
import { useEditorState } from "@opengpex/editor/core/context";
import { Layer, Frame } from "@opengpex/editor/core/types";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import { useLayerCommands, useMaskEditMonitor } from "../hooks";
import { MergeDownIcon, MergeVisibleIcon } from "@opengpex/editor/icons";
import { LayerItem } from "./LayerItem";

export const LayerComponent = React.memo(function LayerComponent() {
  const { activeFrame } = useEditorState();
  if (!activeFrame) return null;
  return <LayerComponentInner activeFrame={activeFrame} />;
});

function LayerComponentInner({ activeFrame }: { activeFrame: Frame }) {
  const { reorder, mergeDown, mergeVisible, toggleAll, isolateSelection, addBlankLayerCmd } =
    useLayerCommands();

  // Monitor mask edit exit conditions (tool switch, mode change, mask deletion)
  useMaskEditMonitor();

  const [isScrolling, setIsScrolling] = React.useState(false);
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
        .filter((l) => !l.parentId),
    [activeFrame.layers],
  );
  const displayLayers = useMemo(() => [...hostLayers].reverse(), [hostLayers]);

  const handleReorder = (newDisplayOrder: Layer[]) => {
    reorder([...newDisplayOrder].reverse());
  };

  return (
    <div className="flex flex-col gap-2 px-2 pt-1 pb-1">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Layers size={12} className="text-indigo-600 dark:text-indigo-400" />
          <div className="flex items-baseline gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.15em] text-[var(--text-muted)] ">
              Layers
            </span>
            <span className="text-[9px] font-bold text-[var(--text-muted)] tabular-nums">
              ({hostLayers.length})
            </span>
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
              mergeDown.execute();
            }}
            icon={<MergeDownIcon size={12} />}
            tooltip="Merge Down"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-teal-500"
          />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              mergeVisible.execute();
            }}
            icon={<MergeVisibleIcon size={12} />}
            tooltip="Flatten Visible"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-teal-500"
          />
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              addBlankLayerCmd?.execute();
            }}
            icon={<Plus size={12} />}
            tooltip="New Layer"
            variant="glass"
            size="sm"
            className="text-[var(--text-muted)] hover:text-emerald-500"
          />
        </div>
      </div>

      <div className="flex flex-col gap-0">
        <div
          onScroll={handleScroll}
          className="flex flex-col min-h-[200px] max-h-[600px] overflow-y-auto px-1 pb-2 custom-scrollbar [mask-image:linear-gradient(to_bottom,transparent,black_8px,black_calc(100%-8px),transparent)]"
        >
          <div
            className={`mt-0 flex flex-col gap-1 ${isScrolling ? "pointer-events-none" : ""}`}
          >
            {hostLayers.length > 0 &&
              hostLayers.length < 5 &&
              Array.from({ length: 5 - hostLayers.length }).map((_, i) => (
                <div
                  key={`placeholder-${i}`}
                  className="h-[36px] rounded-lg border border-dashed border-[var(--border-subtle)] bg-transparent flex items-center px-2 gap-2 transition-colors shrink-0"
                >
                  <div className="w-6 h-6 rounded-md border border-dashed border-[var(--border-subtle)] bg-transparent shrink-0 flex items-center justify-center">
                    <div className="w-1 h-1 rounded-full bg-[var(--border-light)] " />
                  </div>
                  <div className="flex-1 h-1.5 w-16 bg-[var(--border-light)] rounded-full" />
                </div>
              ))}

            <Reorder.Group
              axis="y"
              values={displayLayers}
              onReorder={handleReorder}
              className="flex flex-col gap-1"
            >
              {hostLayers.length === 0 ? (
                <div className="py-12 flex flex-col items-center justify-center border border-dashed border-[var(--border-subtle)] rounded-2xl bg-transparent mb-2">
                  <Layers size={20} className="text-[var(--text-muted)] mb-2" />
                  <p className="text-[9px] font-black text-[var(--text-muted)] uppercase tracking-[0.15em]">
                    Canvas Empty
                  </p>
                </div>
              ) : (
                displayLayers.map((layer) => {
                  const hostIndex = hostLayers.findIndex(
                    (l: Layer) => l.id === layer.id,
                  );
                  return (
                    <LayerItem
                      key={layer.id}
                      layerId={layer.id}
                      index={hostIndex}
                      activeFrameId={activeFrame.id}
                      canDelete={hostLayers.length > 1}
                      isScrolling={isScrolling}
                    />
                  );
                })
              )}
            </Reorder.Group>
          </div>
        </div>
      </div>
    </div>
  );
}
