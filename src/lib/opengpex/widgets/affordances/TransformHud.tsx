'use client';

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

import { useCallback, useRef } from 'react';
import { TransformGizmo } from '@opengpex/editor/widgets/TransformGizmo';
import { poseScreenAngle } from '@opengpex/editor/core/geometry/operators/rotator';
import { AngleAwareResizeCursor } from '@opengpex/editor/icons';
import type { TransformHudProps } from './types';
import { useHudAnchorSync } from './useHudAnchorSync';
import { useHudLabelRow } from './useHudLabelRow';
import { useHudDeltaChip } from './useHudDeltaChip';

/**
 * TransformHud — the declarative transform-affordance stack of the
 * editor: a rotated gizmo container, a dimension chip and an action bar,
 * all following the entity's true orientation live. The consumer declares
 * WHAT (which affordances are on, the entity's anchor geometry per tick,
 * any business buttons); this component owns HOW (descaled-matrix
 * container sync, rotated label-row layout with right-align hysteresis,
 * hover reveal). Business-agnostic by construction: nothing here reads
 * entity internals — every per-frame fact arrives through
 * `getAnchorFrame` / `dimension.text`, derived live (a gesture-start
 * snapshot would freeze the HUD while the entity moves).
 *
 * Consumers mount it inside the stage overlay's positioned root and keep
 * ownership of the interaction handlers (the framework renders no press
 * logic — gizmo presses stay with whoever routes them today).
 */
export function TransformHud({
  active,
  getAnchorFrame,
  reveal = 'always',
  hitTest,
  gizmo,
  pressScope,
  moveSurface,
  roundShape,
  gizmoContainerProps,
  gizmoExtras,
  dimension,
  actions,
  delta,
}: TransformHudProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRootRef = useRef<HTMLDivElement>(null);
  const deltaChipRef = useRef<HTMLDivElement>(null);

  // Handle-cursor rewrite (per anchor tick): CSS cursors ignore the CSS
  // transform that rotates the container, so every hit zone's direction-
  // keyed cursor must be re-derived from the SAME live screen angle the
  // container just rotated by. Zones carry their LOCAL outward angle in
  // `data-gizmo-local-angle`; composing local → screen here keeps the
  // cursor in lockstep with the box at every orientation and every camera
  // rotation, with no per-consumer React-prop snapshot that could lag the
  // fast channel. The OS only ships 4 fixed resize glyphs, so the cursor
  // is the GENERATED direction-accurate arrow (15° steps) rather than a
  // bucket keyword — a rotated handle no longer mismatches its glyph by
  // up to 22.5°. (Mirror flips are not modeled here — none of the HUD
  // entities mirror today; a consumer that needs it goes through the
  // TransformGizmo `flip` prop.)
  const onAnchorSync = useCallback((container: HTMLDivElement, angleRad: number) => {
    const rotationDeg = (angleRad * 180) / Math.PI;
    container.querySelectorAll<HTMLElement>('[data-gizmo-local-angle]').forEach((zone) => {
      const localDeg = Number(zone.dataset.gizmoLocalAngle);
      if (!Number.isFinite(localDeg)) return;
      zone.setAttribute(
        'data-gizmo-cursor',
        AngleAwareResizeCursor(poseScreenAngle(localDeg, rotationDeg)),
      );
    });
  }, []);

  // The delta flavor decides which feedback records this HUD claims:
  // boolean true = frame-target, { targetId } = that entity's layer-target.
  const deltaTargetId = typeof delta === 'object' ? delta.targetId : undefined;

  useHudAnchorSync({ ref: containerRef, active, getAnchorFrame, reveal, hitTest, onAnchorSync });
  useHudDeltaChip(labelsRootRef, deltaChipRef, active, getAnchorFrame, !!delta, deltaTargetId, !!dimension);
  const { dimRef, dimTextRef, barRef } = useHudLabelRow({
    rootRef: labelsRootRef,
    active,
    getAnchorFrame,
    dimensionText: dimension?.text,
  });

  // The delta chip shares the label row's positioned root — a chips-only
  // HUD (delta without dimension/actions) must still mount that root or
  // the chip has nowhere to render.
  const showLabels = active && !!(dimension || actions || delta);

  return (
    <>
      {/* Rotated gizmo container: positioned/sized per tick by
          useHudAnchorSync (descaled matrix). All interaction attributes
          (data scopes, move-surface flags, cursor hints) stay with the
          consumer through gizmoContainerProps. No gizmo → no container at
          all (an absent affordance must not add a hit surface). */}
      {gizmo !== undefined && (
        <div
          // First-class declarations (scope attribute, move surface, round
          // footprint) cover the everyday needs; gizmoContainerProps stays
          // as the rare-attribute escape hatch and is spread FIRST so the
          // framework invariants below can never be overridden by it.
          {...gizmoContainerProps}
          {...(pressScope ? { [`data-${pressScope}`]: 'true' } : {})}
          data-handle={moveSurface ? 'move' : undefined}
          className={[
            'absolute top-0 left-0',
            moveSurface
              ? 'pointer-events-auto transition-[border-radius] duration-300'
              : 'pointer-events-none',
            gizmoContainerProps?.className ?? '',
          ].filter(Boolean).join(' ')}
          // Origin top-left: the anchor-sync writes translate+rotation
          // matrices that assume the frame's top-left as the pivot — the
          // CSS default (50% 50%) would shear the container by half its
          // size on every non-zero rotation and knock the gizmo off the
          // entity (same contract as the marker/text overlay containers).
          style={{
            display: 'none',
            transformOrigin: '0 0',
            borderRadius: roundShape ? '50%' : undefined,
            ...gizmoContainerProps?.style,
          }}
          ref={containerRef}
        >
          <TransformGizmo {...gizmo} />
          {gizmoExtras}
        </div>
      )}

      {/* Label row: dimension chip + action bar, laid out along the
          entity's rotated axes by useHudLabelRow. */}
      {showLabels && (
        <div ref={labelsRootRef} className="absolute inset-0 pointer-events-none">
          {dimension && (
            <div
              ref={dimRef}
              className="absolute top-0 left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
              style={{ padding: '1px 5px', gap: '2px', display: 'none' }}
            >
              <span
                ref={dimTextRef}
                className="text-[11px] font-black text-white tabular-nums tracking-tighter"
              />
              <span className="text-[11px] font-bold text-white/40 ml-0.5">{dimension.unit ?? 'px'}</span>
            </div>
          )}
          {actions && (
            <div
              ref={barRef}
              className="absolute top-0 left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl whitespace-nowrap"
              style={{ padding: '1px 5px', display: 'none' }}
            >
              {actions}
            </div>
          )}
          {/* Delta chip (framework-owned): inline like the label row above,
              driven per tick by the shared gesture-feedback record and this
              HUD's own anchor frame (position, rotation AND the readout's
              orientation all come from it — no business probe). */}
          {delta && (
            <div
              ref={deltaChipRef}
              className="absolute top-0 left-0 bg-zinc-900/90 backdrop-blur-md border border-white/10 rounded flex items-center shadow-2xl pointer-events-none whitespace-nowrap"
              style={{ padding: '1px 5px', gap: '2px', display: 'none' }}
            >
              <span className="text-[11px] font-black text-emerald-400 tabular-nums tracking-tighter" />
              <span className="text-[11px] font-bold text-white/40 ml-0.5">px</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
