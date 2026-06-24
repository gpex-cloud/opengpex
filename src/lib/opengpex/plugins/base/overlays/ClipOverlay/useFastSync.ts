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

import { useEffect, useRef } from 'react';
import { useEditorServices } from '@opengpex/editor/core/context';
import { useFastSync, useFastRectSync, useFastSvgGroupSync, useFastMarchingAntsSync } from '@opengpex/editor/core/motion/hooks/navigation';
import { LocalRect } from '@opengpex/editor/core/types';

/**
 * useCropDimSync: Fast track Hook dedicated to synchronizing selection dimension display
 */
export function useCropDimSync(
  isActive: boolean,
  isReCanvas: boolean
) {
  const dimLabelRef = useRef<HTMLSpanElement>(null);

  useFastSync(dimLabelRef, isActive, (_v, f) => {
    const currentShape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
    const currentBox = currentShape.rect;

    if (dimLabelRef.current) {
      dimLabelRef.current.textContent = `${Math.round(currentBox.w)} × ${Math.round(currentBox.h)}`;
    }
  });

  return { dimLabelRef };
}

/**
 * useRegularCropSync: Selection-box screen-space synchronizer for **regular** crop tools
 * (rect / ellipse-smooth / ellipse-pixel). Drives:
 *
 *   - boxRef     : HTMLDivElement positioned via fast-track left/top/width/height (frame-local rect)
 *   - groupRef   : SVG <g> matrix transform for the marching-ants vector path
 *   - pathRef    : SVG <path> 'd' attribute (smooth or stair-stepped per Shape.antiAliased)
 *   - guidesRef  : Rule-of-thirds overlay opacity (auto-hide when zoom ≥ pixel-grid threshold)
 *
 * Caller is responsible for keeping `isActive=false` when the user is on an irregular tool
 * (lasso / wand) — that responsibility lives in `useIrregularSelectionSync` instead.
 */
export function useRegularCropSync(
  ref: React.RefObject<HTMLElement | null>,
  cropBox: LocalRect,
  isActive: boolean,
  isReCanvas: boolean,
  showGridThreshold: number | null
) {
  const { geometry } = useEditorServices();
  const groupRef = useRef<SVGGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const guidesRef = useRef<HTMLDivElement>(null);

  // Avoid TS6133: parameter intentionally retained for the public API symmetry expected by hooks.ts.
  void cropBox;

  useFastRectSync(ref, isActive, {
    selector: (_v, f) => {
      const shape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
      return shape.rect;
    },
    space: 'local'
  });

  useFastSvgGroupSync(groupRef, isActive, {
    selector: (_v, f) => {
      const shape = isReCanvas ? f.canvasCropBox : f.imageCropBox;
      return shape.rect;
    },
    space: 'local'
  });

  useFastSync(guidesRef, isActive, (_v, f, cam) => {
    if (guidesRef.current) {
      const k = geometry.getScale(f, cam);
      if (showGridThreshold !== null && k >= showGridThreshold) {
        guidesRef.current.style.opacity = '0';
      } else {
        guidesRef.current.style.opacity = '0.2';
      }
    }
  });

  useFastMarchingAntsSync(pathRef, isActive, {
    selector: (_v, f) => isReCanvas ? f.canvasCropBox : f.imageCropBox
  });

  // [Pre-PR-6 缺陷 A 修复] When isActive flips to false, the upstream
  // useFastSync* helpers stop *writing* attributes but the DOM still carries
  // the last-painted `d` / `transform` / `opacity`. Combined with the always-on
  // CSS `.marching-ants` animation, that produces a visible "ghost" of the
  // previous tool (e.g. white rect ants lingering after switching to lasso).
  //
  // Mounting-vs-unmounting these channels is intentionally avoided in §3.3.1
  // (animation-reset hazard), so we instead toggle `display:none` + clear `d`
  // on transition. `display:none` also pauses the CSS keyframes, which is the
  // exact behavior we want when the channel is logically inactive.
  useEffect(() => {
    if (isActive) {
      // Restore visibility; subsequent ticks will repaint d / transform.
      if (groupRef.current) groupRef.current.style.display = '';
      if (guidesRef.current) guidesRef.current.style.display = '';
      if (ref.current && (ref.current as HTMLElement).style) {
        (ref.current as HTMLElement).style.display = '';
      }
    } else {
      // Hide and zero-out so the marching-ants animation has nothing to render.
      if (groupRef.current) groupRef.current.style.display = 'none';
      if (pathRef.current) pathRef.current.setAttribute('d', '');
      if (guidesRef.current) {
        guidesRef.current.style.display = 'none';
        guidesRef.current.style.opacity = '0';
      }
      // Defensive: boxRef is already conditionally rendered out on irregular
      // tools, but if a future caller keeps it mounted we still want it gone.
      if (ref.current && (ref.current as HTMLElement).style) {
        (ref.current as HTMLElement).style.display = 'none';
      }
    }
  }, [isActive, ref, groupRef, pathRef, guidesRef]);

  return { syncStyle: {}, groupRef, pathRef, guidesRef };
}

/**
 * useCropBoxSync: legacy alias preserved so external consumers (if any) keep compiling.
 * **Deprecated** — prefer `useRegularCropSync` directly.
 */
