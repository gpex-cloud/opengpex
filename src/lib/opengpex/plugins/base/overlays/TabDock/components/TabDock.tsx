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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type TabDockContextValue = ReturnType<typeof useTabDock> & {
  /** Recomputes the branch-menu anchor from the given thumbnail's live rect. */
  updateMenuAnchor: (frameId: string) => void;
};

const TabDockContext = React.createContext<TabDockContextValue | null>(null);

function useTabDockContext() {
  const context = React.useContext(TabDockContext);
  if (!context)
    throw new Error("TabDock components must be used within TabDockProvider");
  return context;
}

/** Finds a thumbnail element inside the strip by its data attribute. */
function queryFrameItem(
  strip: HTMLElement | null,
  frameId: string,
): HTMLElement | null {
  return (
    strip?.querySelector(
      `[data-frame-id="${CSS.escape(frameId)}"]`,
    ) as HTMLElement | null
  ) ?? null;
}

// ─── BranchMenu ───────────────────────────────────────────────────────────────

/**
 * Rendered once at dock level (outside the scrollable frame strip) so the
 * scroll container's overflow cannot clip it. `anchor` positions the menu
 * horizontally over the hovered thumbnail, measured in dock-local pixels.
 */
function BranchMenu({
  frame,
  branches,
  isBottom,
  isRight,
  anchor,
}: {
  frame: Frame;
  branches: { frame: Frame; depth: number }[];
  isBottom: boolean;
  isRight: boolean;
  anchor: { left: number } | { right: number } | null;
}) {
  const { state, switchFrame, removeFrame, hoverTrunk, unhoverTrunk } =
    useTabDockContext();
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
      // Hover continuity: the menu is no longer a DOM child of the thumbnail,
      // so entering the menu must itself cancel the pending hover close.
      onMouseEnter={() => hoverTrunk(frame.id)}
      onMouseLeave={() => unhoverTrunk()}
      style={anchor ?? (isRight ? { right: 0 } : { left: 0 })}
      className={`absolute z-[1100] flex flex-col pointer-events-none ${
        isBottom ? "bottom-full mb-8" : "top-full mt-8"
      }`}
    >
      {/* 1. Real menu content (events enabled) */}
      <div className="flex flex-col gap-1 p-1 bg-[var(--bg-panel)]/95 backdrop-blur-3xl rounded-xl border border-[var(--border-subtle)] shadow-2xl min-w-[170px] pointer-events-auto">
        <div className="px-1.5 py-0.5 border-b border-[var(--border-subtle)] opacity-50 flex items-center gap-1.5">
          <Layers size={9} className="text-[var(--text-muted)]" />
          <span className="text-[8px] font-black uppercase tracking-widest text-[var(--text-muted)]">
            Branches
          </span>
        </div>
        <div className="flex flex-col gap-0.5 max-h-[260px] overflow-y-auto p-0.5 custom-scrollbar">
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
                    ? (depth - 1) * 12
                    : 0,
                }}
              >
                {state.config.indentBranches && depth > 1 && (
                  <div
                    className="absolute left-1 top-1/2 -translate-y-1/2 w-2.5 h-2.5 border-l-2 border-b-2 border-[var(--border-subtle)] rounded-bl opacity-40 ml-0.5"
                    style={{ left: (depth - 2) * 12 + 4 }}
                  />
                )}
                <button
                  onClick={() => switchFrame(snapFrame.id)}
                  className={`flex items-center gap-2 p-0.5 pr-6 rounded-lg transition-all w-full relative
                  ${isBranchActive ? "bg-orange-500/10 ring-1 ring-orange-600/30 dark:ring-orange-500/30" : "hover:bg-[var(--bg-stage)]"}
                  `}
                >
                  {isBranchActive && (
                    <motion.div
                      layoutId="active-branch-indicator"
                      className="absolute left-0.5 w-0.5 h-4 rounded-full bg-orange-600 dark:bg-orange-500 shadow-[0_0_8px_rgba(234,88,12,0.6)] dark:shadow-[0_0_8px_rgba(249,115,22,0.6)]"
                      transition={{
                        type: "spring",
                        stiffness: 300,
                        damping: 30,
                      }}
                    />
                  )}
                  <div className="w-7 h-7 rounded-md overflow-hidden flex-shrink-0 border border-[var(--border-subtle)] bg-[var(--bg-stage)] isolate">
                    <img
                      src={thumbnailSrc}
                      className="w-full h-full object-cover rounded-md"
                      alt=""
                    />
                  </div>
                  <div className="flex flex-col items-start overflow-hidden text-left">
                    <span
                      className={`text-[10px] truncate max-w-[90px] transition-colors ${
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
                  className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 bg-rose-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover/snap:opacity-100 transition-all cursor-pointer"
                >
                  <X size={7} strokeWidth={4} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Bridge layer: prevents pointer disconnection on diagonal movement.
          Stops ~16px short of the thumbnail edge: the hovered trunk scales up
          (originY at the dock side) and must stay hoverable up to its top edge,
          otherwise the trunk delete button (CSS group-hover) loses :hover. */}
      <div
        className={`absolute pointer-events-auto -left-6 -right-6 ${
          isBottom ? "top-full -mt-2 h-6" : "bottom-full -mb-2 h-6"
        }`}
      />
    </motion.div>
  );
}

// ─── FrameThumbnail ───────────────────────────────────────────────────────────

function FrameThumbnail({
  frame,
  isActive,
  isBottom,
}: {
  frame: Frame;
  isActive: boolean;
  isBottom: boolean;
}) {
  const {
    state,
    switchFrame,
    removeFrame,
    hoverTrunk,
    unhoverTrunk,
    setReordering,
    suppressClickRef,
    updateMenuAnchor,
  } = useTabDockContext();
  const branches = state.branchesByParent[frame.id] || [];
  const isVisible = state.showFull || isActive;

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
      dir="ltr"
      onDragStart={() => {
        // framer's reorder drag start.
        setReordering(true);
      }}
      onDragEnd={() => {
        setReordering(false);
        // Thumbnails shifted while dragging: re-measure so the branch menu
        // reopens over this item's new position (hover is still held).
        updateMenuAnchor(frame.id);
        // Release over a different thumbnail dispatches click on their common
        // ancestor (the strip), so no item onClick consumes the flag; clear it
        // after the click window so the next genuine click isn't swallowed.
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }}
      onPointerDown={() => {
        suppressClickRef.current = false;
      }}
      onMouseEnter={() => {
        hoverTrunk(frame.id);
        updateMenuAnchor(frame.id);
      }}
      onMouseLeave={() => unhoverTrunk()}
      className="pointer-events-auto relative flex items-center justify-center"
    >
      <motion.div
        layout
        onDragStart={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          // A reorder drag releases over a thumbnail and the browser still
          // dispatches click; swallow it so reordering never switches frames.
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          switchFrame(frame.id);
        }}
        className={`relative group shrink-0 w-10 h-10 cursor-pointer rounded-xl ${shadowClass}`}
        style={{
          originX: 0.5,
          originY: isBottom ? 1 : 0,
        }}
        animate={{
          scale: state.hoveredTrunkId === frame.id ? 1.35 : 1,
          marginLeft:
            state.hoveredTrunkId === frame.id ? 10 : 0,
          marginRight:
            state.hoveredTrunkId === frame.id ? 10 : 0,
          marginTop: 0,
          marginBottom: 0,
          // Rest at z-index 0, never 1: Reorder.Item owns the li's z-index and
          // holds it at 1 while the item is dragged. The li's z-index creates
          // a stacking context, but resting siblings' li z-index is unset, so
          // their inner z-index resolves in the dock-level context — an inner
          // resting at 1 would tie with the dragged li and lose to DOM order
          // when dragging rightward.
          zIndex: state.hoveredTrunkId === frame.id ? 1060 : 0,
        }}
      >
        {branches.length > 0 && (
          <div className="absolute -top-1 -left-1 z-20 flex items-center justify-center min-w-[15px] h-3.5 px-0.5 rounded-full bg-orange-500 text-white text-[8px] font-black shadow-md border border-[var(--bg-panel)] select-none pointer-events-none">
            {branches.length}
          </div>
        )}
        <div
          className={`w-full h-full rounded-xl overflow-hidden relative bg-[var(--bg-panel)] transition-all isolate select-none ${ringClass}`}
        >
          <ImageAsset
            assetId={frame.thumbnail?.assetId || firstLayer?.assetId}
            src={frame.thumbnail?.src || firstLayer?.src}
            className="w-full h-full object-cover rounded-xl pointer-events-none select-none"
            draggable={false}
          />
          <motion.div
            animate={
              state.hoveredTrunkId === frame.id
                ? { opacity: 0 }
                : { opacity: 0.8 }
            }
            className="absolute bottom-0 left-0 right-0 bg-black/60 pb-0.5 rounded-b-xl pointer-events-none select-none"
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
      className={`flex items-center gap-2 flex-row shrink-0 transition-all duration-500
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
  const stripRef = useRef<HTMLUListElement>(null);
  const dragControls = useDragControls();

  const isBottom = state.config.snap?.startsWith("B") ?? true;
  const isRight = state.config.snap?.endsWith("R") ?? false;
  const showMetrics = state.config.showMetricsHud ?? false;

  // Branch menu anchor: horizontal position of the hovered thumbnail measured
  // against the dock, in dock-local pixels. Recomputed on strip scroll so the
  // menu tracks the thumbnails while the strip scrolls underneath.
  const [menuAnchor, setMenuAnchor] = useState<
    { left: number } | { right: number } | null
  >(null);

  const updateMenuAnchor = useCallback(
    (frameId: string) => {
      const dockEl = containerRef.current;
      const itemEl = queryFrameItem(stripRef.current, frameId);
      if (!dockEl || !itemEl) return;
      const dockRect = dockEl.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      // Keep the menu (min-width 170px) within the dock's horizontal extent.
      const maxOffset = Math.max(0, dockRect.width - 180);
      const offset = isRight
        ? dockRect.right - itemRect.right
        : itemRect.left - dockRect.left;
      const clamped = Math.max(0, Math.min(offset, maxOffset));
      setMenuAnchor(isRight ? { right: clamped } : { left: clamped });
    },
    [isRight],
  );

  // Vertical-wheel → horizontal scroll for the frame strip, from anywhere on
  // the dock. Native listener is required: React attaches wheel handlers
  // passively, which would ignore preventDefault. In the mirrored (rtl) strip
  // scrollLeft runs negative, so the wheel delta is inverted to keep
  // "wheel down = scroll forward".
  useEffect(() => {
    const dockEl = containerRef.current;
    if (!dockEl) return;
    const rtlFactor = isRight ? -1 : 1;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom gesture: leave to the browser
      const delta = e.deltaX + e.deltaY;
      if (!delta) return;
      const strip = stripRef.current;
      if (!strip) return;
      e.preventDefault();
      strip.scrollLeft += rtlFactor * delta;
    };
    dockEl.addEventListener("wheel", onWheel, { passive: false });
    return () => dockEl.removeEventListener("wheel", onWheel);
  }, [isRight]);

  // Keep the active trunk in view when it changes or when the dock expands
  // (the strip may have been scrolled away from it). Manual rect math instead
  // of scrollIntoView: the latter can also scroll overflow-hidden ancestors
  // like the stage wrapper.
  useEffect(() => {
    const frameId = state.activeTrunkId;
    const strip = stripRef.current;
    if (!frameId || !strip) return;
    const raf = requestAnimationFrame(() => {
      const el = queryFrameItem(strip, frameId);
      if (!el) return;
      const stripRect = strip.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.left < stripRect.left) {
        strip.scrollLeft -= stripRect.left - elRect.left + 8;
      } else if (elRect.right > stripRect.right) {
        strip.scrollLeft += elRect.right - stripRect.right + 8;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [state.activeTrunkId, state.isPhysicalExpanded]);

  const hoveredTrunk = state.hoveredTrunkId
    ? state.trunkFrames.find(f => f.id === state.hoveredTrunkId)
    : undefined;
  const hoveredBranches = hoveredTrunk
    ? state.branchesByParent[hoveredTrunk.id]
    : undefined;
  const branchMenu =
    hoveredTrunk && hoveredBranches && hoveredBranches.length > 0
      ? { frame: hoveredTrunk, branches: hoveredBranches }
      : null;

  const contextValue = useMemo(
    () => ({ ...dock, updateMenuAnchor }),
    [dock, updateMenuAnchor],
  );

  return (
    <TabDockContext.Provider value={contextValue}>
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
            padding: state.showFull ? "4px 12px" : "3px 6px",
            gap: state.showFull ? "8px" : "0px",
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
          className={`z-[1000] backdrop-blur-3xl border border-[var(--border-subtle)] rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.3)] flex items-center select-none pointer-events-auto bg-[var(--bg-panel)]/80
 ${isRight ? "flex-row-reverse" : "flex-row"}
`}
          style={{ position: "absolute" }}
        >
          {/* Branch menu lives at dock level so the strip's overflow cannot
              clip it; anchored over the hovered thumbnail. Hidden while a
              thumbnail is being dragged — its anchor would go stale as
              siblings shift — and reopened on drag end (hover is still held,
              the item's onDragEnd re-measures the anchor). */}
          <AnimatePresence>
            {branchMenu && !state.isReordering && (
              <BranchMenu
                key={`branch-menu-${branchMenu.frame.id}`}
                frame={branchMenu.frame}
                branches={branchMenu.branches}
                isBottom={isBottom}
                isRight={isRight}
                anchor={menuAnchor}
              />
            )}
          </AnimatePresence>

          <div
            onPointerDown={(e) => dragControls.start(e)}
            className="shrink-0 flex items-center justify-center opacity-50 hover:opacity-100 transition-opacity px-1.5 cursor-grab active:cursor-grabbing"
          >
            <Grip size={13} />
          </div>
          <div
            className={`shrink-0 bg-[var(--border-subtle)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-5 mx-1`}
          />

          {/* Frame strip: the only flex child allowed to shrink — pressure
              from too many frames turns into horizontal scrolling instead of
              squeezing the HUD or the action buttons. The overflow clip line
              sits at the padding box, so py-6/-my-6 reserves 24px of invisible
              clip room above/below for the hover-scaled thumbnails and their
              delete button (19px over the top) without changing the pill's
              outer size. pointer-events-none keeps those invisible bands from
              intercepting hover — events land on the thumbnails and bubble to
              the dock; wheel is handled at dock level. dir=rtl (for
              right-snapped docks) mirrors the strip while keeping overflow
              reachable — flex-row-reverse would clip it unscrollably. */}
          <Reorder.Group
            axis="x"
            values={state.trunkFrames}
            onReorder={handleReorder}
            layoutScroll
            dir={isRight ? "rtl" : "ltr"}
            ref={stripRef}
            onScroll={() => {
              if (state.hoveredTrunkId) updateMenuAnchor(state.hoveredTrunkId);
            }}
            className="pointer-events-none flex flex-row items-center gap-2 px-3 py-6 -mx-2 -my-6 min-w-0 overflow-x-auto max-w-[min(50vw,560px)] [scrollbar-width:none] [overscroll-behavior-x:contain] [&::-webkit-scrollbar]:hidden"
          >
            {state.trunkFrames.map((frame) => (
              <FrameThumbnail
                key={frame.id}
                frame={frame}
                isActive={frame.id === state.activeTrunkId}
                isBottom={isBottom}
              />
            ))}
          </Reorder.Group>

          {/* Metrics HUD: only shown when enabled in config */}
          {showMetrics && (
            <>
              <div
                className={`shrink-0 bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-5 mx-1`}
              />
              <div
                className={`shrink-0 transition-all duration-500
                  ${state.showFull ? "opacity-100 scale-100" : "opacity-0 scale-95 overflow-hidden"}
                  ${state.showFull ? "w-auto" : "w-0"}`}
              >
                <MetricsHUD onCollapse={() => updateConfig({ showMetricsHud: false })} />
              </div>
            </>
          )}

          <div
            className={`shrink-0 bg-[var(--bg-stage)] transition-opacity ${state.showFull ? "opacity-100" : "opacity-0"} w-[1px] h-5 mx-1`}
          />
          <DockGlobalActions />
        </motion.div>
      </AnimatePresence>
    </TabDockContext.Provider>
  );
}
