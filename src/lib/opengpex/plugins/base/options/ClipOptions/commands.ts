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

import { EditorContextValue, EditorCommand, asLocalRect, Frame, LocalRect, EditorActions } from '@opengpex/editor/core/types';
import * as P from './protocols';
import type { CropTool } from './protocols';

/**
 * Helper: Unifies the retrieval and updating of the active crop target (Image vs Canvas).
 */
export function getActiveTarget(ctx: { activeFrame: Frame | null; actions: EditorActions }, isReCanvas: boolean) {
  const { activeFrame, actions } = ctx;
  if (!activeFrame) return null;
  const shape = isReCanvas ? activeFrame.canvasCropBox : activeFrame.imageCropBox;

  return {
    isReCanvas,
    shape,
    box: shape.rect,
    aspect: isReCanvas ? activeFrame.canvasAspect : activeFrame.imageAspect,
    setAspect: (val: number | undefined) => {
      const setter = isReCanvas ? actions.setCanvasAspect : actions.setImageAspect;
      setter(activeFrame.id, val);
    },
    updateShape: (patch: Partial<typeof shape>) => {
      const setter = isReCanvas ? actions.setCanvasCropBox : actions.setImageCropBox;
      setter(activeFrame.id, { ...shape, ...patch });
    },
    clampRect: (box: LocalRect) => {
      if (isReCanvas) return box;
      const cx = Math.max(0, Math.min(box.x, activeFrame.canvas.w - box.w));
      const cy = Math.max(0, Math.min(box.y, activeFrame.canvas.h - box.h));
      return { ...box, x: cx, y: cy };
    }
  };
}

/**
 * CLIP_OPTIONS_COMMANDS: Declarative command configuration (Single Source of Truth).
 * Contains command metadata (ID, name, shortcuts) and implementation logic.
 */