export const useCropBoxSync = useRegularCropSync;

/**
 * useIrregularSelectionSync: Selection-polygon screen-space synchronizer for
 * **irregular** crop tools (lasso / wand / future polygon-lasso / AI-matting).
 * Drives:
 *
 *   - polyGroupRef : SVG <g> matrix transform anchored at the polygon `bounds`
 *                    origin (frame-local). When the *active tool's* slot in
 *                    `irregularCropBoxes` is empty the inner selector returns
 *                    null and `useFastSvgGroupSync` skips the setAttribute
 *                    call, producing zero-cost idle frames.
 *   - polyPathRef  : SVG <path> 'd' attribute, generated by
 *                    `geometry.polygon.polygonToSvgPathD`, coordinates
 *                    relative to `bounds.x/y` so the group transform places
 *                    it correctly on screen.
 *
 * **Per-tool isolation (Pre-PR-6-3):** the selector reads
 * `f.irregularCropBoxes[activeToolId]` rather than a single global slot. This
 * is the visual half of the "switching tools must clear the canvas" guarantee:
 * when the user is on lasso, the wand's polygon is not even read by this
 * hook, so its DOM stays empty / hidden — no `display: none` race against
 * pre-existing marching-ants animation. The data half is in
 * `setCropTool` (ClipOptions/commands.ts), which clears intra-family slots so
 * the new tool starts clean.
 *
 * Both refs are **always mounted** in the DOM; visibility is controlled solely
 * by `isActive` + selector returning null. This avoids React unmount-remount
 * cycles that would reset the marching-ants CSS animation.
 *
 * @param activeToolId  The currently active irregular tool id (`'lasso'` /
 *                      `'wand'` / ...). Caller is `useClipOverlayCommands`
 *                      which reads it from the `SIGNAL_CROP_TOOL` signal.
 *                      When the active tool is *not* an irregular one the
 *                      caller must pass `isActive=false`; this hook does not
 *                      double-check the family because callers already do.
 */
export function useIrregularSelectionSync(
  polyGroupRef: React.RefObject<SVGGElement | null>,
  polyPathRef: React.RefObject<SVGPathElement | null>,
  isActive: boolean,
  activeToolId: string
) {
  const { geometry } = useEditorServices();

  useFastSvgGroupSync(polyGroupRef, isActive, {
    selector: (_v, f) => f.irregularCropBoxes?.[activeToolId]?.bounds || null,
    space: 'local'
  });

  useFastMarchingAntsSync(polyPathRef, isActive, {
    selector: (_v, f) => {
      const poly = f.irregularCropBoxes?.[activeToolId];
      if (!poly) return null;
      return geometry.polygon.polygonToSvgPathD(poly);
    },
    // ▸ Pass `activeToolId` as `resetKey` so the hook's internal `lastD`
    // cache is invalidated on intra-irregular switches (lasso ↔ wand). See
    // `useFastMarchingAntsSync.options.resetKey` for the full rationale.
    // Without this, switching back to a tool whose slot still holds a
    // polygon would compute the *same* `d` as last time, the dirty-check
    // would skip the write, and the DOM would be permanently empty — the
    // exact "lasso polygon disappears after lasso → wand → lasso" bug.
    resetKey: activeToolId,
  });


  // [Pre-PR-6-3 缺陷修复] DOM cleanup on *family-level* deactivation only.
  //
  // History:
  //   • Original Pre-PR-6 fix wired this effect to `[isActive]` to hide the
  //     channel when leaving the irregular family (irregular → regular).
  //   • A 2026/6/23 attempt extended the deps with `activeToolId` and
  //     proactively cleared `d=''` on every intra-family switch, hoping that
  //     would clear the residual lasso path when switching to wand. That
  //     "fix" actually caused the *new* "lasso polygon never repaints when
  //     switching back" symptom — the imperative `setAttribute('d','')` ran
  //     **after** the next fast-track tick had written the correct lasso
  //     `d`, so the polygon was visible for ~1 frame and then erased.
  //
  // Permanent fix:
  //   • DOM clearing on `isActive=false` stays here (channel-level
  //     visibility is this effect's job, not fast-track's).
  //   • Intra-family target switches are now handled inside
  //     `useFastMarchingAntsSync` via the new `resetKey` option: it resets
  //     `lastD` on `activeToolId` change so the next tick re-paints the
  //     correct shape with no DOM-clearing race against ourselves.
  //   • For the "switch from lasso(non-empty) to wand(empty)" case: the
  //     selector returns `null`, fast-track skips the write, but the last
  //     painted `d` lingers. We catch that one specific case via a tiny
  //     same-frame `useLayoutEffect` below — it's safe because by the time
  //     this layout effect runs, the *next* fast-track tick has not started
  //     yet, so any `d=''` we write here will only be overwritten if the
  //     next tick actually has data to paint (i.e. the new tool's slot is
  //     non-empty), which is exactly the desired behavior.
  useEffect(() => {
    if (!isActive) {
      if (polyGroupRef.current) polyGroupRef.current.style.display = 'none';
      if (polyPathRef.current) polyPathRef.current.setAttribute('d', '');
      return;
    }
    if (polyGroupRef.current) polyGroupRef.current.style.display = '';
  }, [isActive, polyGroupRef, polyPathRef]);
}


