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
import { usePlaceMarquee } from "../hooks";

export interface PlaceMarqueeProps {
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * PlaceMarquee: dashed preview rectangle for the drag-to-create gesture.
 * Screen-space projection is managed by usePlaceMarquee so presentation
 * remains decoupled from camera matrix math.
 */
export const PlaceMarquee = React.memo(function PlaceMarquee({
  rect,
}: PlaceMarqueeProps) {
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
