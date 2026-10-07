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

import React from "react";
import { TEXT_LAYER_PADDING } from "@opengpex/editor/core/helpers/config";
import { toCssColor4 } from "@opengpex/editor/core/engine/color";
import {
  useTextOverlayState,
  usePlaceMarquee,
  useInlineTextEditing,
} from "./hooks";

// ─── TextOverlayMain ───────────────────────────────────────────────────────────

/**
 * TextOverlayMain: Text overlay main component
 *
 * Renders based on state:
 * - editing_text_layer_id has value -> renders InlineTextEditor
 * - Pre-edit: LayerOverlay draws text outlines + transform gizmo via
 *   SIGNAL_FORCE_SHOW_TYPES; a drag marquee preview is rendered here while the
 *   text tool drags out a new box.
 */
export const TextOverlayMain = React.memo(function TextOverlayMain() {
  const { activeFrame, editingLayerId, layerExists, placeMarquee } =
    useTextOverlayState();

  // Editing state: render InlineTextEditor
  if (editingLayerId && layerExists && activeFrame) {
    return <InlineTextEditor layerId={editingLayerId} />;
  }

  // Pre-editing state: drag-to-create marquee (canvas-local rect → screen space)
  if (placeMarquee && activeFrame) {
    return <PlaceMarquee rect={placeMarquee} />;
  }

  return null;
});

// ─── PlaceMarquee ──────────────────────────────────────────────────────────────

/**
 * PlaceMarquee: dashed preview rectangle for the drag-to-create gesture.
 * Screen-space projection is managed by usePlaceMarquee so presentation
 * remains decoupled from camera matrix math.
 */
const PlaceMarquee = React.memo(function PlaceMarquee({
  rect,
}: {
  rect: { x: number; y: number; w: number; h: number };
}) {
  const style = usePlaceMarquee(rect);
  if (!style) return null;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        ...style,
        border: "1px dashed var(--accent, #6366f1)",
        background: "rgba(99, 102, 241, 0.08)",
        boxSizing: "border-box",
      }}
    />
  );
});

// ─── BoxCorners ────────────────────────────────────────────────────────────────

/**
 * Corner bracket sizing (industry crop-bracket practice):
 * - Equilateral Right Angle (1:1 aspect ratio): Both arms of each corner bracket
 *   maintain equal length (Lx = Ly = arm), ensuring a true, symmetrical right-angle
 *   bracket that never stretches horizontally when text becomes wide.
 * - Typographic scaling: Arm length scales with the box's height (font size/line height,
 *   default 25% of height), with a safety clamp against width so brackets never collide.
 * - Black & White Dual Stroke: Double-layer vector stroke (black underlay + white core)
 *   providing pristine 100% contrast against any background (dark, light, or complex photos)
 *   without blurry shadow bleed.
 * - Hairline stroke: vectorEffect="non-scaling-stroke" keeps strokes crisp in physical screen
 *   pixels regardless of camera zoom.
 */
const CORNER_ARM_RATIO = 0.25;

export interface BoxCornersProps {
  /** Box width in canvas pixels */
  boxWidth?: number;
  /** Box height in canvas pixels */
  boxHeight?: number;
  /** Arm length ratio relative to box height (default: 0.25 = 25%) */
  ratio?: number;
  /** Core white stroke width in physical screen pixels (default: 1) */
  strokeWidth?: number;
  /** Backwards compatibility props (ignored) */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  scale?: number;
}

export const BoxCorners = React.memo(function BoxCorners({
  boxWidth,
  boxHeight,
  ratio = CORNER_ARM_RATIO,
  strokeWidth = 1,
}: BoxCornersProps) {
  const w = boxWidth ?? 100;
  const h = boxHeight ?? 40;
  // Equilateral right angle: arm length anchored to typographic height,
  // clamped so it stays 1:1 and never exceeds 35% of width.
  const targetArm = h * ratio;
  const arm = Math.max(6, Math.min(targetArm, w * 0.35));

  const svgStyle: React.CSSProperties = {
    position: "absolute",
    width: arm,
    height: arm,
    pointerEvents: "none",
    overflow: "visible",
  };

  const renderCorner = (points: string, positionStyle: React.CSSProperties) => (
    <svg style={{ ...svgStyle, ...positionStyle }}>
      {/* High-contrast solid black underlay (outer casing) */}
      <polyline
        points={points}
        fill="none"
        stroke="#000000"
        strokeWidth={strokeWidth + 1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />
      {/* Crisp white core (inner highlight) */}
      <polyline
        points={points}
        fill="none"
        stroke="#ffffff"
        strokeWidth={strokeWidth}
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Top-Left Corner */}
      {renderCorner(`0,${arm} 0,0 ${arm},0`, { top: 0, left: 0 })}

      {/* Top-Right Corner */}
      {renderCorner(`0,0 ${arm},0 ${arm},${arm}`, { top: 0, right: 0 })}

      {/* Bottom-Left Corner */}
      {renderCorner(`0,0 0,${arm} ${arm},${arm}`, { bottom: 0, left: 0 })}

      {/* Bottom-Right Corner */}
      {renderCorner(`0,${arm} ${arm},${arm} ${arm},0`, { bottom: 0, right: 0 })}
    </div>
  );
});

