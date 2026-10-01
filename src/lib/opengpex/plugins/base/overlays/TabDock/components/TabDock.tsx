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

import React, { useRef } from "react";
import {
  Grip,
  Layers,
  X,
  Settings,
} from "lucide-react";
import {
  motion,
  AnimatePresence,
  useDragControls,
  Reorder,
} from "framer-motion";
import ImageAsset from "@opengpex/editor/widgets/ImageAsset";
import ActionButton from "@opengpex/editor/widgets/ActionButton";
import PluginSlot from "@opengpex/editor/workspace/components/PluginSlot";
import type { Frame } from "@opengpex/editor/core/types";
import { useEditorServices } from "@opengpex/editor/core/context";
import { useTabDock } from "../hooks";
import { MetricsHUD } from "./MetricsHUD";




// ─── Context ──────────────────────────────────────────────────────────────────

const TabDockContext = React.createContext<ReturnType<typeof useTabDock> | null>(null);

function useTabDockContext() {
  const context = React.useContext(TabDockContext);
  if (!context)
    throw new Error("TabDock components must be used within TabDockProvider");
  return context;
}

// ─── BranchMenu ───────────────────────────────────────────────────────────────

function BranchMenu({
  branches,
  snap,
}: {
  trunkId: string;
  branches: { frame: Frame; depth: number }[];
  snap: string;
}) {
  const isBottom = snap?.startsWith("B") ?? true;
  const isRight = snap?.endsWith("R") ?? false;
  const { state, switchFrame, removeFrame } = useTabDockContext();
  const { assets } = useEditorServices();

  return (
    <motion.div
      initial={{
        opacity: 0,
        y: isBottom ? 10 : -10,
        scale: 0.95,
      }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      exit={{
        opacity: 0,
        y: isBottom ? 10 : -10,
        scale: 0.95,
      }}
      className={`absolute z-[1100] flex flex-col pointer-events-none
 ${isBottom
        ? `bottom-full mb-10 ${isRight ? "right-0" : "left-0"}`
        : `top-full mt-10 ${isRight ? "right-0" : "left-0"}`}
`}
    >
      {/* 1. Real menu content (events enabled) */}
      <div className="flex flex-col gap-1.5 p-2 bg-[var(--bg-panel)]/95 backdrop-blur-3xl rounded-2xl border border-[var(--border-subtle)] shadow-2xl min-w-[200px] pointer-events-auto">
        <div className="px-2 py-1 border-b border-[var(--border-subtle)] opacity-50 flex items-center gap-1.5">
          <Layers size={10} className="text-[var(--text-muted)] " />
          <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)] ">
            Branches
          </span>
        </div>
        <div className="flex flex-col gap-0.5 max-h-[300px] overflow-y-auto px-1 pr-2 pt-1 pb-1.5 custom-scrollbar">
          {branches.map(({ frame: snapFrame, depth }) => {
            const firstLayerId = snapFrame.layers.order[0];
            const firstLayer = firstLayerId
              ? snapFrame.layers.byId[firstLayerId]
              : undefined;
            const assetUrl = firstLayer?.assetId
              ? assets.getURL(firstLayer.assetId)
              : firstLayer?.src;
            const thumbnailSrc =
              snapFrame.thumbnail?.src || assetUrl || undefined;

            const isBranchActive = snapFrame.id === state.activeFrameId;

            return (
              <div
                key={snapFrame.id}
                className="relative group/snap flex items-center"
                style={{
                  paddingLeft: state.config.indentBranches
                    ? (depth - 1) * 16
                    : 0,
                }}
              >
                {state.config.indentBranches && depth > 1 && (
                  <div
                    className="absolute left-1 top-1/2 -translate-y-1/2 w-3 h-3 border-l-2 border-b-2 border-[var(--border-subtle)] rounded-bl-lg opacity-40 ml-1"
                    style={{ left: (depth - 2) * 16 + 8 }}
                  />
                )}
                <button
                  onClick={() => switchFrame(snapFrame.id)}
                  className={`flex items-center gap-2 p-1 pr-8 rounded-xl transition-all w-full relative
                  ${isBranchActive ? "bg-orange-500/10 ring-1 ring-orange-600/30 dark:ring-orange-500/30" : "hover"}
                  `}
                >
                  {isBranchActive && (
                    <motion.div
                      layoutId="active-branch-indicator"
                      className="absolute left-1 w-1 h-5 rounded-full bg-orange-600 dark:bg-orange-500 shadow-[0_0_8px_rgba(234,88,12,0.6)] dark:shadow-[0_0_8px_rgba(249,115,22,0.6)]"
                      transition={{
                        type: "spring",
                        stiffness: 300,
                        damping: 30,
                      }}
                    />
                  )}
                  <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0 border border-[var(--border-subtle)] bg-[var(--bg-stage)] isolate">
                    <img
                      src={thumbnailSrc}
                      className="w-full h-full object-cover rounded-lg"
                      alt=""
                    />
                  </div>
                  <div className="flex flex-col items-start overflow-hidden text-left">
                    <span
                      className={`text-[10px] truncate max-w-[100px] transition-colors ${
                        isBranchActive
                          ? "text-orange-600 dark:text-orange-400 font-extrabold"
                          : "font-bold text-[var(--text-main)]"
                      }`}
                    >
                      {snapFrame.seqNum ||
                        snapFrame.name.split("__")[1] ||
                        snapFrame.name}
                    </span>
                  </div>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFrame(snapFrame.id);
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-rose-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover/snap:opacity-100 transition-all cursor-pointer"
                >
                  <X size={8} strokeWidth={4} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Bridge layer */}
      <div
        className={`absolute pointer-events-auto
 w-12 h-10 ${isRight ? "right-0" : "left-0"} ${isBottom ? "top-full" : "bottom-full"}
`}
      />
    </motion.div>
  );
}

// ─── FrameThumbnail ───────────────────────────────────────────────────────────

function FrameThumbnail({
  frame,
  isActive,
  isBottom,
  isPhysicalExpanded,
  isDragging,
}: {
  frame: Frame;
  isActive: boolean;
  isBottom: boolean;
  isPhysicalExpanded: boolean;
  isDragging: boolean;
}) {
  const { state, switchFrame, removeFrame, setHoveredTrunkId } =
    useTabDockContext();
  const branches = state.branchesByParent[frame.id] || [];
  const isVisible =
    isPhysicalExpanded || isDragging || isActive || state.config.showProps;

  const firstLayerId = frame.layers.order[0];
  const firstLayer = firstLayerId ? frame.layers.byId[firstLayerId] : undefined;

  const isTrunkActive = state.activeFrameId === frame.id;
  const isBranchActiveOfThisTrunk =
    state.activeTrunkId === frame.id && !isTrunkActive;

  const shadowClass = isTrunkActive
    ? "shadow-xl shadow-orange-600/45 dark:shadow-orange-500/40 z-10"
    : isBranchActiveOfThisTrunk
      ? "shadow-xl shadow-indigo-600/45 dark:shadow-indigo-500/40 z-10"
      : "";

  const ringClass = isTrunkActive
    ? "ring-2 ring-orange-600 dark:ring-orange-500"
    : isBranchActiveOfThisTrunk
      ? "ring-2 ring-indigo-600 dark:ring-indigo-500"
      : "group-hover:ring-2 group-hover:ring-white/20";

  if (!isVisible) return null;

  return (
    <Reorder.Item
      value={frame}
      data-frame-id={frame.id}
      className="relative flex items-center justify-center"
      onMouseEnter={() => setHoveredTrunkId(frame.id)}
      onMouseLeave={() => setHoveredTrunkId(null)}
    >
      <AnimatePresence>
        {state.hoveredTrunkId === frame.id && branches.length > 0 && (
          <BranchMenu
            trunkId={frame.id}
            branches={branches}
            snap={state.config.snap}
          />
        )}
      </AnimatePresence>

      <motion.div
        layout
        onClick={(e) => {
          e.stopPropagation();
          switchFrame(frame.id);
        }}
        className={`relative group shrink-0 w-12 h-12 cursor-pointer rounded-2xl ${shadowClass}`}
        style={{
          originX: 0.5,
          originY: isBottom ? 1 : 0,
        }}
        animate={{
          scale: state.hoveredTrunkId === frame.id ? 1.6 : 1,
          marginLeft:
            state.hoveredTrunkId === frame.id ? 18 : 0,
          marginRight:
            state.hoveredTrunkId === frame.id ? 18 : 0,
          marginTop: 0,
          marginBottom: 0,
          zIndex: state.hoveredTrunkId === frame.id ? 1060 : 1,
        }}
      >
        {branches.length > 0 && (
          <div className="absolute -top-1.5 -left-1.5 z-20 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-orange-500 text-white text-[9px] font-black shadow-md border border-[var(--bg-panel)] select-none pointer-events-none">
            {branches.length}
          </div>
        )}
        <div
          className={`w-full h-full rounded-2xl overflow-hidden relative bg-[var(--bg-panel)] transition-all isolate ${ringClass}`}
        >
          <ImageAsset
            assetId={frame.thumbnail?.assetId || firstLayer?.assetId}
            src={frame.thumbnail?.src || firstLayer?.src}
            className="w-full h-full object-cover rounded-2xl"
          />
          <motion.div
            animate={
              state.hoveredTrunkId === frame.id
                ? { opacity: 0 }
                : { opacity: 0.8 }
            }
            className="absolute bottom-0 left-0 right-0 bg-black/60 pb-0.5 rounded-b-2xl"
          >
            <p className="text-[7px] text-[var(--text-main)] font-bold text-center truncate px-1 uppercase tracking-tighter">
              {frame.name}
            </p>
          </motion.div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeFrame(frame.id);
          }}
          className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-rose-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all shadow-xl border border-[var(--border-subtle)]"
        >
          <X size={7} strokeWidth={4} />
        </button>
      </motion.div>
    </Reorder.Item>
  );
}

