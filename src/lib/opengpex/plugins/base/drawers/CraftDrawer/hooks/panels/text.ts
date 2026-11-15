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

import { useCallback, useMemo, useEffect, useRef } from 'react';
import { useEditorState, useEditorServices, usePluginSelfConfig, usePluginConfig } from '@opengpex/editor/core/context';
import { TextOverlayAPI, TEXT_SESSION_RAW_EDITS } from '@opengpex/editor/plugins/base/overlays/TextOverlay/protocols';
import { DEFAULT_TEXT_STYLE, pickStyleFields } from '@opengpex/editor/plugins/base/overlays/TextOverlay/hooks/styling';
import { ColorOptionsAPI, type ColorOptionsApplyEventDetail } from '@opengpex/editor/plugins/base/options/ColorOptions/protocols';
import { getReferenceFontSize } from '../../protocols';
import { CraftDrawerConfig } from '../../protocols';
import { TextLayerData } from '@opengpex/editor/core/types';
import { fromHex, convertColorGamut, WORKING_GAMUT, type ColorValue } from '@opengpex/editor/core/engine/color';

// ─── Default text style constants ──────────────────────────────────────────────

/** Stable fallback ColorValue when no `pendingColor` exists yet (module-scoped so identity is stable across renders). Seeded in WORKING_GAMUT form — `pendingColor`'s canonical storage representation (white is gamut-invariant, so the seed is numerically identical to plain sRGB white). */
const DEFAULT_TEXT_COLOR: ColorValue = convertColorGamut(fromHex('#FFFFFF'), WORKING_GAMUT);

// ─── useTextPanel ──────────────────────────────────────────────────────────────

/**
 * useTextPanel: Semantic Hook for TextPanel text attribute panel
 *
 * Provides currently editing text layer data and attribute update methods.
 * When no target layer exists (pre-edit state), reads/writes from pendingTextData
 * in pluginConfig to persist user's text style choices across layer creation.
 */
