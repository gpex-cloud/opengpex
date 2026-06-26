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

import { EditorContextValue, EditorCommand, asLocalRect, asLocalShape, Frame, LocalRect, LocalShape, EditorActions } from '@opengpex/editor/core/types';
import { getClipBox, getRegularClipShape } from '@opengpex/editor/core/helpers/selection';
import { CLIP_REGULAR_TOOL_SWITCH_INHERITS_BOUNDS } from '@opengpex/editor/core/helpers/presets';
import * as P from './protocols';
import type { CropTool } from './protocols';

/**
 * Single source of truth for "leave clip mode and discard any in-flight
 * peel/exchange triplet". Used by `exitClip` (Esc) and the `ClipOverlay`
 * unmount cleanup. See clip tool guide §4.6 for the full latency rationale.
 *
 * 2026-06-25 refactor: ESC now means "cancel" — if a peel was in progress,
 * the exchange is discarded (host hole mask removed, exchange reset) instead
 * of being baked. Baking is explicitly triggered by Enter (`commitPeel`).
 * This matches the universal "Enter = confirm, Esc = cancel" mental model.
 *
 * Order matters: flip mode FIRST so React/Zustand can tear down ClipOverlay
 * synchronously; defer `discardExchange` to a microtask so the dirty-check
 * fast path (no peel happened) doesn't block the visible mode flip.
 * `discardExchange` is idempotent — duplicate calls short-circuit.
 */
export function exitClipMode(ctx: EditorContextValue): void {
  ctx.actions.setInteraction({ interactionMode: 'pan' });
  queueMicrotask(() => {
    ctx.actions.adv.layer.peel.discardExchange.execute();
  });
}

/**
 * Helper: Unifies the retrieval and updating of the active crop target (Image vs Canvas).
 */
