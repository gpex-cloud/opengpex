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

/**
 * ColorOverlayPanel — the color-overlay effect's parameter rows: color swatch,
 * the FULL 16-mode blend-mode dropdown (the same grouped vocabulary the layer
 * props bar uses) and strength (opacity), all on the SAME fast channel as the
 * stroke/shadow panels: pointerdown opens ONE undoable checkpoint
 * (`beginEffectEdit`), every drag move parks the full ColorOverlayParams on
 * the volatile buffer (`fastUpdateEffectParams` → `fast.overrideLayer`), and
 * pointerup lands ONE Redux write (`commitEffectParams`) — the whole drag is
 * exactly one Undo step.
 *
 * Template contract inherited from ShadowPanel: own your fast mirrors
 * locally, write through the shared commands, keep the gesture lifecycle
 * (including the unmount commit) intact.
 */

import React, { useMemo, useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import { BLEND_MODE_DROPDOWN_OPTIONS, BLEND_MODE_LABEL_MAP } from '@opengpex/editor/widgets/blendModes';
import type { EffectInstance, Layer, ColorOverlayParams, LayerBlendMode } from '@opengpex/editor/core/types/models';
import { updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';

export function ColorOverlayPanel({
  layer,
  instance,
}: {
  layer: Layer;
  instance: EffectInstance;
}) {
  const {
    beginEffectEditCmd,
    fastUpdateEffectCmd,
    commitEffectCmd,
    applyEffectPatchCmd,
  } = usePluginCommands<LayerEffectsDrawerCommandsMap>();
  const gesture = useFilterGesture(beginEffectEditCmd);

  const params = instance.params as ColorOverlayParams;

  // Fast-drag mirrors: while a drag runs, the store stays frozen until the
  // gesture's single commit, so the controls feed from THIS local state.
  // Blend mode needs NO mirror: a dropdown pick is a discrete one-shot (the
  // StrokePanel position precedent), not a drag — it lands its patch through
  // the regular patch channel inside a begin/end mini gesture.
  const [fastColor, setFastColor] = useState<ColorOverlayParams['color'] | null>(null);
  const [fastOpacity, setFastOpacity] = useState<number | null>(null);

  // Shared fast write: full ColorOverlayParams against the freshest draft.
  const fastWrite = (next: ColorOverlayParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: ColorOverlayParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

  // ─── Blend mode (dropdown pick = a one-shot mini gesture) ─────────────
  const blendMode = params.blendMode ?? 'multiply';
  const blendTrigger = useMemo(() => (
    <div className="flex-1 flex items-center justify-between gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] transition-colors text-left cursor-pointer">
      <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
        {BLEND_MODE_LABEL_MAP.get(blendMode) || 'Multiply'}
      </span>
      <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-[var(--text-muted)]">
        <path d="M2 3L4 5L6 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  ), [blendMode]);

  const handleBlendSelect = (value: string) => {
    // Discrete pick → ONE patch inside a begin/end mini gesture. Never route
    // through the fast buffer: a fast write without its commit would leave
    // the gesture dangling and the NEXT drag would replay stale params over it.
    gesture.begin();
    applyOneShot({ ...params, blendMode: value as LayerBlendMode });
    gesture.end();
  };

  // ─── Strength (opacity slider, the ShadowPanel scalar contract) ───────
  const handleOpacityDragStart = () => {
    gesture.begin();
  };

  const handleOpacityChange = (value: number) => {
    const next = { ...params, opacity: value };
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite(next);
      setFastOpacity(value);
      return;
    }
    applyOneShot(next);
    setFastOpacity(value);
  };

  const handleOpacityDragEnd = () => {
    if (!gesture.isDragging()) return;
    // Scalar sliders quantize while dragging — the last fast write already
    // holds the exact value; land ONE Redux write.
    commitEffectCmd?.execute();
    setFastOpacity(null);
    gesture.end();
  };

  const handleOpacityFieldCommit = (value: number) => {
    // Typed-value commit is a ONE-SHOT write in a mini gesture.
    gesture.begin();
    applyOneShot({ ...params, opacity: value });
    gesture.end();
  };

  // ─── Color ─────────────────────────────────────────────────────────────
  const handleColorChange = (color: ColorOverlayParams['color']) => {
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    applyOneShot({ ...params, color });
    setFastColor(color);
  };

  const handleColorCommit = (color: ColorOverlayParams['color']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };


  // A drag interrupted by unmount must still land its volatile draft — the
  // same cleanup contract as the stroke/shadow panels.
  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastColor(null);
        setFastOpacity(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      {/* Single-row layout: the label sits inline LEFT of the swatch control
          (ColorSwatchRow's built-in label — the house row pattern). The
          trailing reset restores this category's factory defaults with ONE
          undoable patch (no fast buffer — a discrete action, not a drag). */}
      <div className="flex items-center gap-1">
        <ColorSwatchRow
          label="Color"
          className="px-0"
          labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
          value={fastColor ?? params.color}
          onValueChange={handleColorChange}
          onValueCommit={handleColorCommit}
        />
      </div>
      {/* Single-row layout, same house pattern as the Color row above: the
          label sits inline LEFT of the control (not stacked in a section). */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0">
          Blend
        </span>
        <ActionDropdown
          trigger={blendTrigger}
          options={BLEND_MODE_DROPDOWN_OPTIONS}
          onSelect={handleBlendSelect}
          cols={3}
          align="right"
          className="flex-1"
        />
      </div>
      <PanelSection label="Strength">
        <FancySvgSlider
          value={fastOpacity ?? params.opacity ?? 1}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          slim
          withInput
          ariaLabel="Color overlay strength"
          onDragStart={handleOpacityDragStart}
          onChange={handleOpacityChange}
          onDragEnd={handleOpacityDragEnd}
          onFieldCommit={handleOpacityFieldCommit}
        />
      </PanelSection>
    </div>
  );
}
