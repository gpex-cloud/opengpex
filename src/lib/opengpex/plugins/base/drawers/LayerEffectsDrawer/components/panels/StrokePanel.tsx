/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the GNU General Public License.
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
 * StrokePanel — the stroke effect's parameter rows (A8 P3): the color swatch
 * and the width slider, both on the Q4 fast channel (identical to the
 * adjustments sliders): pointerdown opens ONE undoable checkpoint
 * (`beginEffectEdit`), every drag move parks the full StrokeParams on the
 * volatile buffer (`fastUpdateEffectParams` → `fast.overrideLayer`, folded
 * into the rendered frame per tick — the live stroke preview runs at 60fps
 * with zero Redux/React traffic), and pointerup lands ONE Redux write
 * (`commitEffectParams`) so the whole drag is exactly one Undo step.
 *
 * This file is the TEMPLATE for future per-category panels (ShadowPanel at
 * P5): own your fast mirrors locally, write through the shared commands,
 * keep the gesture lifecycle (including the unmount commit) intact.
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import FunctionTabs from '@opengpex/editor/widgets/FunctionTabs';
import type { EffectInstance, Layer, StrokeParams, StrokePosition } from '@opengpex/editor/core/types/models';
import { updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';

export function StrokePanel({
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

  const params = instance.params as StrokeParams;

  // Fast-drag mirrors: while a drag runs, the store stays frozen until the
  // gesture's single commit, so the thumb/swatch feed from THIS local state
  // (re-renders only this panel — the canvas merge sees the volatile buffer).
  const [fastWidth, setFastWidth] = useState<number | null>(null);
  const [fastColor, setFastColor] = useState<StrokeParams['color'] | null>(null);

  // Shared fast write: full StrokeParams against the freshest draft.
  const fastWrite = (next: StrokeParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const handleWidthDragStart = () => {
    gesture.begin();
  };

  const handleWidthChange = (value: number) => {
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, widthPx: value });
      setFastWidth(value);
      return;
    }
    applyEffectPatchCmd?.execute({
      patch: updateEffectParams(layer, instance.id, { ...params, widthPx: value }) ?? {},
    });
    setFastWidth(value);
  };

  const handleWidthDragEnd = () => {
    if (!gesture.isDragging()) return;
    // The width slider steps integers (no motion quantization needed) — the
    // last fast write already holds the exact value; land ONE Redux write.
    commitEffectCmd?.execute();
    setFastWidth(null);
    gesture.end();
  };

  const handleWidthFieldCommit = (value: number) => {
    // Typed-value commit is a ONE-SHOT write in a mini gesture (one undo
    // step) — the fast track has no dragEnd to commit it.
    gesture.begin();
    const patch = updateEffectParams(layer, instance.id, { ...params, widthPx: value });
    if (patch) applyEffectPatchCmd?.execute({ patch });
    gesture.end();
  };

  const handleColorChange = (color: StrokeParams['color']) => {
    // ColorPicker drags run the same fast channel: first change opens the
    // checkpoint (idempotent), live changes park on the volatile buffer.
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    const patch = updateEffectParams(layer, instance.id, { ...params, color });
    if (patch) applyEffectPatchCmd?.execute({ patch });
    setFastColor(color);
  };

  const handleColorCommit = (color: StrokeParams['color']) => {
    if (!gesture.isDragging()) return;
    // Land the exact final colour, then ONE Redux write closes the gesture.
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };

  // A drag interrupted by unmount (tab switch / drawer close / selection
  // change) must still land its volatile draft — the same cleanup contract
  // as the adjustments panel.
  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastWidth(null);
        setFastColor(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePositionChange = (position: StrokePosition) => {
    gesture.begin();
    const patch = updateEffectParams(layer, instance.id, { ...params, position });
    if (patch) applyEffectPatchCmd?.execute({ patch });
    gesture.end();
  };

  const activePosition: StrokePosition = params.position ?? 'outside';

  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      {/* Single-row layout: the row label sits inline LEFT of the swatch
          control (ColorSwatchRow's built-in label, house pattern) — the
          header-above variant wraps the swatch to its own line. */}
      <ColorSwatchRow
        label="Color"
        className="px-0"
        labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
        value={fastColor ?? params.color}
        onValueChange={handleColorChange}
        onValueCommit={handleColorCommit}
      />
      <PanelSection label="Size">
        {/* The unit sits inline after the slider's numeric field (house
            pattern) — a standalone row under the slider reads as a wrap. */}
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastWidth ?? params.widthPx}
            min={1}
            max={250}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Stroke size"
            onDragStart={handleWidthDragStart}
            onChange={handleWidthChange}
            onDragEnd={handleWidthDragEnd}
            onFieldCommit={handleWidthFieldCommit}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Position">
        <FunctionTabs<StrokePosition>
          size="sm"
          options={[
            { label: 'Outside', value: 'outside' },
            { label: 'Center', value: 'center' },
            { label: 'Inside', value: 'inside' },
          ]}
          value={activePosition}
          onChange={handlePositionChange}
        />
      </PanelSection>
    </div>
  );
}
