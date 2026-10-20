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
import { OUTER_CANVAS_PAN_IMMUNITY_ATTR } from "@opengpex/editor/stage/interaction/InteractionImmunity";
import type { ColorValue } from "@opengpex/editor/core/engine/color";
import { toCssColor4, toRgb8 } from "@opengpex/editor/core/engine/color";
import { useInlineTextEditing, getEditorMeasureContext } from "../hooks";
import { getEditorMinWidth, safeCornerArmRatio } from "../geometry";
import { BoxCorners } from "./BoxCorners";
import { TextCaret, TextSelection } from "@opengpex/editor/widgets/TextCaretKit";

/**
 * Editing-scrim feature gate. When true, the contenteditable gets a
 * semi-transparent background tinted OPPOSITE to the text's luminance, so the
 * text and caret stay readable over busy image content. Pure rgba tint only —
 * never backdrop-filter: blur(), which re-filters the underlying canvas every
 * frame and has already caused sustained-fan issues in this project.
 * Surface this constant as a system preference when one exists.
 */
const TEXT_EDIT_SCRIM_ENABLED = false;

/** Scrim opacity for both the dark and the light tint. */
const TEXT_EDIT_SCRIM_ALPHA = 0.3;

/**
 * WCAG relative luminance of the text color, from sRGB 8-bit channels.
 * Below this threshold the text reads as "dark" and gets a light scrim;
 * at or above it, a dark scrim.
 */
const TEXT_SCRIM_LUMINANCE_THRESHOLD = 0.35;

function linearize(channel8: number): number {
  const c = channel8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Contrast scrim color for the given text color: dark tint behind light text,
 * light tint behind dark text. Recomputed per render is intentional — it is a
 * handful of arithmetic ops and a conversion, negligible even per keystroke.
 */
function textEditScrim(textColor: ColorValue): string {
  const { r, g, b } = toRgb8(textColor);
  const luminance =
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  return luminance >= TEXT_SCRIM_LUMINANCE_THRESHOLD
    ? `rgba(0, 0, 0, ${TEXT_EDIT_SCRIM_ALPHA})`
    : `rgba(255, 255, 255, ${TEXT_EDIT_SCRIM_ALPHA})`;
}

export interface InlineTextEditorProps {
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
export const InlineTextEditor = React.memo(function InlineTextEditor({
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
    cursorOverride,
    handleInput,
    handleKeyDown,
    handleMouseDown,
  } = useInlineTextEditing(layerId);

  if (!layer || !textData) return null;

  // Initial inverse scale and screen-constant arm ratio for screen-invariant elements (BoxCorners and TextCaret)
  const initialScale = Math.hypot(screenMatrix.a, screenMatrix.b) || 1;
  const initialArmRatio = safeCornerArmRatio();

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
    // Editing scrim: luminance-contrast tint (see TEXT_EDIT_SCRIM_ENABLED).
    ...(TEXT_EDIT_SCRIM_ENABLED ? { background: textEditScrim(textData.color) } : {}),
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
    position: "relative",
    zIndex: 2,
  };

  return (
    <div
      ref={containerRef}
      data-text-editor-container
      className="absolute pointer-events-auto"
      onMouseDown={handleMouseDown}
      style={{
        left: 0,
        top: 0,
        // Above the whole LayerOverlay stack (its active item sits at zIndex 10
        // inside its own container) — same level as PreEditFrame — so the
        // editing box, brackets and caret are never painted under the hover
        // outlines / index labels.
        zIndex: 20,
        transform: `matrix(${screenMatrix.a}, ${screenMatrix.b}, ${screenMatrix.c}, ${screenMatrix.d}, ${screenMatrix.tx}, ${screenMatrix.ty})`,
        transformOrigin: "0 0",
        // No minWidth and no maxWidth on the CONTAINER in any mode: layers may
        // straddle the canvas edge (moving already allows it), and a canvas-edge
        // clamp would force-wrap the contenteditable mid-typing while the GPU
        // layout stays unwrapped — a DOM/GPU layout mismatch. The auto-width
        // caret-room floor lives directly on the contenteditable below, the
        // same element the live bounding measurement reads. The initial
        // creation width is clamped once in the text-place handler instead.
        ...({
          "--box-corner-scale": `${1 / initialScale}`,
          "--box-corner-arm-ratio": `${initialArmRatio}`,
          "--text-caret-scale": `${1 / initialScale}`,
        } as React.CSSProperties),
      }}
    >
      <BoxCorners
        boxWidth={textData.boxWidth || layer.bounding.w}
        boxHeight={textData.boxHeight || layer.bounding.h}
      />
      <TextSelection
        editorRef={editorRef}
        fontSize={textData.fontSize}
        lineHeight={textData.lineHeight}
      />
      <TextCaret
        editorRef={editorRef}
        fontSize={textData.fontSize}
        lineHeight={textData.lineHeight}
        verticalAlignOffset={boxMode === "fixed" ? fixedVAlignOffset : 0}
        startPadding={TEXT_LAYER_PADDING}
        caretLayout={{
          input: textData,
          boxWidth: textData.boxWidth || layer.bounding.w,
          boxHeight: textData.boxHeight || layer.bounding.h,
          measure: getEditorMeasureContext,
        }}
      />
      {/* fixed mode: clip wrapper owns the box size + vertical alignment;
          the contenteditable inside stays a plain auto-height block so the
          caret keeps native behaviour. */}
      {boxMode === "fixed" ? (
        <div
          data-text-clip
          onScroll={(e) => {
            // Defense-in-depth: keep scroll position strictly zero to prevent browser caret-induced scroll
            const el = e.currentTarget;
            if (el.scrollTop !== 0) el.scrollTop = 0;
            if (el.scrollLeft !== 0) el.scrollLeft = 0;
          }}
          style={{
            width: `${textData.boxWidth}px`,
            height: `${textData.boxHeight}px`,
            // Figma-style overflow: visible in edit mode.
            // Avoids browser scroll container creation; caret navigation past the box bottom
            // does not scroll the DOM (scrollTop stays 0), preventing GPU/DOM misalignment
            // and ghosting, while allowing caret and text to remain fully visible during editing.
            overflow: "visible",
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
            // May straddle the canvas edge: keep off-canvas presses native
            // (text selection) instead of starting a viewport pan.
            {...{ [OUTER_CANVAS_PAN_IMMUNITY_ATTR]: true }}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            className="outline-none whitespace-pre-wrap break-words caret-transparent"
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
          // See the fixed-mode branch: off-canvas presses stay native.
          {...{ [OUTER_CANVAS_PAN_IMMUNITY_ATTR]: true }}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          className="outline-none whitespace-pre-wrap break-words caret-transparent"
            style={{
              ...editorStyle,
              // auto_width contract: the box hugs the content and NEVER wraps
              // (computeTextLayout lays one unwrapped line per paragraph). The
              // DOM editor must obey the same contract: a block in an absolute
              // shrink-to-fit container otherwise wraps at "viewport width
              // minus layer left edge" once pasted content exceeds it, while
              // the GPU layout keeps the single long line — the two
              // representations diverge (double-printed text while editing,
              // and a too-narrow measured bounding that horizontally clips the
              // committed layer). width: max-content forbids the viewport from
              // acting as a wrap constraint; the box may overhang the viewport
              // exactly like the rendered layer overhangs the canvas. The
              // caret-room floor (sizing.ts getEditorMinWidth) lives on the
              // same measured element so constraint and measurement agree.
              ...(boxMode === "auto_width" && {
                width: "max-content",
                minWidth: getEditorMinWidth(),
              }),
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
