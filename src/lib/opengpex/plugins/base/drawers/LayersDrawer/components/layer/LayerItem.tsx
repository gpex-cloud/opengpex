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

import { getLayerKind } from '@opengpex/editor/core/layer/kinds';
import React, { useRef, useEffect } from "react";
import { Eye, EyeOff, Lock, Unlock, Star, Paintbrush, PenTool, Image as ImageIcon, Folder } from "lucide-react";
import { DoubleSquareIcon, HealIcon, MosaicIcon, SharpenIcon, StampIcon } from "@opengpex/editor/plugins/base/drawers/CraftDrawer/icon";
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
import { Layer, Dimensions } from "@opengpex/editor/core/types";
import { SubLayerItem } from "./SubLayerItem";
import { MaskItem } from "../mask/MaskItem";
import {
  MaskGroupItem,
  familyMasks,
  planMaskGroups,
} from "../mask/MaskGroupItem";
import type { MaskFamily } from "../mask/MaskGroupItem";
import { LayerMenu } from "./LayerMenu";
import { hasLayerAdjustments } from "../../utils";
import { getEffectChain, sortEffectInstancesForRender } from '@opengpex/editor/core/layer/effects';
import { EffectGroupItem, EffectMemberRow } from '../mask/EffectGroupItem';
import type { LayersDrawerCommandsMap } from "../../commands.d";

interface LayerItemProps {
  layerId: string;
  layer: Layer;
  index: number;
  activeFrameId: string;
  canvasSize: Dimensions;
  isActive: boolean;
  canDelete: boolean;
  isScrolling?: boolean;
  childLayers: Layer[];
  showSubLayers: boolean;
  /** Whether this layer is marked in the multi-selection system */
  isMarked?: boolean;
  /** Callback to toggle marking state for this layer */
  onToggleMarking?: (layerId: string) => void;
  /** Semantic color for the marked badge — mapped to CSS internally */
  markedColor?: 'green' | 'red';
  /** Available group layers this layer can be moved into */
  availableGroups?: Array<{ id: string; name: string }>;
  /** Name of the current group this layer belongs to (for menu display) */
  currentGroupName?: string;
  /** Merge Back is offered only while BOTH pointers resolve (fragment link + live source) */
  canMergeBack?: boolean;
  /** Hole masks whose assocLayerId still resolves to a living fragment */
  canMergeBackAll?: boolean;
  /** Count behind `canMergeBackAll`, for the menu description */
  mergeFragmentsCount?: number;
}

