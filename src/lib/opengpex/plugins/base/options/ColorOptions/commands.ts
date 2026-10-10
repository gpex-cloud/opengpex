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

import { EditorCommand, EditorContextValue, LocalShape, asLocalShape } from '@opengpex/editor/core/types';
import { getClipBox } from '@opengpex/editor/core/helpers/selection';
import { fromHex, type ColorValue } from '@opengpex/editor/core/engine/color';

import * as P from './protocols';

/**
 * Land a picked colour, from the command layer.
 *
 * Mirrors the hook's `applyColor`: persist it as the pending fill colour, and —
 * when a `color` layer is active — mutate that layer live so the canvas follows
 * the picker. Duplicated here rather than reached through the hook because the
 * native `EyeDropper` is driven by a command (the tool strip / Tab cycle), which
 * has no React scope to call into.
 */
function landPickedColor(ctx: EditorContextValue, color: ColorValue): void {
  ctx.scoped?.setSelfConfig({ pendingColor: color });
  const { activeFrame, activeLayer, actions } = ctx;
  if (activeFrame && activeLayer?.type === 'color') {
    actions.updateLayer(activeFrame.id, activeLayer.id, {
      metadata: { ...activeLayer.metadata, fillColor: color },
    });
  }
}

/**
 * Hand over to the browser's native screen picker.
 *
 * MUST run with the canvas overlay already down: our own overlay paints a
 * crosshair + magnifier over everything, and the native picker samples the
 * COMPOSITED SCREEN — it would happily return the colour of our own chrome.
 * Cancelling the native picker rejects; that is a user action, not an error.
 */
async function openNativeEyeDropper(ctx: EditorContextValue): Promise<void> {
  if (typeof window === 'undefined' || !('EyeDropper' in window)) return;
  try {
    // @ts-expect-error — EyeDropper is not in TS's DOM lib yet
    const result = await new window.EyeDropper().open();
    if (result?.sRGBHex) landPickedColor(ctx, fromHex(result.sRGBHex));
  } catch {
    /* cancelled (Esc / click-away) — nothing to land */
  }
}

/**
 * Move the Tab cycle by one step over the modal strip's tools.
 *
 * Only `surface: 'strip'` tools are in the ring — `'screen'` lives on the option
 * bar and is momentary, so a ring holding it could not be traversed without
 * firing it. The cursor starts from the ACTIVE canvas tool (derived from the
 * persisted scope), never from a cached copy, so a click in the strip and a Tab
 * press always agree.
 */
function cycleSamplerTool(ctx: EditorContextValue, step: 1 | -1): void {
  const order = P.samplerStripTools().map((s) => s.id);
  if (order.length < 2) return;
  // `pluginConfig[key]` is a loose `Record<string, unknown>`; read the one
  // field we need rather than asserting the whole config shape.
  const cfg = ctx.state.pluginConfig[P.ColorOptionsAPI.configKey];
  const current = P.samplerToolFromScope(cfg?.sampleAllLayers !== false);
  const idx = order.indexOf(current);
  // `(idx + step + len) % len` keeps the modulo non-negative for step = -1.
  const next = order[(idx + step + order.length) % order.length];
  ctx.actions.executeCommand(P.ColorOptionsAPI.commands.setSamplerTool.uid, { tool: next });
}

/**
 * COLOR_OPTIONS_COMMANDS: Declarative command configuration.
 */
