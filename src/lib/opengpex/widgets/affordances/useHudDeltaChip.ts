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
import { InteractionGestureFeedback } from '@opengpex/editor/core/types';
import type { ScreenRotationBox, HudTickArgs } from './types';

/** The shared volatile record every transform gesture declares into. */
const FEEDBACK_KEY = 'gestureFeedback';

/** Screen-px gap between the entity's (rotated) bottom edge and the chip. */
const HUD_DELTA_CLEARANCE_PX = 28;

/**
 * useHudDeltaChip — the HUD-owned displacement / rotation chip. Rendered
 * inline by TransformHud (same pattern as the label row) and driven per
 * tick by the SHARED gesture-feedback record: a transform gesture declares
 * WHAT it moves once (kind + gesture-start origin), and the chip resolves
 * the live numbers against this HUD's own anchor frame. Pure technical:
 *   - position/rotation come from getAnchorFrame (whose angle is the
 *     consumer's flavor state — session true pose or plain 0°/record);
 *   - the frame readout uses only core frame facts (confinement rect for
 *     translate, the echoed anchor angle for rotate) — no business probe.
 * Frame-target gestures are owned by frame HUDs; while this chip shows,
 * the viewport-level DeltaLabel stands down for the same feedback.
 */
export function useHudDeltaChip(
  rootRef: React.RefObject<HTMLDivElement | null>,
  chipRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  getAnchorFrame: (...args: HudTickArgs) => ScreenRotationBox | null,
  enabled: boolean
): void {
  const lastFbRef = useRef<InteractionGestureFeedback | null>(null);

  useFastSync(rootRef, active, (v, f, cam) => {
    const el = chipRef.current;
    if (!el) return;
    const fb = v.transient[FEEDBACK_KEY] as unknown as InteractionGestureFeedback | undefined;
    const anchor = enabled && fb && fb.target === 'frame' ? getAnchorFrame(v, f, cam) : null;
    if (!fb || !anchor) {
      if (lastFbRef.current !== null || el.style.display !== 'none') {
        lastFbRef.current = null;
        el.style.display = 'none';
      }
      return;
    }

    // ── Position: rotated-frame bottom-left corner, cleared along the
    // rotated normal (screen space — the anchor frame already carries the
    // scale, so the clearance needs no unit conversion). Rotated with the
    // entity; transform-origin is the anchor point.
    const angleRad = anchor.angleRad;
    const ux = Math.cos(angleRad);
    const uy = Math.sin(angleRad);
    const vx = -uy;
    const vy = ux;
    const clear = fb.anchorOffsetY ?? HUD_DELTA_CLEARANCE_PX;
    const ax = anchor.x + vx * (anchor.h + clear);
    const ay = anchor.y + vy * (anchor.h + clear);
    el.style.left = `${ax}px`;
    el.style.top = `${ay}px`;
    el.style.transformOrigin = '0 0';
    el.style.transform = `rotate(${(angleRad * 180) / Math.PI}deg)`;

    // ── Content: displacement from origin, or the live absolute angle
    // (the anchor's echoed orientation — already the flavor's angle).
    const span = el.firstElementChild as HTMLSpanElement;
    const unit = el.lastElementChild as HTMLSpanElement;
    if (fb.kind === 'rotate') {
      const displayAngle = Math.abs(angleRad * 180 / Math.PI) < 0.05
        ? 0
        : Math.round((angleRad * 180 / Math.PI) * 10) / 10;
      if (span) span.textContent = `↻ ${displayAngle}`;
      if (unit) unit.textContent = '°';
    } else {
      const dx = Math.round((f.confinement?.rect.x ?? fb.origin.x) - fb.origin.x);
      const dy = Math.round((f.confinement?.rect.y ?? fb.origin.y) - fb.origin.y);
      const hArrow = dx >= 0 ? '→' : '←';
      const vArrow = dy >= 0 ? '↓' : '↑';
      if (span) span.textContent = `${hArrow} ${Math.abs(dx)}  ${vArrow} ${Math.abs(dy)}`;
      if (unit) unit.textContent = 'px';
    }
    el.style.display = '';
    lastFbRef.current = fb;
  });
}