export function getActiveTarget(ctx: { activeFrame: Frame | null; actions: EditorActions }, isReCanvas: boolean) {
  const { activeFrame, actions } = ctx;
  if (!activeFrame) return null;
  const shape: LocalShape = isReCanvas
    ? activeFrame.canvasCropBox
    : (getRegularClipShape(activeFrame) || asLocalShape({ x: 0, y: 0, w: 0, h: 0 }));

  return {
    isReCanvas,
    shape,
    box: shape.rect,
    aspect: isReCanvas ? activeFrame.canvasAspect : activeFrame.imageAspect,
    setAspect: (val: number | undefined) => {
      const setter = isReCanvas ? actions.setCanvasAspect : actions.setImageAspect;
      setter(activeFrame.id, val);
    },
    updateShape: (patch: Partial<LocalShape>) => {
      if (isReCanvas) {
        actions.setCanvasCropBox(activeFrame.id, { ...shape, ...patch } as LocalShape);
      } else {
        const toolId = shape.type === 'circle' ? 'ellipse' : 'rect';
        actions.setClipBox(activeFrame.id, toolId, { ...shape, ...patch } as LocalShape);
      }
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
 * Cycle the active crop tool by `step` (+1 forward, -1 backward) within
 * the declaration order of `CROP_TOOL_STRATEGIES`. Shared by `toggleMode`
 * (Space) and `cycleToolBackward` (Shift+Space) so the dispatch path,
 * undo semantics and signal-read freshness stay in one place.
 *
 * We delegate the actual write to `setCropTool` (via the ClipOptions
 * instance UID) rather than calling `scoped.setSignal` directly, because
 * `setCropTool` carries the strategy projection (e.g. patching
 * `imageCropBox.type` to 'circle' when switching to ellipse) plus the
 * pluginConfig persistence (so cross-session restoration survives).
 *
 * Reading `SIGNAL_CROP_TOOL` directly (rather than caching a local copy)
 * means we always pick up the *latest* tool regardless of who last set it
 * (toolbar click, popover, or this very command in a previous beat).
 */
function cycleCropTool(ctx: EditorContextValue, step: 1 | -1): void {
  const order = Object.keys(P.CROP_TOOL_STRATEGIES) as CropTool[];
  const current = (ctx.activeFrame?.latestClipTool as CropTool | undefined) ?? order[0];
  const idx = order.indexOf(current);
  // `(idx + step + len) % len` keeps the modulo non-negative even for step=-1.
  const next = order[(idx + step + order.length) % order.length];
  ctx.actions.executeCommand(
    `${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}.${P.CMD_SET_CROP_TOOL}`,
    { tool: next }
  );
}

/**
 * CLIP_OPTIONS_COMMANDS: Declarative command configuration (Single Source of Truth).
 * Contains command metadata (ID, name, shortcuts) and implementation logic.
 */
export const CLIP_OPTIONS_COMMANDS = {
  /**
   * Space — context-sensitive single-key handler:
   *   1) From any non-clip mode → enter clip mode (no tool change).
   *   2) Already in clip mode  → cycle through `CROP_TOOL_STRATEGIES`
   *      in declaration order (rect → ellipse → lasso → wand → rect → …).
   *
   * Why fold cycling into the same key as enter? Because the user's mental
   * model is "Space toggles between work-modes": the first press lands them
   * in clip-with-the-last-tool, subsequent presses navigate within clip
   * without forcing a return trip to the toolbar Popover. Re-Canvas guard
   * (`forbiddenInReCanvas`) is honored — when Re-Canvas is active we skip
   * irregular tools so we don't push the user into an immediately-coerced
   * state (the Re-Canvas interceptor would yank them back to rect anyway).
   *
   * Exit is always `Esc` (`exitClip`); Space never leaves clip mode.
   */
  toggleMode: {
    id: P.CMD_TOGGLE_MODE,
    name: 'Enter / Cycle Clip Tool',
    execute: (ctx: EditorContextValue) => {
      // Re-Canvas is a fully *orthogonal* modal — it sits on top of pan and
      // owns its own visual chrome (rose-tinted rect on `canvasCropBox`).
      // We must NOT let Space leak into it, otherwise:
      //   1) "first press = enter clip" would yank the user out of pure
      //      Re-Canvas into a clip + Re-Canvas hybrid;
      //   2) "subsequent press = cycle tool" would write `SIGNAL_CROP_TOOL`,
      //      `setCropTool` would project shape onto `canvasCropBox` (since
      //      `isReCanvas` is true), and the rose-tinted rect would flip to
      //      a circle. Both are confusing and violate the §3.2 orthogonality
      //      contract.
      // Solution: when Re-Canvas is active, Space is a no-op. Esc remains
      // the single exit (handled by `exitClip` below — it closes Re-Canvas
      // first, then leaves clip if applicable).
      if (ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS)) return;

      // First press: just enter clip mode, keep current tool.
      if (ctx.state.interaction.interactionMode !== 'clip') {
        ctx.actions.setInteraction({ interactionMode: 'clip' });
        return;
      }

      // Subsequent presses: cycle tool forward.
      cycleCropTool(ctx, +1);
    },
    shortcut: { key: ' ' }
  } as EditorCommand<void, void>,

  /**
   * Shift+Space — reverse cycle through clip tools (rect ← ellipse ← lasso
   * ← wand ← rect …). Mirror of `toggleMode`'s subsequent-press behavior
   * for users who overshoot the desired tool.
   *
   * Behavior contract (parity with `toggleMode`):
   *   1) Re-Canvas active            → no-op (orthogonal modal owns Space).
   *   2) Not in clip mode            → enter clip mode, no tool change.
   *      (Same as plain Space; Shift accidentally held while entering
   *      shouldn't punish the user with a tool jump.)
   *   3) In clip mode                → cycle backward via `setCropTool`.
   *
   * Implementation shares `cycleCropTool` with `toggleMode`, so the
   * Re-Canvas-skip filter, undo semantics, and signal-read freshness all
   * stay in one place.
   */
  cycleToolBackward: {
    id: P.CMD_CYCLE_TOOL_BACKWARD,
    name: 'Cycle Clip Tool (Backward)',
    execute: (ctx: EditorContextValue) => {
      if (ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS)) return;
      if (ctx.state.interaction.interactionMode !== 'clip') {
        ctx.actions.setInteraction({ interactionMode: 'clip' });
        return;
      }
      cycleCropTool(ctx, -1);
    },
    shortcut: { key: ' ', shift: true }
  } as EditorCommand<void, void>,



  /**
   * Escape — context-sensitive exit. Three branches, in priority order:
   *   1) Re-Canvas open  → close Re-Canvas only (its rect / popover collapses).
   *                        Mode is preserved. If we were in pure Re-Canvas
   *                        from pan, we stay in pan; if we were in clip,
   *                        we stay in clip.
   *   2) Clip mode       → exit clip via the standard `exitClipMode` helper
   *                        (mode → 'pan' + microtask mergeHost).
   *   3) Neither         → no-op (let overlay-level Esc handlers — text,
   *                        brush, etc. — run their own logic without
   *                        conflict).
   *
   * Why split (1) and (2)? Before 2026-06-23 Re-Canvas was a sub-modal of
   * clip, so closing it always implied "still in clip". Re-Canvas is now an
   * orthogonal modal (you can be in pure pan + Re-Canvas), so the two
   * dismissals must be independent.
   */
  exitClip: {
    id: P.CMD_EXIT_CLIP_MODE,
    name: 'Exit Clip / Re-Canvas',
    execute: (ctx: EditorContextValue) => {
      if (ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS)) {
        ctx.scoped.setSignal(P.SIGNAL_RE_CANVAS, false);
        return;
      }
      if (ctx.state.interaction.interactionMode !== 'clip') return;
      exitClipMode(ctx);
    },
    shortcut: { key: 'Escape' }
  } as EditorCommand<void, void>,

  /**
   * Enter — commit the peel (bake exchange into host) and exit clip mode.
   *
   * This is the explicit "confirm" gesture for peel operations. If no peel
   * is in progress (triplet is clean), the command still exits clip mode as
   * a convenient "done editing selections" shortcut — matching Photoshop's
   * Enter-exits-transform behaviour.
   *
   * Flow:
   *   1) Call `mergeHost` to bake any dirty peel triplet.
   *   2) Exit clip mode via `exitClipMode` (which now only discards —
   *      but since we just merged, the triplet is already clean so the
   *      discard call inside `exitClipMode` becomes a no-op).
   *
   * Only active while in clip mode; no-op otherwise so Enter doesn't
   * interfere with text inputs or other overlay interactions.
   */
  commitPeel: {
    id: P.CMD_COMMIT_PEEL,
    name: 'Commit Peel & Exit Clip',
    execute: async (ctx: EditorContextValue) => {
      if (ctx.state.interaction.interactionMode !== 'clip') return;

      // Bake the peel (mergeHost is async — waits for off-screen composite).
      await ctx.actions.adv.layer.merge.mergeHost.execute();

      // Exit clip mode. Since we just merged, the triplet is now clean and
      // the discardExchange inside exitClipMode will be a no-op.
      exitClipMode(ctx);
    },
    shortcut: { key: 'Enter' }
  } as EditorCommand<void, Promise<void>>,

  /**
   * toggleReCanvas — opens / closes the canvas-resize modal.
   *
   * As of 2026-06-23, Re-Canvas is a *fully orthogonal* modal layered on
   * top of pan; it is NOT a sub-modal of clip. The previous "auto-promote
   * to clip mode on activation" behaviour has been removed because it
   * caused two surprises:
   *   1) clicking Re-Canvas from pan would force the user into clip mode
   *      (visible by the side-bar toggle flipping), which they didn't ask
   *      for;
   *   2) once in that hybrid state, Space (cycle tool) would project
   *      lasso / wand / circle shapes onto `canvasCropBox`, flipping the
   *      rose-tinted rect into a circle — also unexpected.
   *
   * Now: activating Re-Canvas only writes the `SIGNAL_RE_CANVAS` signal +
   * coerces `canvasCropBox.type` to 'rect' (resizing only makes sense on
   * a rectangular footprint). The ClipOverlay mounts whenever Re-Canvas
   * is on (see `components.tsx::isOverlayActive`) regardless of
   * interactionMode, and the clipbox InteractionHandler admits pointer
   * events whenever Re-Canvas is on (see `interactions.ts::makeCropToolGuard`).
   *
   * Deactivation never changes mode, mirroring activation — this leaves
   * the user wherever they were (pan, clip, etc.) before opening
   * Re-Canvas. Esc closes Re-Canvas first (see `exitClip` above), so a
   * single Esc from "pan + Re-Canvas" returns to plain pan.
   */
  toggleReCanvas: {
    id: P.CMD_RE_CANVAS_TOGGLE,
    name: 'Toggle Resize Canvas Mode',
    execute: (ctx: EditorContextValue) => {
      const isActivating = !ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS);

      if (isActivating && ctx.activeFrame) {
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
      exitClipMode(ctx);
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
    name: 'Clear Selection',
    undoable: true,
    /**
     * Double-click (or programmatic) clear — removes the active tool's
     * selection. Works for ALL clip tools (rect / ellipse / lasso / wand).
     *
     * Re-Canvas mode is excluded (the canvas crop box must always exist).
     *
     * Uses `getClipBox` to resolve the active slot, then writes `null` to
     * clear it. This is the "Clear Selection" entry point referenced in the
     * clip tool guide §7.2 roadmap.
     */
    execute: (ctx: EditorContextValue) => {
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      if (isReCanvas) return; // Re-Canvas crop box must always exist

      const frame = ctx.activeFrame;
      if (!frame) return;

      const tool = (frame.latestClipTool as CropTool) || 'rect';
      const clipBox = getClipBox(frame);
      if (!clipBox) return; // already empty — nothing to clear

      ctx.actions.setClipBox(frame.id, tool, null);
    }
  } as EditorCommand<void, void>,

  toggleAntiAlias: {
    id: P.CMD_TOGGLE_ANTI_ALIAS,
    name: 'Toggle Anti-Alias',
    undoable: true,
    // ─── Shortcut: double-tap `A` ──────────────────────────────────────────
    // Why double-tap rather than single?
    //   1) The single-letter `A` collides with too many adjacent idioms
    //      (selection/navigation in other UIs) — would mis-fire constantly.
    //   2) Tap-tap matches the muscle memory used elsewhere in the editor
    //      for "commit a transient toggle".
    // The `HotkeyManager` honours `taps` declaratively (≥2 → enforce a
    // 400ms tap window, swallow intermediate keystrokes, reject `e.repeat`).
    // Modifier-key shortcuts (Cmd+A select-all) remain on the single-tap
    // path because their modifier mask differs.
    //
    // Runtime guards (mode / re-canvas / tool family) are enforced **inside
    // execute()** below so the shortcut is silently no-op'd when invalid —
    // we deliberately do NOT block at the `beforeExecute` interceptor
    // layer, because the UI button calling this command also relies on the
    // same guards being honoured by the command itself (defence in depth).
    shortcut: { key: 'a', taps: 2 },
    execute: (ctx: EditorContextValue) => {
      // ─── Guards ────────────────────────────────────────────────────────
      // Mirror the AA button's `disabled` rules (clip mode active, active
      // strategy supports AA, not in Re-Canvas). Re-evaluated at fire time
      // so toggling tools / opening Re-Canvas mid-keystroke can't dispatch
      // on stale state.
      if (ctx.state.interaction.interactionMode !== 'clip') return;
      const isReCanvas = !!ctx.scoped!.getSignal(P.SIGNAL_RE_CANVAS);
      if (isReCanvas) return; // canvas-resize is a frozen rectangle
      const tool = (ctx.activeFrame?.latestClipTool as CropTool | undefined) ?? 'rect';
      if (!P.CROP_TOOL_STRATEGIES[tool]?.supportsAntiAlias) return;

      // ─── Unified path via getClipBox ─────────────────────────────────
      // getClipBox resolves the correct slot by latestClipTool and returns
      // `{ regular, spatial }`. We branch on `.regular` (data-level truth)
      // rather than on strategy.family (config-level declaration).
      const frame = ctx.activeFrame;
      if (!frame) return;
      const clipBox = getClipBox(frame);
      if (!clipBox) return;

      const currentAA = clipBox.spatial.antiAliased ?? true;
      if (clipBox.regular) {
        // Regular (ellipse): route through getActiveTarget for proper write
        const target = getActiveTarget(ctx, isReCanvas);
        if (target) target.updateShape({ antiAliased: !currentAA });
      } else {
        // Irregular (lasso / wand): patch polygon directly
        const newPoly = { ...clipBox.spatial, antiAliased: !currentAA };
        ctx.actions.setClipBox(frame.id, tool, newPoly);
      }
    }
  } as EditorCommand<void, void>,


  /**
   * setCropTool — strategy-driven tool switch.
   *
   * Side-effect matrix (by `family`):
   *   - regular → regular   : `projectShape()` patches imageCropBox.type.
   *   - regular → irregular : no data write; regular box visually hides via
   *                           `useRegularCropSync` isActive=false cleanup.
   *   - irregular → regular : no data write; irregular polygon visually hides
   *                           via `useIrregularSelectionSync` isActive=false.
   *   - irregular → irregular : no data write. Per-tool slots in
   *                           `irregularCropBoxes` mean the visual gate reads
   *                           the new tool's (empty) slot and the canvas
   *                           clears automatically; the previous tool's slot
   *                           is preserved for round-trip symmetry.
   *
   * Slot clears only happen via:
   *   1) `adv.layer.clip.toMask` (mission accomplished);
   *   2) explicit "Clear Selection" command (future).
   *
   * Atomicity: signal is written first (session-only), projection second
   * (undoable), so Cmd+Z reverts the box mutation while the tool stays
   * selected — matches Photoshop.
   */
  setCropTool: {
    id: P.CMD_SET_CROP_TOOL,
    name: 'Set Crop Tool',
    undoable: true,
    execute: (ctx: EditorContextValue, payload: { tool: CropTool }) => {
      const { activeFrame, actions, scoped } = ctx;
      if (!activeFrame || !payload?.tool) return;

      const tool = payload.tool;

      // Write to frame model (per-frame, persistent, participates in undo).
      actions.updateFrame(activeFrame.id, { latestClipTool: tool });

      const strategy = P.CROP_TOOL_STRATEGIES[tool];

      // Regular projection: patch `shape.type` on the active crop box.
      // `projectShape` is `undefined` for irregular tools — branch skipped.
      // Spread order: `target` first inherits `antiAliased`, then `projection`
      // overrides `type` (and `antiAliased` only if a tool explicitly pins it).
      const projection = strategy.projectShape?.();
      if (projection) {
        const isReCanvas = !!scoped?.getSignal(P.SIGNAL_RE_CANVAS);
        if (isReCanvas) {
          actions.setCanvasCropBox(activeFrame.id, { ...activeFrame.canvasCropBox, ...projection });
        } else {
          const newSlot = projection.type === 'circle' ? 'ellipse' : 'rect';
          const oldSlot = newSlot === 'ellipse' ? 'rect' : 'ellipse';

          if (CLIP_REGULAR_TOOL_SWITCH_INHERITS_BOUNDS) {
            // Inherit mode: copy bounds from the previous regular slot into the
            // new slot with the projected shape type. The user sees the same
            // area but a different shape — good for "try ellipse on the same
            // region" workflows.
            //
            // IMPORTANT: Do NOT use `getRegularClipShape(activeFrame)` here.
            // `activeFrame` is the pre-update snapshot — `latestClipTool` is
            // stale (still the old tool). If coming from an irregular tool
            // (lasso/wand), the stale pointer makes `getClipBox` read the
            // polygon slot, fail the `regular` check, return undefined, and
            // the fallback overwrites the user's rect/ellipse with an empty
            // 0×0 shape — destroying the selection they expect to see on
            // return. Reading clipBoxes directly avoids this trap.
            const sourceClip = (activeFrame.clipBoxes[oldSlot] as LocalShape | undefined)
                             ?? (activeFrame.clipBoxes[newSlot] as LocalShape | undefined)
                             ?? asLocalShape({ x: 0, y: 0, w: 0, h: 0 });
            actions.setClipBox(activeFrame.id, newSlot, { ...sourceClip, ...projection } as LocalShape);
          } else {
            // Independent mode (Photoshop-style): new tool starts clean. Only
            // project the shape type; don't copy bounds from the old tool.
            // The user must draw a fresh selection.
            const existing = activeFrame.clipBoxes[newSlot];
            if (existing) {
              actions.setClipBox(activeFrame.id, newSlot, { ...existing, ...projection } as LocalShape);
            }
          }

          // Always clear the old regular slot so `getRegularClipShape` (which
          // returns the first non-empty REGULAR_CLIP_SLOTS entry) doesn't keep
          // returning the stale slot. Without this, switching rect→ellipse
          // leaves clipBoxes['rect'] populated and the overlay keeps rendering
          // the old rectangular selection instead of the new elliptical one.
          if (activeFrame.clipBoxes[oldSlot]) {
            actions.setClipBox(activeFrame.id, oldSlot, null);
          }
        }
      }
    }
  } as EditorCommand<{ tool: CropTool }, void>

};



/**
 * CLIP_INTERCEPTORS: Middleware logic for the plugin.
 */
export const CLIP_INTERCEPTORS = {
  beforeExecute: (id: string, ctx: EditorContextValue): boolean => {
    if (!id.endsWith(P.CMD_RE_CANVAS_TOGGLE)) return false;

    // Pressing Re-Canvas while it is already on collapses it back to plain
    // clip mode (swallow the toggle).
    if (ctx.scoped?.getSignal(P.SIGNAL_RE_CANVAS)) {
      ctx.scoped?.setSignal(P.SIGNAL_RE_CANVAS, false);
      return true;
    }

    // ─── Why we DO NOT mutate SIGNAL_CROP_TOOL on Re-Canvas entry ──────────
    // Earlier revisions force-set SIGNAL_CROP_TOOL to 'rect' here whenever
    // the user entered Re-Canvas with an irregular tool (lasso / wand)
    // selected, on the theory that "canvas-resize is rectangular-only".
    // That mutation was destructive: there was no symmetric restore on
    // Re-Canvas exit, so closing Re-Canvas (Esc) left the user on 'rect'
    // even when they had originally been on lasso / wand / ellipse — the
    // canvas would then render the *previous* shape (e.g. the ellipse the
    // user had just drawn) under a toolbar that claimed 'rect' was active,
    // giving the misleading "tool says rect, selection is ellipse" UX
    // reported as the 2026-06-23 bug 1 in the clip-tool guide.
    //
    // The "rect-only during Re-Canvas" semantic is already enforced
    // *non-destructively* by the synthesis layer:
    //   • ClipOverlay/hooks.ts → `effectiveTool: CropTool = isReCanvas ? 'rect' : rawTool`
    //   • interactions.ts::makeCropToolGuard → same synthesis on the dispatch path
    // so during Re-Canvas the canvas rect is draggable and the ellipse /
    // lasso / wand handlers are filtered out, all without touching the
    // user's actual tool selection. When Re-Canvas closes, the original
    // signal value is preserved and the user lands back on whichever tool
    // they had — exactly the round-trip behaviour the orthogonal-modal
    // design (§3.2 of the guide) promises.
    return false;
  }
};

