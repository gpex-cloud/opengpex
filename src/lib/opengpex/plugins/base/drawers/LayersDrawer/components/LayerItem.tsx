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

import React, { useRef, useEffect } from "react";
import { Eye, EyeOff, Lock, Unlock, Maximize2 } from "lucide-react";
import { Motion } from "@opengpex/editor/core/motion";
import {
  Reorder,
  useDragControls,
  motion,
  AnimatePresence,
} from "framer-motion";
import {
  useEditorServices,
  usePluginCommands,
} from "@opengpex/editor/core/context";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import EditableLabel from "@opengpex/editor/widgets/EditableLabel";
import ImageAsset from "@opengpex/editor/widgets/ImageAsset";
import Tooltip from "@opengpex/editor/widgets/Tooltip";
import { Layer, VectorMask, BitmapMask } from "@opengpex/editor/core/types";
import { SubLayerItem } from "./SubLayerItem";
import { MaskItem } from "./MaskItem";
import { LayerMenu } from "./LayerMenu";
import type { LayersDrawerCommandsMap } from "../commands.d";

interface LayerItemProps {
  layerId: string;
  layer: Layer;
  index: number;
  activeFrameId: string;
  isActive: boolean;
  canDelete: boolean;
  isScrolling?: boolean;
  childLayers: Layer[];
  showSubLayers: boolean;
}

