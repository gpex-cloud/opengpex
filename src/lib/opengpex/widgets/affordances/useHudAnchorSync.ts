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

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { useFastSync } from '@opengpex/editor/core/state/volatile';
import type { Frame, CameraState } from '@opengpex/editor/core/types';
import type { ScreenRotationBox, HudTickArgs } from './types';

/**
 * useHudAnchorSync — THE rotated-container synchronizer of the affordance
 * framework, and the single home of the "descaled CSS matrix" pattern that
 * four overlays previously each hand-rolled (LayerOverlay, MarkerOverlay,
 * TextOverlay, ClipOverlay): decompose the entity's screen matrix, split
 * scale (→ width/height) from pure rotation/flip (→ CSS matrix columns),
 * so children keep constant screen size while the container follows the
 * entity's true orientation, zoom and every live gesture update.
 *
 * The consumer supplies the geometry per tick through `getAnchorFrame`
 * (live derivation — a gesture-start snapshot would freeze the HUD while
 * the entity moves). A null return hides the container.
 */

/** How the gizmo container reveals itself. */
export type HudRevealMode =
  /** Always visible while active (marker/text style). */
  | 'always'
  /** Hidden until the pointer enters the entity's footprint, hidden again
   * during ANY gesture (PS transform-selection style). Containment defaults
   * to the framework's padded rotated anchor box; a consumer hitTest may
   * override it for special footprints. */
  | 'hover';

export interface HudAnchorSyncOptions {
  ref: React.RefObject<HTMLDivElement | null>;
  active: boolean;
  getAnchorFrame: (...args: HudTickArgs) => ScreenRotationBox | null;
  reveal?: HudRevealMode;
  /**
   * Optional per-tick hook fired right after the container transform is
   * written, with the container element and the anchor's SCREEN angle
   * (radians, the same value the CSS matrix encodes). The gizmo cursor
   * rewrite rides this: CSS cursors ignore CSS transforms, so direction-
   * keyed attributes inside the container must be re-derived from the
   * live screen angle — the same source the container itself just used —
   * instead of a React-prop snapshot that can lag the fast channel.
   */
  onAnchorSync?: (container: HTMLDivElement, angleRad: number) => void;
  /**
   * Hover mode only: does the pointer (projected into the entity's local
   * space) sit inside the entity's footprint? Receives the canvas-local
   * pointer point plus the live frame and camera.
   */
  hitTest?: (localPoint: { x: number; y: number }, f: Frame, cam: CameraState) => boolean;
}

export function useHudAnchorSync({ ref, active, getAnchorFrame, reveal = 'always', hitTest, onAnchorSync }: HudAnchorSyncOptions) {
  const { actions, geometry, volatileRef } = useEditorServices();
  const { state, activeFrame } = useEditorState();

  // ── Per-tick container positioning (descaled matrix) ──
  useFastSync(ref, active, (...args: HudTickArgs) => {
    const el = ref.current;
    if (!el) return;
    const anchor = getAnchorFrame(...args);
    if (!anchor) {
      el.style.display = 'none';
      return;
    }
    // Scale is already folded into w/h by the provider; the rotation is
    // written pure so outline strokes and handle dots keep constant screen
    // size regardless of zoom. (A provider that cannot scale-split can
    // simply bake the scale into w/h — this container never carries one.)
    el.style.display = '';
    el.style.width = `${anchor.w}px`;
    el.style.height = `${anchor.h}px`;
    const cos = Math.cos(anchor.angleRad);
    const sin = Math.sin(anchor.angleRad);
    // Pure rotation matrix, origin top-left. (The anchor is already in
    // screen space with scale applied to w/h, so no further decomposition
    // is needed — the provider did it.)
    el.style.transform = `translate(${anchor.x}px, ${anchor.y}px) matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, 0)`;
    onAnchorSync?.(el, anchor.angleRad);
  }, { throttleHz: 60 });

  // ── Reveal machinery ──
  const interactingRef = useRef(!!state.interaction.isInteracting);
  // Last known pointer position (viewport coords) + the reveal evaluator.
  // Visibility is re-evaluated on move, on pointer UP and when the gesture
  // freeze lifts — a static click (press + release, zero movement) must not
  // leave the HUD hidden until the next mouse twitch.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const revealEvalRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const was = interactingRef.current;
    interactingRef.current = !!state.interaction.isInteracting;
    if (reveal !== 'hover' || !ref.current) return;
    if (interactingRef.current) {
      ref.current.style.opacity = '0';
    } else if (was) {
      // Freeze lifted (e.g. a static click released): re-evaluate with the
      // last known pointer position — the passive pointermove listener will
      // not fire until the mouse actually moves again.
      revealEvalRef.current?.();
    }
  }, [state.interaction.isInteracting, reveal, ref]);

  useEffect(() => {
    // hitTest is OPTIONAL now: absent ⇒ the DEFAULT containment (padded
    // rotated anchor box, below) drives the reveal. Only reveal mode and
    // activation gate the pipeline.
    if (reveal !== 'hover' || !active) {
      if (ref.current) ref.current.style.opacity = '';
      return;
    }
    const evaluate = () => {
      const el = ref.current;
      const pt = lastPointerRef.current;
      if (!el || !pt) return;
      const frame = activeFrame;
      if (!frame || interactingRef.current) {
        el.style.opacity = '0';
        return;
      }
      const inside = hitTest
        ? (() => {
            const currentCam = actions.fast.latestCamera(frame.id);
            const worldPt = geometry.space.screenToWorld(pt.x, pt.y, frame, currentCam);
            const localPt = geometry.space.worldToLocal(worldPt.x, worldPt.y, frame);
            return hitTest(localPt, frame, currentCam);
          })()
        : // DEFAULT containment: the padded rotated ANCHOR BOX — the same
          // geometry the handles live on, computed FRESH per evaluation via
          // getAnchorFrame (never a cached tick value: a freshly mounted HUD
          // has no ticks yet, and an idle workspace produces no new ones).
          // The anchor is screen-space, so the pointer compares directly.
          // The fixed screen-px pad covers the handle outset (6/4 px).
          (() => {
            const currentCam = actions.fast.latestCamera(frame.id);
            const a = getAnchorFrame(volatileRef.current, frame, currentCam);
            if (!a) return false;
            const pad = 24;
            const cos = Math.cos(a.angleRad);
            const sin = Math.sin(a.angleRad);
            const cx = a.x + (a.w / 2) * cos - (a.h / 2) * sin;
            const cy = a.y + (a.w / 2) * sin + (a.h / 2) * cos;
            const dx = pt.x - cx;
            const dy = pt.y - cy;
            const du = dx * cos + dy * sin;
            const dv = -dx * sin + dy * cos;
            return Math.abs(du) <= a.w / 2 + pad
              && Math.abs(dv) <= a.h / 2 + pad;
          })();
      el.style.opacity = inside ? '1' : '0';
    };
    revealEvalRef.current = () => evaluate();
    const onPointerMove = (ev: PointerEvent) => {
      const container = document.querySelector('.editor-viewport-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      lastPointerRef.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      evaluate();
    };
    // A static click releases without any further move — re-evaluate now.
    const onPointerUp = () => evaluate();
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      revealEvalRef.current = null;
    };
  }, [reveal, active, hitTest, getAnchorFrame, actions, geometry, volatileRef, activeFrame, ref]);

  // Deactivation: hide the container outright.
  useEffect(() => {
    if (ref.current) ref.current.style.display = active ? '' : 'none';
  }, [active, ref]);
}