export const COLOR_OPTIONS_COMMANDS = {
  fillAsLayer: {
    id: P.CMD_FILL_AS_LAYER,
    name: 'Fill as New Layer',
    category: 'Color',
    undoable: true,
    shortcuts: [{ key: 'Backspace', alt: true }, { key: 'Delete', alt: true }],
    execute: (ctx: EditorContextValue, payload?: { fillColor: ColorValue }) => {
      const { state, actions, layers, activeFrame } = ctx;
      if (!activeFrame) return;

      // When invoked via keyboard shortcut, payload is undefined — read from plugin config
      const pickedColor = payload?.fillColor
        || (state.pluginConfig[`${P.PLUGIN_AUTHOR}.${P.PLUGIN_ID}`] as { pendingColor?: ColorValue } | undefined)?.pendingColor
        || fromHex('#EAB308');
      // Fill is always opaque: the pending colour may carry a sampled/edited
      // alpha, but the fill layer's coverage is governed by its own layer
      // opacity, not the colour value (Photoshop semantics — the foreground
      // colour has no alpha channel).
      const fillColor: ColorValue = { ...pickedColor, alpha: 1 };
      const isClipMode = state.interaction.interactionMode === 'clip';
      let w: number, h: number, box_cx: number, box_cy: number;
      let visibleShape: LocalShape;

      if (isClipMode) {
        const box = getClipBox(activeFrame);
        if (!box) {
          actions.setInteraction({ hud: { message: 'No active selection — draw a clip box first.', type: 'error' } });
          return;
        }

        {
          // ═══ All selections are now LocalPolygon ═══
          const bounds = box.rect;
          if (bounds.w <= 0 || bounds.h <= 0) {
            actions.setInteraction({ hud: { message: 'No active selection — draw a clip box first.', type: 'error' } });
            return;
          }
          w = bounds.w;
          h = bounds.h;
          box_cx = bounds.x + w / 2;
          box_cy = bounds.y + h / 2;

          // Serialize the polygon to a LocalShape for the layer model.
          // polygonToShape uses absolute coordinates (suitable for Path2D),
          // recognizes rect/circle shapes, and preserves the antiAliased flag
          // as the GPU pipeline's hard-edge signal.
          // The resulting shape's rect is in frame-local space (absolute coords),
          // but the layer is positioned at (cx, cy) relative to canvas center,
          // so we must offset the shape rect to layer-local space (origin at 0,0).
          const frameShape = ctx.geometry.polygon.polygonToShape(box);
          if (frameShape.type === 'rect') {
            visibleShape = {
              ...frameShape,
              rect: { x: 0, y: 0, w, h },
            } as LocalShape;
          } else if (frameShape.type === 'circle') {
            visibleShape = {
              ...frameShape,
              rect: { x: 0, y: 0, w, h },
            } as LocalShape;
          } else {
            // type:'path' — pathData uses absolute frame-local coords.
            // Offset to layer-local by subtracting bounds origin.
            const ox = bounds.x;
            const oy = bounds.y;
            const offsetPathData = (frameShape.pathData || '').replace(
              /([ML])\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g,
              (_m: string, cmd: string, x: string, y: string) =>
                `${cmd} ${parseFloat(x) - ox} ${parseFloat(y) - oy}`
            );
            visibleShape = {
              ...frameShape,
              rect: { x: 0, y: 0, w, h },
              pathData: offsetPathData,
            } as LocalShape;
          }
        }
      } else {
        w = activeFrame.canvas.w;
        h = activeFrame.canvas.h;
        box_cx = activeFrame.canvas.w / 2;
        box_cy = activeFrame.canvas.h / 2;
        visibleShape = asLocalShape({ x: 0, y: 0, w, h }, 'rect', true);
      }

      const cx = box_cx - activeFrame.canvas.w / 2;
      const cy = box_cy - activeFrame.canvas.h / 2;

      const newLayer = layers.getNewLayer({
        name: 'Fill Layer',
        type: 'color',
        cx,
        cy,
        locked: true,
        bounding: { w, h },
        visibleShape,
        metadata: { fillColor }
      });

      // Flush fast-track: ensure any in-progress volatile overrides have landed before modifying State
      actions.commitVolatile();

      layers.addLayer(activeFrame.id, newLayer);
      actions.setActiveLayer(activeFrame.id, newLayer.id);

      if (isClipMode) {
        actions.setInteraction({ interactionMode: 'pan' });
      }
    }
  } as EditorCommand<{ fillColor: ColorValue }, void>,

  /**
   * `I` — toggle the canvas sampler.
   *
   * The lifecycle lives in a plugin SIGNAL (not component state), so the tool
   * strip, the Tab cycle and any other plugin all read one truth. This replaced
   * a `window.dispatchEvent(new CustomEvent('coloroptions:toggle-sampler'))`
   * hack whose only listener was the owning hook's `useState`.
   */
  sampleColor: {
    id: P.CMD_SAMPLE_COLOR,
    name: 'Sample Color',
    category: 'Color',
    undoable: false,
    shortcut: { key: 'i' },
    execute: (ctx: EditorContextValue) => {
      const isSampling = ctx.state.interaction.interactionMode === 'sample';
      ctx.actions.setInteraction({ interactionMode: isSampling ? 'pan' : 'sample' });
      ctx.scoped?.setSignal(P.SIGNAL_SAMPLER_ACTIVE, !isSampling);
    }
  } as EditorCommand<void, void>,

  /**
   * Pick a sampler tool — the strip's buttons and the Tab cycle both come
   * through here, so tool selection has exactly one implementation.
   *
   * For the two canvas tools this only writes `sampleAllLayers`: the scope IS
   * the tool. Flipping it mid-sampling is safe and intended — the snapshot is
   * taken on the PRESS that starts a pick, so the next press simply captures the
   * new layer set. No release/re-capture chain, no debounce (see hooks.ts).
   *
   * `'screen'` is momentary: it drops the overlay FIRST (the native picker
   * samples the composited screen, including our crosshair) and then opens the
   * native `EyeDropper`.
   */
  samplerToolSet: {
    id: P.CMD_SET_SAMPLER_TOOL,
    name: 'Set Sampler Tool',
    category: 'Color',
    undoable: false,
    execute: (ctx: EditorContextValue, payload?: { tool: P.SamplerTool }) => {
      const s = payload?.tool ? P.SAMPLER_TOOL_STRATEGIES[payload.tool] : undefined;
      if (!s || (s.available && !s.available())) return;

      if (s.sampleAllLayers !== null) ctx.scoped?.setSelfConfig({ sampleAllLayers: s.sampleAllLayers });

      if (s.exitsCanvasSampling) {
        ctx.actions.setInteraction({ interactionMode: 'pan' });
        ctx.scoped?.setSignal(P.SIGNAL_SAMPLER_ACTIVE, false);
        void openNativeEyeDropper(ctx);
        return;
      }
      // Canvas tool chosen from somewhere other than the overlay (e.g. a future
      // menu entry): make sure the overlay is actually up.
      ctx.actions.setInteraction({ interactionMode: 'sample' });
      ctx.scoped?.setSignal(P.SIGNAL_SAMPLER_ACTIVE, true);
    }
  } as EditorCommand<{ tool: P.SamplerTool }, void>,

  /** Tab (bound by the overlay, not the hotkey registry — see protocols.ts). */
  samplerToolCycleForward: {
    id: P.CMD_CYCLE_SAMPLER_FORWARD,
    name: 'Cycle Sampler Tool (Forward)',
    category: 'Color',
    undoable: false,
    execute: (ctx: EditorContextValue) => {
      if (ctx.state.interaction.interactionMode !== 'sample') return;
      cycleSamplerTool(ctx, +1);
    }
  } as EditorCommand<void, void>,

  /** Shift+Tab — same binding rule as forward. */
  samplerToolCycleBackward: {
    id: P.CMD_CYCLE_SAMPLER_BACKWARD,
    name: 'Cycle Sampler Tool (Backward)',
    category: 'Color',
    undoable: false,
    execute: (ctx: EditorContextValue) => {
      if (ctx.state.interaction.interactionMode !== 'sample') return;
      cycleSamplerTool(ctx, -1);
    }
  } as EditorCommand<void, void>,

  /**
   * Leave the canvas sampler (the strip's "X"). Esc reaches the same state
   * through the overlay's own capture-phase handler → `onCancel`, which is why
   * this carries no shortcut: Esc already belongs to ClipOptions' exit command
   * in the global registry.
   */
  exitSampler: {
    id: P.CMD_EXIT_SAMPLER,
    name: 'Exit Color Sampler',
    category: 'Color',
    undoable: false,
    execute: (ctx: EditorContextValue) => {
      ctx.actions.setInteraction({ interactionMode: 'pan' });
      ctx.scoped?.setSignal(P.SIGNAL_SAMPLER_ACTIVE, false);
    }
  } as EditorCommand<void, void>
};
