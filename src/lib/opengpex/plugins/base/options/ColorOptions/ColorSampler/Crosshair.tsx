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

import { RETICLE_TICKS } from "./constants";

/**
 * The eyedropper reticle drawn at the cursor. Pure presentation: the owner
 * decides WHEN it is shown (over the image, or while dragging a pick) and passes
 * the current cursor position.
 *
 * The reticle is stroked TWICE from the same {@link RETICLE_TICKS} — a wide dark
 * halo underneath, a thin white line on top — so it stays legible on any pixel.
 */
export function Crosshair({ x, y }: { x: number; y: number }) {
  return (
    <div
      className="fixed pointer-events-none"
      style={{
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        fill="none"
        className="overflow-visible"
      >
        {/* Dark halo — one wide soft stroke under the whole reticle. */}
        <g stroke="#000" strokeOpacity="0.4" strokeWidth="3.25" strokeLinecap="round">
          {RETICLE_TICKS.map((l, i) => (
            <line key={i} {...l} />
          ))}
          <circle cx="20" cy="20" r="2.75" fill="none" />
        </g>

        {/* Crisp white reticle on top — rounded caps + a hollow centre ring that
            leaves the target pixel visible. */}
        <g stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
          {RETICLE_TICKS.map((l, i) => (
            <line key={i} {...l} />
          ))}
          <circle cx="20" cy="20" r="2.75" fill="none" />
        </g>
      </svg>
    </div>
  );
}

export default Crosshair;
