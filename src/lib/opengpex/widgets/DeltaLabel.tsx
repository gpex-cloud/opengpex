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

'use client';

import { useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import { EDITOR_Z_INDEX } from '@opengpex/editor/core/helpers/config';
import type { InteractionGestureFeedback } from '@opengpex/editor/core/types';

const FEEDBACK_KEY = 'gestureFeedback';

/**
 * DeltaLabel — THE single displacement/angle chip for every
 * translating or rotating gesture on the stage. Gestures declare what they
 * move through InteractionTransaction.declareFeedback ( WHAT + gesture-start
 * origin ); this widget reads the volatile `gestureFeedback` record every
 * fast-sync frame and renders one label anchored under the moved entity:
 *
 *   - translate → `→ dx  ↓ dy` (displacement of the declared entity from
 *     its gesture-start origin, directional arrows, absolute pixel counts);
 *   - rotate    → `↻ angle`    (the target layer's live absolute rotation).
 *
 * System-level by design: there is exactly ONE label for ALL gestures
 * (selection move, layer move, pen/text move & rotate, fragment transform)
 * because the declaration — not a per-plugin sniffer — is the single
 * source of "what is moving". A gesture without a declaration shows
 * nothing; two labels are structurally impossible (gestures are exclusive
 * and the transient holds one record, cleared by the transaction's
 * commit/abort).
 *
 * Anchoring: under the moved entity's bounding edge — the selection rect's
 * bottom for `frame` targets, the layer's live visible AABB bottom for
 * `layer` targets (pose-aware, so a rotated layer's chip sits under its
 * footprint). Screen-px offsets differ per target because the selection
 * chip historically cleared the dimension label that shares that corner.
 */
export function DeltaLabel() {
  const ref = useRef<HTMLDivElement>(null);
  const { geometry } = useEditorServices();

  useFastSync(ref, true, (v, f, cam) => {
    const el = ref.current;
    if (!el) return;

    const fb = v.transient[FEEDBACK_KEY] as unknown as InteractionGestureFeedback | undefined;
    if (!fb) {
      el.style.display = 'none';
      return;
    }

    // ── Anchor: derived LIVE every frame; the declaration may only tighten
    // the clearance (it never pins the position — a gesture-start snapshot
    // would freeze the chip while the entity moves).
    let anchorLocal: { x: number; y: number } | undefined;
    // Screen-px clearance below the anchor (layer-target path only — the
    // frame path folds its clearance into the rotated-frame math).
    let offsetY = 0;
    if (fb.target === 'frame') {
      // Frame-target gestures are owned by the entity HUD's inline delta
      // chip (TransformHud delta affordance) — this viewport-level label
      // keeps only the non-HUD audiences (layer move, pen/text drag).
      el.style.display = 'none';
      return;
    }
    const layer = fb.targetId ? f.layers.byId[fb.targetId] : undefined;
    if (!layer) { el.style.display = 'none'; return; }
    {
      const pose = geometry.transform.computeLayerMovePose(layer);
      const center = { x: layer.cx + pose.centerOffset.x, y: layer.cy + pose.centerOffset.y };
      const local = geometry.space.worldToLocal(center.x, center.y, f);
      anchorLocal = { x: local.x - pose.aabbSize.w / 2, y: local.y + pose.aabbSize.h / 2 };
      offsetY = 8;
    }
    if (anchorLocal) {
      const pt = geometry.space.localToScreen(anchorLocal.x, anchorLocal.y, f, cam);
      el.style.left = `${pt.x}px`;
      el.style.top = `${pt.y + offsetY}px`;
      el.style.transform = '';
    }

    // ── Content: displacement from origin, or the live absolute angle ──
    // The value span carries the measurement, the unit span switches between
    // "px" (translate) and "°" (rotate) — one DOM pair for both kinds.
    const span = el.firstElementChild as HTMLSpanElement;
    const unit = el.lastElementChild as HTMLSpanElement;
    if (fb.kind === 'rotate') {
      const displayAngle = Math.abs(layer.rotation) < 0.05 ? 0 : Math.round(layer.rotation * 10) / 10;
      if (span) span.textContent = `↻ ${displayAngle}`;
      if (unit) unit.textContent = '°';
    } else {
      const dx = Math.round(layer.cx - fb.origin.x);
      const dy = Math.round(layer.cy - fb.origin.y);
      const hArrow = dx >= 0 ? '→' : '←';
      const vArrow = dy >= 0 ? '↓' : '↑';
      if (span) span.textContent = `${hArrow} ${Math.abs(dx)}  ${vArrow} ${Math.abs(dy)}`;
      if (unit) unit.textContent = 'px';
    }
    el.style.display = '';
  });

  return (
    <div
      ref={ref}
      className="absolute top-0 left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
      style={{
        padding: '1px 5px',
        gap: '2px',
        display: 'none',
        zIndex: EDITOR_Z_INDEX.STAGE.FEEDBACK,
      }}
    >
      <span className="text-[11px] font-black text-emerald-400 tabular-nums tracking-tighter" />
      <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
    </div>
  );
}