export const CLIP_OPTIONS_COMMANDS = {
  toggleMode: {
    id: P.CMD_TOGGLE_MODE,
    name: 'Toggle Pan/Clip Mode',
    execute: (ctx: EditorContextValue) => {
      const currentMode = ctx.state.interaction.interactionMode;

      // Space bar behavior:
      // - From clip → go to pan (and commit composite layer merge)
      // - From any other mode (pan, craft) → go to clip
      if (currentMode === 'clip') {
        ctx.actions.adv.layer.merge.mergeHost.execute();
        ctx.actions.setInteraction({
          interactionMode: 'pan',
        });
      } else {
        ctx.actions.setInteraction({
          interactionMode: 'clip',
        });
      }
    },
    shortcut: { key: ' ' }
  } as EditorCommand<void, void>,

  toggleReCanvas: {
    id: P.CMD_RE_CANVAS_TOGGLE,
    name: 'Toggle Resize Canvas Mode',
    execute: (ctx: EditorContextValue) => {
      const isActivating = !ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS);

      if (isActivating && ctx.activeFrame) {
        // Force Rectangular shape for Canvas Resizing
        ctx.actions.setCanvasCropBox(ctx.activeFrame.id, {
          ...ctx.activeFrame.canvasCropBox,
          type: 'rect'
        });
      }

      ctx.scoped?.toggleSignal(P.SIGNAL_RE_CANVAS);
    }
  } as EditorCommand<void, void>,

  applyReCanvas: {
    id: P.CMD_RE_CANVAS_APPLY,
    name: 'Apply Canvas Resize',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      if (!ctx.activeFrame) return;
      ctx.actions.adv.frame.resize.resizeCanvas.execute();
      ctx.scoped?.setSignal(P.SIGNAL_RE_CANVAS, false);
      ctx.actions.setInteraction({
        interactionMode: 'pan',
      });
    }
  } as EditorCommand<void, void>,

  setAspect: {
    id: P.CMD_SET_ASPECT,
    name: 'Set Aspect Ratio',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { aspect: number | undefined }) => {
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      const target = getActiveTarget(ctx, isReCanvas);
      if (!target) return;

      const targetRatio = payload.aspect;

      if (targetRatio && target.box) {
        const canvasW = ctx.activeFrame!.canvas.w;
        const canvasH = ctx.activeFrame!.canvas.h;
        const originalShortEdge = Math.min(target.box.w, target.box.h);

        let newW = targetRatio >= 1 ? originalShortEdge * targetRatio : originalShortEdge;
        let newH = targetRatio >= 1 ? originalShortEdge : originalShortEdge / targetRatio;

        if (newW > canvasW) {
          newW = canvasW;
          newH = newW / targetRatio;
        }
        if (newH > canvasH) {
          newH = canvasH;
          newW = newH * targetRatio;
        }

        const nextBox = asLocalRect({
          ...target.box,
          x: target.box.x + (target.box.w - newW) / 2,
          y: target.box.y + (target.box.h - newH) / 2,
          w: newW,
          h: newH
        });

        const finalBox = target.clampRect(nextBox);
        target.updateShape({ rect: finalBox });
        target.setAspect(targetRatio);
      } else {
        target.setAspect(targetRatio);
      }
    }
  } as EditorCommand<{ aspect: number | undefined }, void>,

  resetAspect: {
    id: P.CMD_RESET_ASPECT,
    name: 'Reset Aspect Ratio',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      const target = getActiveTarget(ctx, isReCanvas);
      if (target) target.setAspect(undefined);
    }
  } as EditorCommand<void, void>,

  createBranch: {
    id: P.CMD_BRANCH,
    name: 'Create Branch',
    undoable: true,
    execute: async (ctx: EditorContextValue, payload: { rect: DOMRect }) => {
      const { activeFrame, actions } = ctx;
      if (!activeFrame) return;

      const trunkId = activeFrame.parentId || activeFrame.id;
      const thumbnailUrl = await actions.adv.frame.create.branch.execute();

      if (thumbnailUrl && payload?.rect) {
        window.dispatchEvent(new CustomEvent('editor:branch-fly', {
          detail: { rect: payload.rect, thumbnailUrl, trunkId }
        }));
      }
    },
    shortcut: { key: 's', meta: true, shift: true }
  } as EditorCommand<{ rect: DOMRect }, Promise<void>>,

  resetBox: {
    id: P.CMD_RESET_BOX,
    name: 'Reset Crop Box',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      const target = getActiveTarget(ctx, isReCanvas);
      if (!target || ctx.activeFrame!.canvas.w === 0) return;

      const canvasDim = ctx.activeFrame!.canvas;
      const w = canvasDim.w * 0.5;
      const h = canvasDim.h * 0.5;
      const x = (canvasDim.w - w) / 2;
      const y = (canvasDim.h - h) / 2;

      target.updateShape({ rect: asLocalRect({ x, y, w, h }) });
    }
  } as EditorCommand<void, void>,

  toggleAntiAlias: {
    id: P.CMD_TOGGLE_ANTI_ALIAS,
    name: 'Toggle Anti-Alias',
    undoable: true,
    execute: (ctx: EditorContextValue) => {
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      const target = getActiveTarget(ctx, isReCanvas);
      if (target) target.updateShape({ antiAliased: target.shape.antiAliased === false ? true : false });
    }
  } as EditorCommand<void, void>,

  /**
   * setCropTool — unified entry for tool switching (§3.2.3).
   *
   * Side-effect matrix:
   *   - rect / ellipse-smooth / ellipse-pixel:
   *       1. write `cropTool` signal
   *       2. project onto active `imageCropBox` / `canvasCropBox`:
   *            type        = tool === 'rect' ? 'rect' : 'circle'
   *            antiAliased = tool === 'ellipse-pixel' ? false : true
   *       NOTE: `irregularCropBox` is intentionally **NOT cleared** here. The
   *       purple polygon channel is hidden purely via the visual gate inside
   *       `useIrregularSelectionSync` (`isActive = isClipActive && isIrregularTool`),
   *       which fires `display:none` + `d=""` on the SVG. Preserving the data
   *       lets users round-trip lasso → rect → lasso without losing their
   *       polygon — symmetric with how rect/ellipse keep `imageCropBox` across
   *       tool switches. Explicit clearing now requires a user gesture
   *       (Apply Mask button → toLayerMask command, or future "Clear Selection"
   *       command). The Re-Canvas interceptor only flips the *tool signal* back
   *       to 'rect' (so the irregular SVG channel hides via §A DOM cleanup);
   *       it does **not** clear `irregularCropBox` either — see §3.2.4 + the
   *       second-pass fix comment in `CLIP_INTERCEPTORS.beforeExecute` below.
   *   - lasso / wand:
   *       1. write `cropTool` signal
   *       2. NO immediate write to `irregularCropBox` — wait for the user's first
   *          drag (lasso) / click (wand) so the empty state is preserved until
   *          they actually commit a selection.
   *
   * Atomicity: this command intentionally writes the signal FIRST and only then
   * does the projection. The signal is session-only (not undoable), the box
   * mutation IS undoable; combined the user can Cmd+Z the projection but the
   * tool stays selected — matches Photoshop's behaviour.
   */
  setCropTool: {
    id: P.CMD_SET_CROP_TOOL,
    name: 'Set Crop Tool',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { tool: CropTool }) => {
      const { activeFrame, actions, scoped } = ctx;
      if (!activeFrame || !payload?.tool) return;

      const tool = payload.tool;
      scoped?.setSignal(P.SIGNAL_CROP_TOOL, tool);

      // Pre-PR-6-2: replace the previous 30-line if-chain with a strategy
      // table lookup. `projectShape` is `undefined` for irregular tools
      // (lasso / wand), so the projection branch is skipped naturally —
      // the data-preservation rule "do NOT clear irregularCropBox on tool
      // switch" still holds, simply because we don't touch it.
      const strategy = P.CROP_TOOL_STRATEGIES[tool];
      const projection = strategy.projectShape?.();
      if (projection) {
        const isReCanvas = !!scoped?.getSignal(P.SIGNAL_RE_CANVAS);
        const setter = isReCanvas ? actions.setCanvasCropBox : actions.setImageCropBox;
        const target = isReCanvas ? activeFrame.canvasCropBox : activeFrame.imageCropBox;
        setter(activeFrame.id, { ...target, ...projection });
      }
      // Note: we deliberately do NOT clear `irregularCropBox` for
      // family === 'irregular' tools either; round-trip preservation
      // (lasso → rect → lasso keeps the polygon) is the documented
      // contract — see Pre-PR-6 second-pass fix in the interceptor below.
    }
  } as EditorCommand<{ tool: CropTool }, void>
};



