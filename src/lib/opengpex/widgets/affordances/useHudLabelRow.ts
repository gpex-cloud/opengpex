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

import { useRef } from 'react';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import type { ScreenRotationBox, HudTickArgs } from './types';

/** Screen-px gap between the entity's (rotated) bottom edge and the row. */
const HUD_LABEL_ROW_OFFSET_PX = 6;
/** Screen-px gap between the dimension chip and an inline action bar. */
const HUD_LABEL_GAP_PX = 6;
/**
 * Hysteresis band for the right-align flip, so an entity resized across
 * the threshold does not make the action bar jump back and forth.
 */
const HUD_LABEL_ALIGN_HYSTERESIS_PX = 8;

export interface HudLabelRowOptions {
  /** Root element the chips are transformed within (absolutely positioned). */
  rootRef: React.RefObject<HTMLDivElement | null>;
  active: boolean;
  getAnchorFrame: (...args: HudTickArgs) => ScreenRotationBox | null;
  /** Live dimension-chip text; omit to render no dimension chip. */
  dimensionText?: (...args: HudTickArgs) => string;
}

export interface HudLabelRowRefs {
  dimRef: React.RefObject<HTMLDivElement | null>;
  dimTextRef: React.RefObject<HTMLSpanElement | null>;
  barRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * useHudLabelRow — dimension chip + action bar row, anchored under the
 * entity's ROTATED bottom edge and rotated with it. All layout runs in the
 * entity's TRUE rotated frame at every angle — folding the rotation for
 * readability past 90° would mirror the layout axes and throw the chips
 * to the wrong side, so the chips follow the raw orientation (their text
 * renders upside-down when the entity itself is upside-down; the row's
 * POSITION stays glued to the bottom edge at all times).
 *
 * Layout rule (rotated-frame coordinates, all widths in screen px): with
 * dimension chip width x, action bar width y and the entity's rotated-
 * frame screen width W, the bar right-aligns when W > x + gap + y (both
 * fit side by side); otherwise it sits inline right after the chip. A
 * hysteresis band around the threshold keeps the bar from flickering
 * while a gesture resizes the entity across it.
 *
 * Widths are READ before any position is written in the same tick, so the
 * per-frame pass never interleaves layout reads with style writes.
 */
export function useHudLabelRow({ rootRef, active, getAnchorFrame, dimensionText }: HudLabelRowOptions): HudLabelRowRefs {
  const dimRef = useRef<HTMLDivElement>(null);
  const dimTextRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const barRightRef = useRef(false);

  useFastSync(rootRef, active, (...args: HudTickArgs) => {
    const dimEl = dimRef.current;
    const barEl = barRef.current;
    const anchor = getAnchorFrame(...args);
    if (!anchor) {
      if (dimEl) dimEl.style.display = 'none';
      if (barEl) barEl.style.display = 'none';
      return;
    }
    const hasDim = !!dimEl && !!dimensionText;
    const hasBar = !!barEl;

    if (hasDim && dimTextRef.current) {
      dimTextRef.current.textContent = dimensionText(...args);
    }

    // ── Reads (layout) ──
    const x = hasDim && dimEl ? dimEl.offsetWidth : 0;
    const y = hasBar && barEl ? barEl.offsetWidth : 0;
    const W = anchor.w;
    const by = anchor.h + HUD_LABEL_ROW_OFFSET_PX;
    const angleDeg = (anchor.angleRad * 180) / Math.PI;

    // ── Writes: rotate about the frame's top-left, then lay out along the
    // ROTATED axes (CSS transform chains read right-to-left in local
    // coordinates, so the trailing translate moves along the rotated x/y).
    if (hasDim && dimEl) {
      dimEl.style.display = '';
      dimEl.style.transformOrigin = '0 0';
      dimEl.style.transform = `translate(${anchor.x}px, ${anchor.y}px) rotate(${angleDeg}deg) translate(0px, ${by}px)`;
    }
    if (hasBar && barEl) {
      const need = (hasDim ? x + HUD_LABEL_GAP_PX : 0) + y;
      const wasRight = barRightRef.current;
      const goRight = wasRight
        ? W > need - HUD_LABEL_ALIGN_HYSTERESIS_PX
        : W > need + HUD_LABEL_ALIGN_HYSTERESIS_PX;
      barRightRef.current = goRight;
      const bx = goRight
        ? W - y
        : hasDim ? x + HUD_LABEL_GAP_PX : 0;
      barEl.style.display = '';
      barEl.style.transformOrigin = '0 0';
      barEl.style.transform = `translate(${anchor.x}px, ${anchor.y}px) rotate(${angleDeg}deg) translate(${bx}px, ${by}px)`;
    }
  });

  return { dimRef, dimTextRef, barRef };
}