export const LayerItem = React.memo(
  ({
    layer,
    index,
    activeFrameId,
    isActive,
    canDelete,
    isScrolling,
    childLayers,
    showSubLayers,
  }: LayerItemProps) => {
    const { actions } = useEditorServices();
    const {
      visibilityCmd,
      lockCmd,
      renameCmd,
      syncOverlayCmd,
    } = usePluginCommands<LayersDrawerCommandsMap>();

    const containerRef = useRef<HTMLDivElement>(null);
    const dragControls = useDragControls();
    const [isMasksExpanded, setIsMasksExpanded] = React.useState(false);
    const [isSubLayersExpanded, setIsSubLayersExpanded] = React.useState(false);

    const hasSubLayers = childLayers.length > 0 && showSubLayers;
    // Only show sub-layers dot if there are non-internal (exchange/frag) child layers
    const hasVisibleSubLayersDot = childLayers.some(cl => cl.role !== 'exchange' && cl.role !== 'frag') && showSubLayers;
    const hasMasks = !!(
      (layer.vectorMasks && layer.vectorMasks.length > 0) ||
      (layer.bitmapMasks && layer.bitmapMasks.length > 0)
    );

    useEffect(() => {
      if (isActive && containerRef.current) {
        Motion.to(containerRef.current, {
          scale: 1.01,
          duration: 0.3,
          ease: "power2.out",
        });
      } else if (containerRef.current) {
        Motion.to(containerRef.current, {
          scale: 1,
          duration: 0.2,
        });
      }
    }, [isActive]);

    return (
      <Reorder.Item
        value={layer}
        dragListener={false}
        dragControls={dragControls}
        id={layer.id}
      >
        <motion.div
          layout="position"
          className={`group/layer relative flex items-center h-[36px] cursor-pointer transition-opacity ${isScrolling ? "opacity-90" : "opacity-100"}`}
          onClick={() => actions.setActiveLayer(activeFrameId, layer.id)}
          onMouseEnter={() => {
            if (isScrolling) return;
            actions.setInteraction({ hoveredLayerId: layer.id });
          }}
          onMouseLeave={() => {
            if (isScrolling) return;
            actions.setInteraction({ hoveredLayerId: null });
          }}
        >
          <div
            ref={containerRef}
            className={`absolute top-0 bottom-0 right-0 left-0 rounded-lg transition-all duration-200 pointer-events-none
 ${
   isActive
     ? "bg-[var(--bg-stage)] ring-1 ring-[var(--border-light)]"
     : "ring-1 ring-transparent group-hover/layer:bg-[var(--bg-stage)] group-hover/layer:ring-[var(--border-light)]"
 }
`}
          >
            {isActive && (
              <div
                className={`absolute left-0 top-2 bottom-2 w-0.5 bg-emerald-500 rounded-r-full shadow-[0_0_8px_rgba(16,185,129,0.4)] transition-all duration-300 ${isScrolling ? "opacity-50" : "opacity-100"}`}
              />
            )}
          </div>

          <div className="relative z-10 flex-1 flex items-center h-full px-1.5 gap-2 group/content">
            <div
              onPointerDown={(e) => dragControls.start(e)}
              style={{ touchAction: "none" }}
              className={`relative w-[26px] h-[26px] shrink-0 rounded-md border overflow-hidden flex items-center justify-center transition-all cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-[var(--border-light)] select-none
 ${
   isActive
     ? "border-[var(--border-light)] bg-[var(--bg-panel)] shadow-sm"
     : "border-[var(--border-subtle)] bg-[var(--bg-stage)]/40 group-hover/layer:border-[var(--border-light)] group-hover/layer group-hover/layer:shadow-sm"
 }
 ${!layer.visible ? "opacity-30 grayscale" : "opacity-100"}
`}
            >
              {layer.type === "color" ? (
                <div
                  className="w-full h-full flex items-center justify-center font-black text-[16px] tracking-tighter"
                  style={{
                    background:
                      "linear-gradient(315deg, #f472b6, #a78bfa, #38bdf8)",
                    color: "#ffffff",
                  }}
                >
                  C
                </div>
              ) : layer.type === "paint" ? (
                <div
                  className="w-full h-full flex items-center justify-center font-black text-[16px] tracking-tighter"
                  style={{
                    background:
                      "linear-gradient(45deg, #ef4444, #f59e0b, #10b981, #3b82f6, #8b5cf6)",
                    color: "#ffffff",
                  }}
                >
                  P
                </div>
              ) : layer.type === "text" ? (
                <div
                  className="w-full h-full flex items-center justify-center font-black text-[16px] tracking-tighter ring-1 ring-inset ring-black/10"
                  style={{
                    background: "#ffffff",
                    color: "#1a1a1a",
                  }}
                >
                  T
                </div>
              ) : (
                <ImageAsset
                  assetId={layer.assetId}
                  src={layer.src}
                  className="w-full h-full object-cover select-none pointer-events-none"
                  draggable="false"
                  fallback={
                    <span className="text-[9px] font-bold text-[var(--text-muted)]">
                      ?
                    </span>
                  }
                />
              )}
            </div>

            <div className="flex-1 min-w-0 flex items-center gap-1.5">
              <span
                className={`shrink-0 text-[9px] font-black italic transition-colors select-none tracking-tighter opacity-50
 ${isActive ? "text-[var(--text-main)]" : "text-[var(--text-muted)] group-hover/layer:text-[var(--text-main)]"}
`}
              >
                #{index + 1}
              </span>
              <div className="flex items-center gap-1 truncate">
                <Tooltip
                  content={layer.name}
                  position="top"
                  align="center"
                  uppercase={false}
                  showOnHover={layer.name.length > 14}
                >
                  <EditableLabel
                    value={layer.name}
                    doubleClick={true}
                    maxDisplayLength={14}
                    onCommit={(v) =>
                      renameCmd?.execute({
                        frameId: activeFrameId,
                        layerId: layer.id,
                        name: v,
                      })
                    }
                    className={`text-[11px] font-bold truncate transition-colors leading-tight tracking-tight
 ${isActive ? "text-[var(--text-main)]" : "text-[var(--text-muted)] group-hover/layer:text-[var(--text-main)]"}
`}
                  />
                </Tooltip>
                {/* Indicator dots: amber = has user sub-layers, teal = has masks.
                    Only shown when the layer has collapsed content underneath.
                    exchange/frag sub-layers (internal clip system) are excluded. */}
                {(hasVisibleSubLayersDot || hasMasks) && (
                  <div className="flex gap-0.5 shrink-0 opacity-40">
                    {hasVisibleSubLayersDot && (
                      <div className="w-1 h-1 rounded-full bg-amber-400" />
                    )}
                    {hasMasks && (
                      <div className="w-1 h-1 rounded-full" style={{ backgroundColor: '#00D5BE' }} />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-0 opacity-40 group-hover:opacity-100 transition-opacity">
              <ActionButton
                onClick={(e) => {
                  e.stopPropagation();
                  syncOverlayCmd?.execute({
                    frameId: activeFrameId,
                    layerId: layer.id,
                  });
                }}
                icon={<Maximize2 size={12} />}
                tooltip="Refocus"
                variant="glass"
                size="sm"
                className={`w-6 h-6 ${isActive ? "text-blue-400" : "text-[var(--text-muted)] group-hover/layer"}`}
              />
              <ActionButton
                onClick={(e) => {
                  e.stopPropagation();
                  visibilityCmd?.execute({
                    frameId: activeFrameId,
                    layerId: layer.id,
                    visible: !layer.visible,
                  });
                }}
                icon={
                  layer.visible ? (
                    <Eye size={12} />
                  ) : (
                    <EyeOff size={12} className="text-rose-500" />
                  )
                }
                variant="glass"
                size="sm"
                className={`w-6 h-6 ${layer.visible ? (isActive ? "text-blue-400" : "text-[var(--text-main)] group-hover/layer") : ""}`}
              />
              <ActionButton
                onClick={(e) => {
                  e.stopPropagation();
                  lockCmd?.execute({
                    frameId: activeFrameId,
                    layerId: layer.id,
                    locked: !layer.locked,
                  });
                }}
                icon={
                  layer.locked ? (
                    <Lock size={12} className="text-rose-500" />
                  ) : (
                    <Unlock size={12} />
                  )
                }
                variant="glass"
                size="sm"
                className={`w-6 h-6 ${layer.locked ? "" : "text-[var(--text-muted)]"}`}
              />

              <LayerMenu
                layerId={layer.id}
                activeFrameId={activeFrameId}
                hasSubLayers={hasSubLayers}
                childLayersLength={childLayers.length}
                hasMasks={hasMasks}
                masksLength={
                  (layer.vectorMasks?.length || 0) +
                  (layer.bitmapMasks?.length || 0)
                }
                canDelete={canDelete}
                isSubLayersExpanded={isSubLayersExpanded}
                setIsSubLayersExpanded={setIsSubLayersExpanded}
                isMasksExpanded={isMasksExpanded}
                setIsMasksExpanded={setIsMasksExpanded}
              />
            </div>
          </div>
        </motion.div>

        <AnimatePresence>
          {isSubLayersExpanded && hasSubLayers && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="ml-4 mr-1 mt-1 mb-1.5 pl-2.5 border-l-2 border-[var(--border-light)] flex flex-col gap-1 overflow-hidden"
            >
              {childLayers.map((subLayer, idx) => (
                <SubLayerItem
                  key={subLayer.id}
                  layerId={subLayer.id}
                  index={idx}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isMasksExpanded && hasMasks && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="ml-4 mr-1 mt-1 mb-1.5 pl-2.5 border-l-2 border-emerald-500/25 dark:border-emerald-500/40 flex flex-col gap-1 overflow-hidden"
            >
              {layer.vectorMasks &&
                [...layer.vectorMasks].reverse().map((mask: VectorMask) => {
                  const originalIdx = layer.vectorMasks!.findIndex(
                    (m) => m.id === mask.id,
                  );
                  return (
                    <MaskItem
                      key={mask.id}
                      layerId={layer.id}
                      mask={mask}
                      index={originalIdx}
                    />
                  );
                })}
              {layer.bitmapMasks &&
                [...layer.bitmapMasks].reverse().map((mask: BitmapMask) => {
                  const originalIdx = layer.bitmapMasks!.findIndex(
                    (m) => m.id === mask.id,
                  );
                  return (
                    <MaskItem
                      key={mask.id}
                      layerId={layer.id}
                      mask={mask}
                      index={originalIdx}
                    />
                  );
                })}
            </motion.div>
          )}
        </AnimatePresence>
      </Reorder.Item>
    );
  },
);