/**
 * CLIP_INTERCEPTORS: Middleware logic for the plugin.
 */
export const CLIP_INTERCEPTORS = {
  beforeExecute: (id: string, ctx: EditorContextValue): boolean => {
    if (id.endsWith(P.CMD_TOGGLE_MODE) || id.endsWith(P.CMD_RE_CANVAS_TOGGLE)) {
      if (ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS)) {
        ctx.scoped?.setSignal(P.SIGNAL_RE_CANVAS, false);
        return true;
      }
    }

    // Re-Canvas force-rect (§3.2.4): when the user toggles into Re-Canvas mode
    // while an irregular tool is active, we must coerce cropTool back to 'rect'
    // because canvas resizing operates on a rectangular footprint only. The
    // signal flip here is intentionally unconditional (no return true) so the
    // Re-Canvas toggle command itself still proceeds.
    //
    // [Pre-PR-6 second-pass fix] DO NOT clear `irregularCropBox` here either —
    // visual hiding is already guaranteed by §A's `useIrregularSelectionSync`
    // `useEffect([isActive])` cleanup (cropTool flipped to 'rect' →
    // isIrregularTool=false → display:none + d=""). Clearing the polygon data
    // would break round-trip preservation: user reported scenario "draw lasso
    // → click re-canvas → exit/re-enter clip → switch back to lasso" lost the
    // polygon, asymmetric with rect/ellipse keeping their box across the same
    // round-trip. The only places that should clear `irregularCropBox` are:
    //   1) `adv.irregular.selection.toLayerMask` (mission accomplished, atomic clear)
    //   2) explicit user "Clear Selection" command (future)
    if (id.endsWith(P.CMD_RE_CANVAS_TOGGLE)) {
      const tool = ctx.scoped?.getSignal(P.SIGNAL_CROP_TOOL) as CropTool | undefined;
      // Pre-PR-6-2: replace the literal `tool === 'lasso' || tool === 'wand'`
      // check with a strategy-driven `forbiddenInReCanvas` flag — adding a
      // future tool that should also be force-fallback-to-rect requires zero
      // changes here, just `forbiddenInReCanvas: true` on its row.
      if (tool && P.CROP_TOOL_STRATEGIES[tool].forbiddenInReCanvas) {
        ctx.scoped?.setSignal(P.SIGNAL_CROP_TOOL, 'rect');
        // NOTE: do not touch irregularCropBox — see comment above.
      }
    }

    return false;
  }
};
