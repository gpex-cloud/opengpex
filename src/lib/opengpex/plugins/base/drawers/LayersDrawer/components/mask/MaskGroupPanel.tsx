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

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import EditorPortal from "@opengpex/editor/widgets/Portal";
import { EDITOR_Z_INDEX } from "@opengpex/editor/core/helpers/config";
import { MaskItem } from "./MaskItem";
import type { MaskFamily, AnyLayerMask } from "./MaskGroupItem";

/** Sized so member rows match the sub-layer rows under a group layer:
 * drawer content is 320 wide, its nested mask/sub-layer area subtracts
 * ml-4 (16) + mr-1 (4) + pl-2.5 (10) → 290 row width; this panel adds
 * p-1 (8) around its rows, so 298 makes the two identical. */
const PANEL_WIDTH = 258;
/** Horizontal gap between the group row and the panel edge. */
const PANEL_GAP = 4;
/** Minimum distance kept between the panel and the viewport edges. */
const EDGE_MARGIN = 8;

interface PanelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Fixed position for the floating panel relative to the group row.
 * Direction is decided purely by geometry: the panel opens to the right of
 * the row when there is room for it, otherwise to the left — this covers
 * both drawer dock sides and narrow viewports without reading any dock
 * state. Vertically the panel's top edge aligns with the row and is shifted
 * up just enough to stay inside the viewport when it would overflow.
 */
export function computePanelPosition(
  anchorRect: PanelRect,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const fitsRight =
    anchorRect.right + PANEL_GAP + panelWidth + EDGE_MARGIN <= viewportWidth;
  const left = fitsRight
    ? anchorRect.right + PANEL_GAP
    : anchorRect.left - panelWidth - PANEL_GAP;
  let top = anchorRect.top;
  if (top + panelHeight + EDGE_MARGIN > viewportHeight) {
    top = Math.max(EDGE_MARGIN, viewportHeight - panelHeight - EDGE_MARGIN);
  }
  return { left, top };
}

interface MaskGroupPanelProps {
  layerId: string;
  family: MaskFamily;
  masks: AnyLayerMask[];
  anchorRect: DOMRect;
  /** When true (a bitmap member is in its editing session) auto-close is suppressed. */
  editingActive: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
}

/**
 * Floating member list for a mask group row. Portaled into the popup root
 * (same seat as Popover, below every dialog) with fixed positioning because
 * the layer list is a scrolling, height-animated container that would clip
 * in-row absolute positioning. Members reuse the
 * exact flat-row components (newest first), so toggling and deleting go
 * through the same existing commands as before — this panel adds no
 * commands, no reordering, and no editing surface of its own.
 */
export const MaskGroupPanel = ({
  layerId,
  family,
  masks,
  anchorRect,
  editingActive,
  onPointerEnter,
  onPointerLeave,
  onClose,
}: MaskGroupPanelProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Positioning timing. Unlike Popover (which places itself purely from the
  // trigger rect plus a CSS transform), this panel must know its OWN rendered
  // size before it can be placed: computePanelPosition flips it to the left
  // side when it would overflow the right viewport edge and pulls it up when
  // it would overflow the bottom, and both decisions need the panel's real
  // width and height. So the panel mounts hidden (visibility: hidden,
  // off-screen), is measured, then shown at the computed spot.
  //
  // The panel element lives in a portal root that EditorPortal attaches one
  // effect after mount, so it can appear a render later than this component;
  // a mount-time layout effect would find no element. Measurement therefore
  // happens in a ref callback, which fires exactly when the element attaches.
  // That callback MUST be referentially stable: an inline arrow is a new
  // function every render, and React re-invokes a changed ref callback (null,
  // then the element) on every commit — combined with the setPos below that
  // is an infinite render loop. Hence useCallback with no dependencies, and
  // anchorRect read through a ref instead of the closure.
  const anchorRectRef = useRef(anchorRect);
  const attachPanel = useCallback((el: HTMLDivElement | null) => {
    panelRef.current = el;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      computePanelPosition(
        anchorRectRef.current,
        rect.width || PANEL_WIDTH,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, []);

  // Re-measure whenever the anchor row moves or the member count changes the
  // panel height (the ref callback above only covers the initial attach).
  useLayoutEffect(() => {
    anchorRectRef.current = anchorRect;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      computePanelPosition(
        anchorRect,
        rect.width || PANEL_WIDTH,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
    );
  }, [anchorRect, masks.length]);

  // Auto-close triggers: layer list scroll (captured from any ancestor),
  // a pointer press outside the panel, or Escape. All of them are suspended
  // while a bitmap member is being edited — the user is painting on the
  // canvas (outside presses) and must not lose the editing entry point.
  // The row's own click toggle remains the explicit way out.
  useEffect(() => {
    if (editingActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [editingActive, onClose]);

  // React synthetic events inside a portal bubble along the React tree, so
  // without these stops every press inside the panel would reach the layer
  // row and toggle selection / expansion state.
  const stopPropagation = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <EditorPortal>
      <div
        ref={attachPanel}
        data-testid="mask-group-panel"
        onPointerDown={stopPropagation}
        onClick={stopPropagation}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={{
          position: "fixed",
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          width: PANEL_WIDTH,
          visibility: pos ? "visible" : "hidden",
          zIndex: EDITOR_Z_INDEX.POPUP.POPOVER,
          // Portal roots are pointer-events: none (inherited); opt back in.
          pointerEvents: "auto",
        }}
        className="rounded-lg border border-[var(--border-light)] bg-[var(--bg-panel)] shadow-xl p-1 flex flex-col gap-0.5"
      >
        {[...masks].reverse().map((mask) => (
          <MaskItem
            key={mask.id}
            layerId={layerId}
            family={family}
            mask={mask}
            index={masks.findIndex((m) => m.id === mask.id)}
          />
        ))}
      </div>
    </EditorPortal>
  );
};