export const LayerItem = React.memo(
  ({
    layer,
    index,
    activeFrameId,
    canvasSize,
    isActive,
    canDelete,
    isScrolling,
    childLayers,
    showSubLayers,
    isMarked,
    onToggleMarking,
    markedColor = 'red',
    availableGroups,
    currentGroupName,
    canMergeBack,
    canMergeBackAll,
    mergeFragmentsCount,
  }: LayerItemProps) => {
    const { actions, assets, volatileRef } = useEditorServices();
    const {
      visibilityCmd,
      lockCmd,
      renameCmd,
    } = usePluginCommands<LayersDrawerCommandsMap>();

    const containerRef = useRef<HTMLDivElement>(null);
    const dragControls = useDragControls();
    const [isMasksExpanded, setIsMasksExpanded] = React.useState(false);
    const [isSubLayersExpanded, setIsSubLayersExpanded] = React.useState(false);
    // Effects section visibility (A8): shown only while the layer carries
    // instances, toggled by the dedicated show/hide button in the row.
    const [isEffectsExpanded, setIsEffectsExpanded] = React.useState(false);
    // Intrinsic dimensions of the layer's source image, straight from the
    // asset light record (AssetEntry.width/height; pool is hydrate-populated,
    // sync KB-level read). The object-view-box thumbnail crop below is
    // computed against these — NOT frame canvas size, which only coincides
    // with src dims for logical fragments and made self-contained layers
    // (e.g. AI-eraser patches) crop to a transparent sliver → black thumbnail.
    const srcAsset = layer.assetId ? assets.get(layer.assetId) : undefined;
    const srcSize = srcAsset ? { w: srcAsset.width, h: srcAsset.height } : null;

    const hasSubLayers = childLayers.length > 0 && showSubLayers;
    // Only show sub-layers dot if there are non-internal (exchange/frag) child layers
    const hasVisibleSubLayersDot = childLayers.some(cl => cl.role !== 'exchange' && cl.role !== 'frag') && showSubLayers;
    const hasMasks = !!(
      (layer.vectorMasks && layer.vectorMasks.length > 0) ||
      (layer.bitmapMasks && layer.bitmapMasks.length > 0) ||
      (layer.adjustMasks && layer.adjustMasks.length > 0)
    );
    const hasAdjustments = hasLayerAdjustments(layer);
    // Effects family (A8): presence keys on ENABLED instances — the same
    // semantics as hasLayerAdjustments (enabled-only). A layer whose effect
    // instances are all disabled shows nothing here (no dot, no menu entry),
    // and re-enabling lives in the effects drawer.
    const hasEffects = getEffectChain(layer).some((e) => e.enabled);

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

    // A row can unmount while hovered (layer deleted, frame switch) — DOM
    // removal fires no mouseleave, so the volatile hover would stay stale and
    // the live consumers (canvas outline, info panel) would keep rendering a
    // layer that no longer exists. Id-guarded so an unmounting row never
    // clobbers a sibling row's newer hover. Keys are stable per row, so the
    // captured id always matches this row's own layer.
    useEffect(() => {
      const hoveredLayerId = layer.id;
      return () => {
        // Reading the volatile ref at cleanup time is the point: the guard
        // must compare against the hover state as it exists when the row
        // unmounts, not a mount-time snapshot.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        if (volatileRef.current.interaction.hoveredLayerId === hoveredLayerId) {
          actions.fast.setHover(null, false);
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Every row is a Reorder.Item with dragListener off — drags start only
    // from the thumbnail gesture (dragControls). Group children sit inside
    // their group's nested Reorder.Group, top-level layers inside the main
    // one; the two handles never conflict because they are separate
    // elements.

    return (
      <Reorder.Item
        value={layer}
        dragListener={false}
        dragControls={dragControls}
        id={layer.id}
        // content-visibility: the browser skips style/layout/paint (and
        // image decode) for rows outside the viewport while they stay in the
        // DOM — the rendering-pipeline cost measured at ~44% in the profiling
        // session scales with rendered rows, and this is what removes it
        // without unmounting anything. contain-intrinsic-size's `auto`
        // remembers each row's real height after its first render.
        className="[content-visibility:auto] [contain-intrinsic-size:auto_36px]"
      >
        <motion.div
          layout="position"
          className={`group/layer relative flex items-center h-[32px] cursor-pointer transition-opacity ${isScrolling ? "opacity-90" : "opacity-100"}`}
          onClick={() => actions.setActiveLayer(activeFrameId, layer.id)}
          onMouseEnter={() => {
            if (isScrolling) return;
            // Row hover rides the volatile fast lane, mirroring the canvas
            // hit-test path (useViewportEvents): per-key notify re-renders
            // only the outline overlay and the info panel, never the whole
            // editor. Writing the main store here would fan every row
            // crossing out to every context consumer (with many layers this
            // alone starves the frame budget).
            // Second argument mirrors the canvas rule "pointer is over the
            // active layer"; the row-level flag extends to the host of an
            // active fragment, a case where no overlay item exists for the
            // fragment, so the extension is visually inert.
            actions.fast.setHover(layer.id, isActive);
          }}
          onMouseLeave={() => {
            if (isScrolling) return;
            actions.fast.setHover(null, false);
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
                className={`absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full transition-all duration-300 ${layer.nature === 'logical' ? "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.4)]" : "bg-pink-400 shadow-[0_0_8px_rgba(244,114,182,0.4)]"} ${isScrolling ? "opacity-50" : "opacity-100"}`}
              />
            )}
          </div>

          <div className="relative z-10 flex-1 min-w-0 flex items-center h-full px-1.5 gap-2">
            <div
              onPointerDown={(e) => dragControls.start(e)}
              style={{ touchAction: "none" }}
              className={`relative w-[24px] h-[24px] shrink-0 rounded-md border overflow-hidden flex items-center justify-center transition-all cursor-grab active:cursor-grabbing hover:ring-2 hover:ring-[var(--border-light)] select-none
 ${
   isActive
     ? "border-[var(--border-light)] bg-[var(--bg-panel)] shadow-sm"
     : "border-[var(--border-subtle)] bg-[var(--bg-stage)]/40 group-hover/layer:border-[var(--border-light)] group-hover/layer:shadow-sm"
 }
 ${!layer.visible ? "opacity-30 grayscale" : "opacity-100"}
`}
            >
              {(() => {
                // Glyph routing lives in the LayerKind table's `icon` column;
                // this block only maps tokens to visuals. 'thumbnail' renders
                // the layer's real pixels (imported photos, baked bitmaps).
                const token = getLayerKind(layer.type).icon(layer);
                const glyph = (
                  children: React.ReactNode,
                  background = "#e4e4e7",
                ) => (
                  <div
                    className="w-full h-full flex items-center justify-center rounded-[inherit]"
                    style={{ background, color: "#1a1a1a" }}
                  >
                    {children}
                  </div>
                );
                const cropStyle = (() => {
                  // When layer has a logical crop (visibleShape is a sub-region of source image),
                  // use object-view-box to display only the cropped portion in the thumbnail.
                  // Crop fractions are relative to the SRC image's intrinsic dimensions
                  // (asset light record); fall back to frame canvas only if the
                  // asset is missing from the pool.
                  const vs = layer.visibleShape;
                  const refSize = srcSize ?? canvasSize;
                  if (!vs || !refSize || refSize.w === 0 || refSize.h === 0) return undefined;
                  const r = vs.rect;
                  // Skip if visibleShape covers the entire source image (no crop needed)
                  if (r.x === 0 && r.y === 0 && r.w >= refSize.w && r.h >= refSize.h) return undefined;
                  const top = (r.y / refSize.h * 100).toFixed(1);
                  const right = ((refSize.w - r.x - r.w) / refSize.w * 100).toFixed(1);
                  const bottom = ((refSize.h - r.y - r.h) / refSize.h * 100).toFixed(1);
                  const left = (r.x / refSize.w * 100).toFixed(1);
                  return { objectViewBox: `inset(${top}% ${right}% ${bottom}% ${left}%)` } as React.CSSProperties;
                })();
                switch (token) {
                  case "gradient":
                    return (
                      <div
                        className="w-full h-full rounded-[inherit]"
                        style={{
                          background:
                            "linear-gradient(45deg, #ef4444, #f59e0b, #10b981, #3b82f6, #8b5cf6)",
                        }}
                      />
                    );
                  case "mosaic":
                    return glyph(<MosaicIcon size={13} />);
                  case "heal":
                    return glyph(<HealIcon size={13} />);
                  case "clone":
                    return glyph(<StampIcon size={13} />);
                  case "blur":
                    return glyph(<DoubleSquareIcon size={13} />);
                  case "sharpen":
                    return glyph(<SharpenIcon size={13} />);
                  case "brush":
                    return glyph(<Paintbrush size={13} strokeWidth={2} />);
                  case "marker":
                    return glyph(<Star size={13} strokeWidth={2} />);
                  case "pen":
                    return glyph(<PenTool size={13} strokeWidth={2} />);
                  case "vector":
                  case "image":
                    return glyph(<ImageIcon size={13} strokeWidth={2} />);
                  case "text":
                    return (
                      <div
                        className="w-full h-full flex items-center justify-center font-black text-[14px] tracking-tighter rounded-[inherit]"
                        style={{ background: "#ffffff", color: "#1a1a1a" }}
                      >
                        T
                      </div>
                    );
                  case "folder":
                    return glyph(<Folder size={13} strokeWidth={2} />, "#fce7f3");
                  case "thumbnail":
                  default:
                    return (
                      <ImageAsset
                        assetId={layer.assetId}
                        src={layer.src}
                        // Contain, not cover: elongated content (a thin baked
                        // brush stroke, a hairline rasterized line) would be
                        // cover-scaled until its short edge fills the square
                        // slot and the actual content cropped away. Contain
                        // letterboxes instead — the whole content stays
                        // visible with transparent margins, the same visual
                        // contract as the square-padded frame thumbnails.
                        className="w-full h-full object-contain select-none pointer-events-none"
                        draggable="false"
                        style={cropStyle}
                        fallback={
                          <span className="text-[9px] font-bold text-[var(--text-muted)]">
                            ?
                          </span>
                        }
                      />
                    );
                }
              })()}
            </div>

            <div className="flex-1 min-w-0 flex items-center gap-1">
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleMarking?.(layer.id);
                }}
                className={`shrink-0 text-[9px] font-black italic transition-colors select-none tracking-tighter cursor-pointer hover:opacity-100
 ${isMarked
   ? `${markedColor === 'green' ? 'text-emerald-400' : 'text-rose-400'} opacity-100`
   : `opacity-50 ${isActive ? "text-[var(--text-main)]" : "text-[var(--text-muted)] group-hover/layer:text-[var(--text-main)]"}`
 }
`}
              >
                #{index + 1}
              </span>
              <div className="flex-1 min-w-0 flex items-center gap-1">
                <Tooltip
                  content={layer.name}
                  position="top"
                  align="center"
                  uppercase={false}
                  showOnHover={layer.name.length > 14}
                  containerClassName="min-w-0"
                >
                  <EditableLabel
                    value={layer.name}
                    doubleClick={true}
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
                {/* Indicator dots: purple = has user sub-layers, teal = has masks, amber = has adjustments.
                    Only shown when the layer has collapsed content underneath.
                    exchange/frag sub-layers (internal clip system) are excluded. */}
                {(hasVisibleSubLayersDot || hasMasks || hasAdjustments || hasEffects) && (
                  <div className="flex gap-0.5 shrink-0 opacity-40">
                    {hasVisibleSubLayersDot && (
                      <div className="w-1 h-1 rounded-full" style={{ backgroundColor: '#c084fc' }} />
                    )}
                    {hasMasks && (
                      <div className="w-1 h-1 rounded-full" style={{ backgroundColor: '#00D5BE' }} />
                    )}
                {hasEffects && (
                  <div className="w-1 h-1 rounded-full bg-indigo-400" />
                )}
                    {hasAdjustments && (
                      <div className="w-1 h-1 rounded-full bg-amber-400" />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-0 opacity-40 group-hover:opacity-100 transition-opacity">
              <ActionButton
                plain
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
                className={`w-5 h-6 ${layer.visible ? (isActive ? "text-cyan-400" : "text-[var(--text-main)]") : ""}`}
              />
              <ActionButton
                plain
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
                className={`w-5 h-6 ${layer.locked ? "" : "text-[var(--text-muted)]"}`}
              />

              <LayerMenu
                layerId={layer.id}
                activeFrameId={activeFrameId}
                hasSubLayers={hasSubLayers}
                childLayersLength={childLayers.length}
                hasMasks={hasMasks}
                masksLength={
                  (layer.vectorMasks?.length || 0) +
                  (layer.bitmapMasks?.length || 0) +
                  (layer.adjustMasks?.length || 0)
                }
                canDelete={canDelete}
                canReleasePath={layer.type === "vector" && !!layer.penData && (!layer.role || layer.role === "host")}
                isSubLayersExpanded={isSubLayersExpanded}
                setIsSubLayersExpanded={setIsSubLayersExpanded}
                isMasksExpanded={isMasksExpanded}
                setIsMasksExpanded={setIsMasksExpanded}
                hasEffects={hasEffects}
                // The count follows what the family actually shows: enabled
                // instances only (disabled ones render nowhere).
                effectsLength={getEffectChain(layer).filter((e) => e.enabled).length}
                isEffectsExpanded={isEffectsExpanded}
                setIsEffectsExpanded={setIsEffectsExpanded}
                canMergeBack={canMergeBack}
                canMergeBackAll={canMergeBackAll}
                canRasterize={
                  // Logical fragments are image-typed (a crop window on the
                  // shared source asset), so rasterize must key on nature as
                  // well as type.
                  layer.nature === "logical" || layer.type !== "image"
                }
                mergeFragmentsCount={mergeFragmentsCount}
                availableGroups={availableGroups}
                currentGroupId={layer.groupId}
                currentGroupName={currentGroupName}
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
              className="ml-4 mr-1 mt-0.5 mb-1 pl-2.5 border-l-2 border-[var(--border-light)] flex flex-col gap-0.5 overflow-hidden"
            >
              {childLayers.map((subLayer) => (
                <SubLayerItem
                  key={subLayer.id}
                  layerId={subLayer.id}
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
              className="ml-1.5 mr-0.5 mt-0.5 mb-0.5 pl-1.5 border-l border-emerald-500/25 dark:border-emerald-500/40 flex flex-col gap-0.5 overflow-hidden"
            >
              {planMaskGroups(layer).map(({ family, mode }) => {
                const masks = familyMasks(layer, family);
                if (mode === "group") {
                  return (
                    <MaskGroupItem
                      key={family}
                      layerId={layer.id}
                      family={family as MaskFamily}
                      masks={masks}
                    />
                  );
                }
                return (
                  <MaskItem
                    key={masks[0].id}
                    layerId={layer.id}
                    family={family as MaskFamily}
                    mask={masks[0]}
                    index={0}
                  />
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Effects family (A8): visible only when toggled open by the row's
            show-effects button; the family row itself is always the collapsed
            group row with the floating member panel (no flat variant). */}
        <AnimatePresence>
          {isEffectsExpanded && hasEffects && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="ml-1.5 mr-0.5 mt-0.5 mb-0.5 pl-1.5 border-l border-indigo-500/25 dark:border-indigo-500/40 flex flex-col gap-0.5 overflow-hidden"
            >
              {/* The mask families' threshold, effects edition: a single
                  ENABLED instance renders flat, ≥2 collapse into the group
                  row with the floating panel (both keyed on the enabled
                  chain — disabled instances render nowhere). */}
              {(() => {
                const enabled = sortEffectInstancesForRender(getEffectChain(layer)).filter((s) => s.enabled);
                if (enabled.length === 1) {
                  return <EffectMemberRow layerId={layer.id} instance={enabled[0]} ordinal={1} />;
                }
                if (enabled.length >= 2) {
                  return <EffectGroupItem layerId={layer.id} instances={enabled} />;
                }
                return null;
              })()}
            </motion.div>
          )}
        </AnimatePresence>
      </Reorder.Item>
    );
  },
);
