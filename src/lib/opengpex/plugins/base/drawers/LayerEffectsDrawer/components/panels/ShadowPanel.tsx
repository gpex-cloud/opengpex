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
 * ShadowPanel — the drop-shadow effect's parameter rows (A8 P5): color swatch,
 * AngleDial offset, softness (Gaussian sigma) and strength (opacity), all on
 * the SAME fast channel as the stroke panel: pointerdown opens ONE undoable
 * checkpoint (`beginEffectEdit`), every drag move parks the full ShadowParams
 * on the volatile buffer (`fastUpdateEffectParams` → `fast.overrideLayer`,
 * folded into the rendered frame per tick), and pointerup lands ONE Redux
 * write (`commitEffectParams`) — the whole drag is exactly one Undo step.
 *
 * Template contract inherited from StrokePanel: own your fast mirrors
 * locally, write through the shared commands, keep the gesture lifecycle
 * (including the unmount commit) intact.
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import AngleDial, { angleDistanceFromOffset } from '@opengpex/editor/widgets/AngleDial';
import type { EffectInstance, Layer, ShadowParams } from '@opengpex/editor/core/types/models';
import { defaultShadowParams, updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection, PanelResetButton } from './shared';

export function ShadowPanel({
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

  const params = instance.params as ShadowParams;

  // Fast-drag mirrors: while a drag runs, the store stays frozen until the
  // gesture's single commit, so the controls feed from THIS local state.
  const [fastColor, setFastColor] = useState<ShadowParams['color'] | null>(null);
  const [fastOffset, setFastOffset] = useState<{ x: number; y: number } | null>(null);
  const [fastBlur, setFastBlur] = useState<number | null>(null);
  const [fastSpread, setFastSpread] = useState<number | null>(null);
  const [fastOpacity, setFastOpacity] = useState<number | null>(null);

  // Shared fast write: full ShadowParams against the freshest draft.
  const fastWrite = (next: ShadowParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: ShadowParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

  // ─── Offset (AngleDial) ────────────────────────────────────────────────
  const handleOffsetDragStart = () => {
    gesture.begin();
  };

  const handleOffsetChange = (x: number, y: number) => {
    const next = { ...params, offsetX: x, offsetY: y };
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite(next);
      setFastOffset({ x, y });
      return;
    }
    applyOneShot(next);
    setFastOffset({ x, y });
  };

  const handleOffsetDragEnd = () => {
    if (!gesture.isDragging()) return;
    // The dial quantizes to whole px while dragging — the last fast write
    // already holds the exact value; land ONE Redux write.
    commitEffectCmd?.execute();
    setFastOffset(null);
    gesture.end();
  };

  const offset = fastOffset ?? { x: params.offsetX, y: params.offsetY };
  const polar = angleDistanceFromOffset(offset.x, offset.y);

  /**
   * One fast channel per numeric param — the identical four-piece contract
   * (checkpoint at drag start, volatile park per move, ONE Redux write at
   * drag end, one-shot mini gesture for typed commits) shared by every
   * scalar row; only the param key and its fast mirror differ.
   */
  const bindNumericParam = (
    key: keyof ShadowParams,
    setFast: (v: number | null) => void,
  ) => ({
    onDragStart: () => {
      gesture.begin();
    },
    onChange: (value: number) => {
      const next = { ...params, [key]: value } as ShadowParams;
      if (fastUpdateEffectCmd && commitEffectCmd) {
        fastWrite(next);
        setFast(value);
        return;
      }
      applyOneShot(next);
      setFast(value);
    },
    onDragEnd: () => {
      if (!gesture.isDragging()) return;
      // Scalar sliders quantize while dragging — the last fast write already
      // holds the exact value; land ONE Redux write.
      commitEffectCmd?.execute();
      setFast(null);
      gesture.end();
    },
    onFieldCommit: (value: number) => {
      // Typed-value commit is a ONE-SHOT write in a mini gesture.
      gesture.begin();
      applyOneShot({ ...params, [key]: value } as ShadowParams);
      gesture.end();
    },
  });

  const blurChannel = bindNumericParam('blurRadius', setFastBlur);
  const spreadChannel = bindNumericParam('spreadPx', setFastSpread);
  const opacityChannel = bindNumericParam('opacity', setFastOpacity);

  // ─── Color ─────────────────────────────────────────────────────────────
  const handleColorChange = (color: ShadowParams['color']) => {
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    applyOneShot({ ...params, color });
    setFastColor(color);
  };

  const handleColorCommit = (color: ShadowParams['color']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };

  // Restore the shadow factory defaults onto THIS instance — a ONE-SHOT
  // undoable patch through the shared applyEffectPatch channel (no fast
  // buffer: a discrete click, not a drag gesture).
  const resetToDefaults = () => {
    applyOneShot(defaultShadowParams());
  };

  // A drag interrupted by unmount must still land its volatile draft — the
  // same cleanup contract as the stroke panel.
  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastColor(null);
        setFastOffset(null);
        setFastBlur(null);
        setFastSpread(null);
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
        <PanelResetButton onReset={resetToDefaults} />
      </div>
      <PanelSection label="Offset">
        {/* pl-16 = the ColorSwatchRow label width (w-14) + its gap — the dial
            left-aligns with the color palette button, not the Color label. */}
        <div className="flex items-center gap-3 pl-16">
          <AngleDial
            offsetX={offset.x}
            offsetY={offset.y}
            onDragStart={handleOffsetDragStart}
            onChange={handleOffsetChange}
            onDragEnd={handleOffsetDragEnd}
          />
          <div className="flex flex-col text-[10px] tabular-nums text-[var(--text-secondary)] leading-tight">
            <span>Distance {Math.round(polar.distance)} px</span>
            <span className="text-[var(--text-muted)]">Angle {Math.round(polar.angleDeg)}°</span>
          </div>
        </div>
      </PanelSection>
      <PanelSection label="Softness">
        {/* The unit sits inline after the slider's numeric field (house
            pattern). Kernel-capped at σ=20 — past it the separable Gaussian's
            60px radius saturates, so larger values add nothing. */}
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastBlur ?? params.blurRadius}
            min={0}
            max={20}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Shadow softness"
            {...blurChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Spread">
        {/* Silhouette dilation before the blur — grows the shadow WITHOUT
            softening it. PS's Spread has no negative range: 0..50 px. */}
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastSpread ?? params.spreadPx ?? 0}
            min={0}
            max={50}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Shadow spread"
            {...spreadChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Strength">
        <FancySvgSlider
          value={fastOpacity ?? params.opacity}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          slim
          withInput
          ariaLabel="Shadow strength"
          {...opacityChannel}
        />
      </PanelSection>
    </div>
  );
}
