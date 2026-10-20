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
import { useFastSync, useFastRectSync } from "@opengpex/editor/core/state/volatile";
import { TEXT_PLACE_MARQUEE_TRANSIENT_KEY } from "../protocols";

/**
 * PlaceMarquee: dashed preview rectangle for the drag-to-create gesture.
 *
 * Follows the ClipOverlay fast-track practice: the rect lives in the volatile
 * transient store (written by the place handler at pointermove rate) and this
 * component is driven by the Ticker — left/top/width/height are written
 * straight to the DOM ref per frame via `useFastRectSync`, with a companion
 * `useFastSync` gate for the empty→hidden transition. React renders this
 * component exactly once per pre-edit session; zero re-renders while dragging.
 * The projection (canvas-local → screen, camera included) is handled inside
 * `useFastRectSync` against the merged fast camera, so the box stays glued to
 * the pointer even mid-pan/zoom.
 */
export const PlaceMarquee = React.memo(function PlaceMarquee() {
  const boxRef = useRef<HTMLDivElement>(null);

  // Box geometry: canvas-local rect → screen px (fast camera merged in).
  useFastRectSync(boxRef, true, {
    selector: (v) =>
      (v.transient[TEXT_PLACE_MARQUEE_TRANSIENT_KEY] as
        | { x: number; y: number; w: number; h: number }
        | null
        | undefined) ?? null,
    space: "local",
  });

  // Visibility gate: the transient slot is empty before the drag starts and
  // after it ends — hide instead of painting a stale box at (0,0).
  useFastSync(boxRef, true, (v) => {
    const el = boxRef.current;
    if (!el) return;
    const has = !!v.transient[TEXT_PLACE_MARQUEE_TRANSIENT_KEY];
    const next = has ? "visible" : "hidden";
    if (el.style.visibility !== next) el.style.visibility = next;
  });

  return (
    <div
      ref={boxRef}
      className="absolute pointer-events-none"
      style={{
        visibility: "hidden",
        border: "1px dashed var(--accent, #6366f1)",
        background: "rgba(99, 102, 241, 0.08)",
        boxSizing: "border-box",
      }}
    />
  );
});