// ─── InlineTextEditor ──────────────────────────────────────────────────────────

interface InlineTextEditorProps {
  layerId: string;
}

/**
 * InlineTextEditor: contenteditable inline text editor
 *
 * Position is updated in real time via Fast Track (useFastSync) to follow canvas camera changes.
 * bounding changes are written to fast track buffer in sync, making LayerOverlay gizmo respond instantly.
 *
 * The editing box owns NOTHING but text: no transform gizmo, no border-band
 * drag, no overflow badge. Geometry is changed either via Cmd/Ctrl+Drag move
 * (its own undoable transaction) or after exiting the session, when the
 * LayerOverlay gizmo is visible again.
 */
const InlineTextEditor = React.memo(function InlineTextEditor({
  layerId,
}: InlineTextEditorProps) {
  const {
    containerRef,
    editorRef,
    layer,
    textData,
    boxMode,
    fixedVAlignOffset,
    screenMatrix,
    autoMaxWidth,
    cursorOverride,
    handleInput,
    handleKeyDown,
    handleMouseDown,
  } = useInlineTextEditing(layerId);

  if (!layer || !textData) return null;

  // Shared typographic styles for the contenteditable (both fixed-clip and
  // plain variants). letterSpacing mirrors the rasterizer's ctx.letterSpacing
  // (space after each glyph, canvas-local px).
  const editorStyle: React.CSSProperties = {
    fontFamily: textData.fontFamily,
    fontSize: `${textData.fontSize}px`,
    fontWeight: textData.fontWeight,
    fontStyle: textData.italic ? "italic" : "normal",
    textDecoration:
      [
        textData.underline ? "underline" : "",
        textData.strikethrough ? "line-through" : "",
      ]
        .filter(Boolean)
        .join(" ") || "none",
    color: toCssColor4(textData.color),
    textAlign: textData.align,
    lineHeight: textData.lineHeight,
    letterSpacing: `${textData.letterSpacing || 0}px`,
    minHeight: "1em",
    // Editing-state decoration is NOT a border here: the box's corner marks
    // (BoxCorners, rendered by the container below) are the only frame. No
    // outline/border on the contenteditable — in fixed mode its height is the
    // CONTENT height, so a full outline would detach from the actual box
    // (boxWidth/boxHeight) after a resize (real-device acceptance 2026-10-07).
    padding: `${TEXT_LAYER_PADDING.y}px ${TEXT_LAYER_PADDING.x}px`,
    cursor:
      cursorOverride === "grab" || cursorOverride === "grabbing"
        ? cursorOverride
        : "text",
  };

  return (
    <div
      ref={containerRef}
      className="absolute pointer-events-auto"
      onMouseDown={handleMouseDown}
      style={{
        left: 0,
        top: 0,
        transform: `matrix(${screenMatrix.a}, ${screenMatrix.b}, ${screenMatrix.c}, ${screenMatrix.d}, ${screenMatrix.tx}, ${screenMatrix.ty})`,
        transformOrigin: "0 0",
        minWidth:
          boxMode === "fixed" || boxMode === "auto_height"
            ? undefined
            : "10px",
        maxWidth:
          boxMode === "fixed" || boxMode === "auto_height"
            ? undefined
            : `${autoMaxWidth}px`,
      }}
    >
      <BoxCorners
        boxWidth={textData.boxWidth || layer.bounding.w}
        boxHeight={textData.boxHeight || layer.bounding.h}
      />
      {/* fixed mode: clip wrapper owns the box size + vertical alignment;
          the contenteditable inside stays a plain auto-height block so the
          caret keeps native behaviour. */}
      {boxMode === "fixed" ? (
        <div
          data-text-clip
          style={{
            width: `${textData.boxWidth}px`,
            height: `${textData.boxHeight}px`,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-start",
            // border-box: the alignment padding must live INSIDE boxHeight
            boxSizing: "border-box",
            paddingTop: `${fixedVAlignOffset}px`,
          }}
        >
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            className="outline-none whitespace-pre-wrap break-words caret-[var(--accent)]"
            style={{
              ...editorStyle,
              width: "100%",
              wordWrap: "break-word" as const,
              overflowWrap: "break-word" as const,
            }}
          />
        </div>
      ) : (
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          className="outline-none whitespace-pre-wrap break-words caret-[var(--accent)]"
          style={{
            ...editorStyle,
            // auto_height: locked width from the drag, height grows with lines
            ...(boxMode === "auto_height" && {
              width: `${textData.boxWidth || layer.bounding.w}px`,
              wordWrap: "break-word" as const,
              overflowWrap: "break-word" as const,
            }),
          }}
        />
      )}
    </div>
  );
});
