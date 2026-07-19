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

import React, { useRef, useState, useEffect, useMemo } from "react";
import {
  Grip,
  Layers,
  X,
  Settings,
  Activity,
  Globe,
  MapPin,
  MemoryStick,
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
import { useEditorServices, useEditorState } from "@opengpex/editor/core/context";
import { useTabDock } from "../hooks";

// ─── DockMetricsHUD: FPS + World + Local coords ───────────────────────────────

interface DockMetrics {
  fps: number;
  world: { x: number; y: number };
  local: { x: number; y: number };
  mem: string | null; // e.g. "128 MB", null if unavailable
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function useDockMetrics(): DockMetrics {
  const { activeFrame } = useEditorState();
  const { actions, geometry } = useEditorServices();

  const [fps, setFps] = useState(0);
  const fpsRef = useRef({ frames: 0, lastTime: 0 });

  // RAF-driven FPS counter
  useEffect(() => {
    fpsRef.current = { frames: 0, lastTime: performance.now() };
    let rafId: number;
    const tick = () => {
      const now = performance.now();
      fpsRef.current.frames++;
      const elapsed = now - fpsRef.current.lastTime;
      if (elapsed >= 1000) {
        setFps(Math.round((fpsRef.current.frames * 1000) / elapsed));
        fpsRef.current = { frames: 0, lastTime: now };
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Mouse position tracking
  const mouseRef = useRef({ vx: 0, vy: 0 });
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current = {
        vx: Math.round(e.clientX - rect.left),
        vy: Math.round(e.clientY - rect.top),
      };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // ~15Hz tick for coordinate updates
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let rafId: number;
    let lastUpdate = 0;
    const loop = () => {
      const now = performance.now();
      if (now - lastUpdate >= 66) {
        lastUpdate = now;
        setTick(t => t + 1);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // Memory (2s interval, Chrome only)
  const [mem, setMem] = useState<string | null>(null);
  useEffect(() => {
    const collect = () => {
      const perf = performance as Performance & {
        memory?: { usedJSHeapSize: number };
      };
      setMem(perf.memory ? formatMB(perf.memory.usedJSHeapSize) : null);
    };
    collect();
    const timer = setInterval(collect, 2000);
    return () => clearInterval(timer);
  }, []);

  const coords = useMemo(() => {
    void tick;
    if (!activeFrame) return { world: { x: 0, y: 0 }, local: { x: 0, y: 0 } };
    const cam = actions.fast.latestCamera(activeFrame.id);
    const { vx, vy } = mouseRef.current;
    const world = geometry.space.screenToWorld(vx, vy, activeFrame, cam);
    const local = geometry.space.screenToLocal(vx, vy, activeFrame, cam);
    return { world, local };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, activeFrame, actions.fast, geometry]);

  return { fps, world: coords.world, local: coords.local, mem };
}

function fpsColor(fps: number): string {
  if (fps >= 50) return "text-emerald-500";
  if (fps >= 30) return "text-amber-500";
  return "text-rose-500";
}

/**
 * DockMetricsHUD: Compact FPS + World + Local coords display for TabDock.
 */
function DockMetricsHUD() {
  const { fps, world, local, mem } = useDockMetrics();

  return (
    <div className="flex flex-col gap-1 font-mono select-none">
      {/* FPS */}
      <div className="flex items-center gap-1">
        <Activity size={8} className={`shrink-0 ${fpsColor(fps)}`} />
        <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-7">FPS</span>
        <span className={`text-[9px] font-black tabular-nums leading-none ${fpsColor(fps)}`}>
          {fps}
        </span>
      </div>

      {/* Memory */}
      {mem !== null && (
        <div className="flex items-center gap-1">
          <MemoryStick size={8} className="text-violet-400 shrink-0" />
          <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-7">Mem</span>
          <span className="text-[9px] font-bold text-[var(--text-main)] tabular-nums leading-none">
            {mem}
          </span>
        </div>
      )}

      {/* World coords */}
      <div className="flex items-center gap-1">
        <Globe size={8} className="text-amber-400 shrink-0" />
        <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-7">World</span>
        <span className="text-[9px] font-bold text-[var(--text-main)] tabular-nums leading-none inline-flex gap-0.5">
          <span className="inline-block w-[3ch] text-right">{Math.round(world.x)}</span>
          <span className="text-[var(--text-muted)]">,</span>
          <span className="inline-block w-[3ch] text-right">{Math.round(world.y)}</span>
        </span>
      </div>

      {/* Local coords */}
      <div className="flex items-center gap-1">
        <MapPin size={8} className="text-cyan-400 shrink-0" />
        <span className="text-[7px] font-black text-[var(--text-muted)] uppercase leading-none w-7">Local</span>
        <span className="text-[9px] font-bold text-[var(--text-main)] tabular-nums leading-none inline-flex gap-0.5">
          <span className="inline-block w-[3ch] text-right">{Math.round(local.x)}</span>
          <span className="text-[var(--text-muted)]">,</span>
          <span className="inline-block w-[3ch] text-right">{Math.round(local.y)}</span>
        </span>
      </div>
    </div>
  );
}

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
  orientation,
  snap,
}: {
  trunkId: string;
  branches: { frame: Frame; depth: number }[];
  orientation: string;
  snap: string;
}) {
  const isHorizontal = orientation === "horizontal";
  const isBottom = snap?.startsWith("B") ?? true;
  const isRight = snap?.endsWith("R") ?? false;
  const { state, switchFrame, removeFrame } = useTabDockContext();
  const { assets } = useEditorServices();

  return (
    <motion.div
      initial={{
        opacity: 0,
        y: isHorizontal ? (isBottom ? 10 : -10) : 0,
        x: !isHorizontal ? (isRight ? 10 : -10) : 0,
        scale: 0.95,
      }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      exit={{
        opacity: 0,
        y: isHorizontal ? (isBottom ? 10 : -10) : 0,
        x: !isHorizontal ? (isRight ? 10 : -10) : 0,
        scale: 0.95,
      }}
      className={`absolute z-[1100] flex flex-col pointer-events-none
 ${
   isHorizontal
     ? isBottom
       ? `bottom-full mb-10 ${isRight ? "right-0" : "left-0"}`
       : `top-full mt-10 ${isRight ? "right-0" : "left-0"}`
     : isRight
       ? `right-full mr-10 ${isBottom ? "bottom-0" : "top-0"}`
       : `left-full ml-10 ${isBottom ? "bottom-0" : "top-0"}`
 }
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
        <div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto px-1 pr-2 pb-1.5 custom-scrollbar">
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
                  className={`flex items-center gap-2 p-1.5 pr-8 rounded-xl transition-all w-full relative
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
 ${
   isHorizontal
     ? `w-12 h-10 ${isRight ? "right-0" : "left-0"} ${isBottom ? "top-full" : "bottom-full"}`
     : `w-10 h-12 ${isBottom ? "bottom-0" : "top-0"} ${isRight ? "left-full" : "right-full"}`
 }
`}
      />
    </motion.div>
  );
}

// ─── FrameThumbnail ───────────────────────────────────────────────────────────

function FrameThumbnail({
  frame,
  isActive,
  isHorizontal,
  isBottom,
  isRight,
  isPhysicalExpanded,
  isDragging,
}: {
  frame: Frame;
  isActive: boolean;
  isHorizontal: boolean;
  isBottom: boolean;
  isRight: boolean;
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
            orientation={state.config.orientation}
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
          originX: isHorizontal ? 0.5 : isRight ? 1 : 0,
          originY: isHorizontal ? (isBottom ? 1 : 0) : 0.5,
        }}
        animate={{
          scale: state.hoveredTrunkId === frame.id ? 1.6 : 1,
          marginLeft:
            state.hoveredTrunkId === frame.id && isHorizontal ? 18 : 0,
          marginRight:
            state.hoveredTrunkId === frame.id && isHorizontal ? 18 : 0,
          marginTop:
            state.hoveredTrunkId === frame.id && !isHorizontal ? 18 : 0,
          marginBottom:
            state.hoveredTrunkId === frame.id && !isHorizontal ? 18 : 0,
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
  const isHorizontal = state.config.orientation === "horizontal";

  return (
    <div
      className={`flex items-center gap-2 transition-all duration-500 
 ${isHorizontal ? "flex-row" : "flex-col"}
 ${state.showFull ? "opacity-100 scale-100" : "opacity-0 scale-95 overflow-hidden"} 
 ${isHorizontal ? (state.showFull ? "w-auto" : "w-0") : state.showFull ? "h-auto" : "h-0"}`}
    >
      <PluginSlot
        name="DOCK_ACTIONS"
        className={`flex gap-2 ${isHorizontal ? "flex-row" : "flex-col"}`}
      />
      <ActionButton
        onClick={() => openSettings()}
        icon={<Settings size={14} />}
        tooltip="Viewport Settings"
        size="sm"
        variant="glass"
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
  const { state, handleReorder, handleDockDragEnd, setIsHovered } = dock;
  const containerRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();

  const isHorizontal = state.config.orientation === "horizontal";
  const isBottom = state.config.snap?.startsWith("B") ?? true;
  const isRight = state.config.snap?.endsWith("R") ?? false;
  const showMetrics = state.config.showMetricsHud ?? true;

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
            padding: state.showFull
              ? isHorizontal
                ? "6px 16px"
                : "16px 6px"
              : isHorizontal
                ? "4px 8px"
                : "8px 4px",
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
 ${isHorizontal ? (isRight ? "flex-row-reverse" : "flex-row") : isBottom ? "flex-col-reverse" : "flex-col"}
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
            className={`bg-[var(--border-subtle)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} ${isHorizontal ? "w-[1px] h-6 mx-1" : "w-6 h-[1px] my-1"}`}
          />

          <Reorder.Group
            axis={isHorizontal ? "x" : "y"}
            values={state.trunkFrames}
            onReorder={handleReorder}
            className={`flex items-center gap-2 px-1 ${isHorizontal ? (isRight ? "flex-row-reverse" : "flex-row") : isBottom ? "flex-col-reverse" : "flex-col"}`}
          >
            {state.trunkFrames.map((frame) => (
              <FrameThumbnail
                key={frame.id}
                frame={frame}
                isActive={frame.id === state.activeTrunkId}
                isHorizontal={isHorizontal}
                isBottom={isBottom}
                isRight={isRight}
                isPhysicalExpanded={state.isPhysicalExpanded}
                isDragging={state.isDragging}
              />
            ))}
          </Reorder.Group>

          {/* Metrics HUD: only shown when enabled in config */}
          {showMetrics && (
            <>
              <div
                className={`bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} ${isHorizontal ? "w-[1px] h-6 mx-1" : "w-6 h-[1px] my-1"}`}
              />
              <div
                className={`transition-all duration-500
                  ${state.showFull ? "opacity-100 scale-100" : "opacity-0 scale-95 overflow-hidden"}
                  ${isHorizontal ? (state.showFull ? "w-auto" : "w-0") : state.showFull ? "h-auto" : "h-0"}`}
              >
                <DockMetricsHUD />
              </div>
            </>
          )}

          <div
            className={`bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} ${isHorizontal ? "w-[1px] h-6 mx-1" : "w-6 h-[1px] my-1"}`}
          />
          <DockGlobalActions />
        </motion.div>
      </AnimatePresence>
    </TabDockContext.Provider>
  );
}