// ─── DockGlobalActions ────────────────────────────────────────────────────────

function DockGlobalActions() {
  const { state, openSettings } = useTabDockContext();
  const showSettingsBtn = state.config.showSettingsButton ?? true;

  return (
    <div
      className={`flex items-center gap-2 flex-row transition-all duration-500 
 ${state.showFull ? "opacity-100 scale-100" : "opacity-0 scale-95 overflow-hidden"} 
 ${state.showFull ? "w-auto" : "w-0"}`}
    >
      {showSettingsBtn && (
        <ActionButton
          onClick={() => openSettings()}
          icon={<Settings size={14} />}
          tooltip="Viewport Settings"
          size="sm"
          variant="glass"
        />
      )}
      <PluginSlot
        name="DOCK_ACTIONS"
        className="flex gap-2 flex-row"
      />
    </div>
  );
}

// ─── TabDockComponent ─────────────────────────────────────────────────────────

/**
 * TabDockComponent: Final assembled component
 */
export function TabDockComponent() {
  const dock = useTabDock();
  const { state, handleReorder, handleDockDragEnd, setIsHovered, updateConfig } = dock;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();

  const isBottom = state.config.snap?.startsWith("B") ?? true;
  const isRight = state.config.snap?.endsWith("R") ?? false;
  const showMetrics = state.config.showMetricsHud ?? false;

  return (
    <TabDockContext.Provider value={dock}>
      <AnimatePresence>
        <motion.div
          id="editor-tab-dock"
          ref={containerRef}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          drag
          dragControls={dragControls}
          dragListener={false}
          dragMomentum={false}
          dragElastic={0}
          onDragEnd={() => {
            if (containerRef.current) {
              handleDockDragEnd(
                containerRef.current.getBoundingClientRect(),
                containerRef.current.parentElement?.getBoundingClientRect() || {
                  left: 0,
                  top: 0,
                },
              );
            }
          }}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{
            ...state.initialPos,
            opacity: 1,
            scale: 1,
            padding: state.showFull ? "6px 16px" : "4px 8px",
            gap: state.showFull ? "12px" : "0px",
          }}
          transition={{
            type: "spring",
            stiffness: 400,
            damping: 30,
            x: { duration: 0 },
            y: { duration: 0 },
            left: { duration: 0 },
            top: { duration: 0 },
            bottom: { duration: 0 },
            right: { duration: 0 },
            opacity: { duration: 0.3 },
            scale: { duration: 0.3 },
          }}
          className={`z-[1000] backdrop-blur-3xl border border-[var(--border-subtle)] rounded-[30px] shadow-[0_20px_50px_rgba(0,0,0,0.3)] flex items-center select-none pointer-events-auto bg-[var(--bg-panel)]/80 
 ${isRight ? "flex-row-reverse" : "flex-row"}
`}
          style={{ position: "absolute" }}
        >
          <div
            onPointerDown={(e) => dragControls.start(e)}
            className="flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity px-2 cursor-grab active:cursor-grabbing"
          >
            <Grip size={14} />
          </div>
          <div
            className={`bg-[var(--border-subtle)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-6 mx-1`}
          />

          <Reorder.Group
            axis="x"
            values={state.trunkFrames}
            onReorder={handleReorder}
            className={`flex items-center gap-2 px-1 ${isRight ? "flex-row-reverse" : "flex-row"}`}
          >
            {state.trunkFrames.map((frame) => (
              <FrameThumbnail
                key={frame.id}
                frame={frame}
                isActive={frame.id === state.activeTrunkId}
                isBottom={isBottom}
                isPhysicalExpanded={state.isPhysicalExpanded}
                isDragging={state.isDragging}
              />
            ))}
          </Reorder.Group>

          {/* Metrics HUD: only shown when enabled in config */}
          {showMetrics && (
            <>
              <div
                className={`bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-6 mx-1`}
              />
              <div
                className={`transition-all duration-500
                  ${state.showFull ? "opacity-100 scale-100" : "opacity-0 scale-95 overflow-hidden"}
                  ${state.showFull ? "w-auto" : "w-0"}`}
              >
                <MetricsHUD onCollapse={() => updateConfig({ showMetricsHud: false })} />
              </div>
            </>
          )}

          <div
            className={`bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-6 mx-1`}
          />
          <DockGlobalActions />
        </motion.div>
      </AnimatePresence>
    </TabDockContext.Provider>
  );
}