export function useTextPanel() {
  const { state, activeFrame, activeLayer } = useEditorState();
  const { actions } = useEditorServices();
  const [selfConfig, setSelfConfig] = usePluginSelfConfig<CraftDrawerConfig>();

  const editingLayerId = state.interaction.signals[TextOverlayAPI.signals.editingTextLayerId] as string | null;
  const editingLayerExists = !!(editingLayerId && activeFrame?.layers.byId[editingLayerId]);

  // Gets text layer currently editing (prioritizes editing signal, followed by activeLayer)
  const targetLayerId = (editingLayerExists ? editingLayerId : null) || (activeLayer?.type === 'text' ? activeLayer.id : null);
  const targetLayer = targetLayerId && activeFrame ? activeFrame.layers.byId[targetLayerId] : null;
  // Read the MERGED layer (fast-track draft ⊕ slow track), not the raw Redux
  // layer: while an inline text editing session is live, typed content and
  // live box geometry live only in the volatile draft — the slow track is
  // frozen until the session's commit exit. A direct read per render keeps
  // the panel's control values on the live truth; no reactive subscription is
  // needed (style writes land in the slow track through ledgered commands and
  // re-render this hook anyway). Outside a session this degenerates to the
  // plain Redux layer.
  const liveTargetLayer = targetLayerId && activeFrame ? actions.fast.latestLayer(activeFrame.id, targetLayerId) : null;
  const layerTextData = liveTargetLayer?.textData ?? targetLayer?.textData;

  // ─── Pending Text Data (pre-edit state persistence) ─────────────────────────
  const pendingTextData = selfConfig.pendingTextData || DEFAULT_TEXT_STYLE;

  // Resolution-adaptive reference font size (used as fallback when user hasn't explicitly set a preference)
  const referenceFontSize = activeFrame
    ? getReferenceFontSize(activeFrame.canvas.w, activeFrame.canvas.h)
    : 24;

  // Read fontSize directly from raw config (bypasses DEFAULT_TEXT_STYLE fallback).
  // Only truthy when user has explicitly changed font size in the panel.
  const userExplicitFontSize = selfConfig.pendingTextData?.fontSize;

  /**
   * Synthesized textData: When a target layer exists, use layer's textData;
   * otherwise use pendingTextData to drive the panel UI.
   *
   * For fontSize: uses explicit user preference if set,
   * otherwise falls back to resolution-adaptive reference size.
   */
  const textData: TextLayerData | undefined = useMemo(() => {
    if (layerTextData) return layerTextData;
    return {
      content: '',
      fontFamily: pendingTextData.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily,
      fontSize: userExplicitFontSize ?? referenceFontSize,
      fontWeight: pendingTextData.fontWeight ?? DEFAULT_TEXT_STYLE.fontWeight,
      align: pendingTextData.align ?? DEFAULT_TEXT_STYLE.align,
      lineHeight: pendingTextData.lineHeight ?? DEFAULT_TEXT_STYLE.lineHeight,
      italic: pendingTextData.italic ?? DEFAULT_TEXT_STYLE.italic,
      underline: pendingTextData.underline ?? DEFAULT_TEXT_STYLE.underline,
      strikethrough: pendingTextData.strikethrough ?? DEFAULT_TEXT_STYLE.strikethrough,
      color: DEFAULT_TEXT_COLOR, // placeholder, actual color managed by ColorOptions
      boxMode: 'auto',
    } as TextLayerData;
  }, [layerTextData, pendingTextData, userExplicitFontSize, referenceFontSize]);

  const updateTextData = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!targetLayerId || !layerTextData) {
        // Pre-edit state: persist to pendingTextData in pluginConfig
        const pendingPatch = pickStyleFields(patch);

        if (Object.keys(pendingPatch).length > 0) {
          setSelfConfig({
            pendingTextData: { ...pendingTextData, ...pendingPatch },
          } as Partial<CraftDrawerConfig>);
        }
        return;
      }

      if (!activeFrame) return;

      // Editing and pre-edit states now share ONE ledgered path: session-start
      // rebased the history checkpoint, so the undoable style command works
      // identically in both — the in-session adjustment becomes its own undo
      // step instead of being folded into the session. The raw-edit flush
      // first gives typing its own step (otherwise the command's baseline
      // diff would swallow the un-ledgered keystrokes above the checkpoint).
      if (TEXT_SESSION_RAW_EDITS.pending) {
        actions.history.commitCheckpoint(activeFrame.id);
        TEXT_SESSION_RAW_EDITS.pending = false;
      }
      actions.executeCommand(TextOverlayAPI.commands.updateProperties.uid, {
        frameId: activeFrame.id,
        layerId: targetLayerId,
        patch,
      });

      // Also sync to pendingTextData so next layer creation uses latest settings
      const pendingSync = pickStyleFields(patch);

      if (Object.keys(pendingSync).length > 0) {
        setSelfConfig({
          pendingTextData: { ...pendingTextData, ...pendingSync },
        } as Partial<CraftDrawerConfig>);
      }
    },
    [actions, activeFrame, targetLayerId, layerTextData, pendingTextData, setSelfConfig]
  );

  /**
   * updateTextDataLive: non-undoable write for continuous input (slider drag).
   * Both states route through the live twin of cmd.update_properties so the
   * box re-measures per step. In the editing session the command is ledged
   * against the checkpoint rebased at session start; the pending-typing flush
   * runs at most once per gesture (the first live step), so the keystrokes
   * before the drag get their own step and the release's undoable command
   * records just the drag.
   */
  const updateTextDataLive = useCallback(
    (patch: Partial<TextLayerData>) => {
      if (!targetLayerId || !layerTextData) {
        // Pre-edit state: same as updateTextData (write to pendingTextData)
        const pendingPatch = pickStyleFields(patch);

        if (Object.keys(pendingPatch).length > 0) {
          setSelfConfig({
            pendingTextData: { ...pendingTextData, ...pendingPatch },
          } as Partial<CraftDrawerConfig>);
        }
        return;
      }

      if (!activeFrame) return;
      if (TEXT_SESSION_RAW_EDITS.pending) {
        actions.history.commitCheckpoint(activeFrame.id);
        TEXT_SESSION_RAW_EDITS.pending = false;
      }
      actions.executeCommand(TextOverlayAPI.commands.updatePropertiesLive.uid, {
        frameId: activeFrame.id,
        layerId: targetLayerId,
        patch,
      });
    },
    [actions, activeFrame, targetLayerId, layerTextData, pendingTextData, setSelfConfig]
  );

  // ─── Color Synchronization ──────────────────────────────────────────────────
  const [colorConfig] = usePluginConfig<{ pendingColor?: ColorValue }>(ColorOptionsAPI.configKey);
  const globalColor: ColorValue = colorConfig?.pendingColor ?? DEFAULT_TEXT_COLOR;
  const textColor: ColorValue = layerTextData?.color || globalColor;

  const updateTextColor = useCallback(
    (color: ColorValue) => {
      // `pendingColor` / `textData.color` persist in WORKING_GAMUT form — the
      // picker hands in a view-gamut value. The chip is mirrored directly
      // (plain config write, not the chip's own apply path) so this panel
      // control never announces itself back to the subscription below.
      const stored = convertColorGamut(color, WORKING_GAMUT);
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: stored });
      if (targetLayerId && layerTextData) {
        updateTextData({ color: stored });
      }
    },
    [actions, targetLayerId, layerTextData, updateTextData]
  );

  const updateTextColorLive = useCallback(
    (color: ColorValue) => {
      const stored = convertColorGamut(color, WORKING_GAMUT);
      actions.updatePluginConfig(ColorOptionsAPI.configKey, { pendingColor: stored });
      if (targetLayerId && layerTextData) {
        updateTextDataLive({ color: stored });
      }
    },
    [actions, targetLayerId, layerTextData, updateTextDataLive]
  );

  // ─── Mount-time cleanup: clear stale fontSize from legacy sync behavior ─────
  // Old code always synced fontSize to pendingTextData; new adaptive logic requires
  // fontSize to only be present when user explicitly sets it via the panel.
  const didCleanupRef = useRef(false);
  useEffect(() => {
    if (!didCleanupRef.current && selfConfig.pendingTextData?.fontSize !== undefined && !targetLayerId) {
      didCleanupRef.current = true;
      setSelfConfig({
        pendingTextData: { ...selfConfig.pendingTextData, fontSize: undefined },
      } as Partial<CraftDrawerConfig>);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Layer Selection Change: mirror the layer into the global chip + pending style ─
  // One-way, selection-driven only. The reverse direction (global chip →
  // layer) is NOT derived by diffing `pendingColor` against the layer colour:
  // a diff cannot tell a user edit from a history restore, so an undo that put
  // the layer colour back got "corrected" to the stale chip colour through a
  // fresh undoable command — the colour flashed back and history grew a step
  // undo could never beat. The chip announces user applications explicitly
  // instead (see the COLOR_OPTIONS_EVT_APPLY subscription below).
  const lastTargetLayerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (targetLayerId === lastTargetLayerIdRef.current) return;
    lastTargetLayerIdRef.current = targetLayerId;
    if (!targetLayerId || !layerTextData) return;

    // Synchronize color of selected layer to global Color Options,
    // normalized to the WORKING_GAMUT storage form.
    if (layerTextData.color) {
      actions.updatePluginConfig(ColorOptionsAPI.configKey, {
        pendingColor: convertColorGamut(layerTextData.color, WORKING_GAMUT),
      });
    }
    // Sync selected layer's text style to pendingTextData.
    // fontSize is intentionally CLEARED on layer selection change:
    // - Only persisted when user explicitly changes it in the panel (updateTextData)
    // - This allows getReferenceFontSize() to serve as the adaptive default
    //   for new layer creation on different canvas sizes
    // - Handles migration from old code that always synced fontSize: 24
    setSelfConfig({
      pendingTextData: {
        fontSize: undefined,  // Clear: adaptive default will be used for new layers
        fontFamily: layerTextData.fontFamily || DEFAULT_TEXT_STYLE.fontFamily,
        fontWeight: layerTextData.fontWeight || DEFAULT_TEXT_STYLE.fontWeight,
        align: layerTextData.align || DEFAULT_TEXT_STYLE.align,
        lineHeight: layerTextData.lineHeight || DEFAULT_TEXT_STYLE.lineHeight,
        italic: layerTextData.italic ?? DEFAULT_TEXT_STYLE.italic,
        underline: layerTextData.underline ?? DEFAULT_TEXT_STYLE.underline,
        strikethrough: layerTextData.strikethrough ?? DEFAULT_TEXT_STYLE.strikethrough,
      },
    } as Partial<CraftDrawerConfig>);
  }, [targetLayerId, layerTextData, actions, setSelfConfig]);

  // ─── Global chip → selected text layer: explicit user action only ─────────
  // The global colour chip announces every USER application (picker drag step,
  // release, sampler pick). With a text layer targeted, a live step writes
  // through the live path (session raw write while editing, non-undoable
  // command pre-edit) and the commit writes through the undoable command —
  // the same two-phase contract the panel's own colour control uses. The
  // event carries a WORKING_GAMUT value, so no conversion here.
  useEffect(() => {
    if (!targetLayerId || !layerTextData) return;
    const onApply = (e: Event) => {
      const { color, phase } = (e as CustomEvent<ColorOptionsApplyEventDetail>).detail;
      if (phase === 'commit') updateTextData({ color });
      else updateTextDataLive({ color });
    };
    window.addEventListener(ColorOptionsAPI.events.apply, onApply);
    return () => window.removeEventListener(ColorOptionsAPI.events.apply, onApply);
  }, [targetLayerId, layerTextData, updateTextData, updateTextDataLive]);

  return useMemo(() => ({
    targetLayer,
    textData,
    updateTextData,
    updateTextDataLive,
    textColor,
    updateTextColor,
    updateTextColorLive,
  }), [targetLayer, textData, updateTextData, updateTextDataLive, textColor, updateTextColor, updateTextColorLive]);
}
