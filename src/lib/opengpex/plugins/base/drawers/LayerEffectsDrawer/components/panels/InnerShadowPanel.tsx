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
 * InnerShadowPanel — the inner-shadow effect's parameter rows: color swatch,
 * AngleDial offset (the shadow ring lands ON the offset's side — drag down,
 * the bottom inner edge darkens; the reference product's inner-shadow
 * convention), blur, spread and strength sliders (mirroring ShadowPanel)
 * PLUS the full 16-mode blend dropdown on the inline-label row
 * (direction="up", the ShadowPanel dropdown placement).
 *
 * Reset is NOT a panel atom: it lives in the drawer header's split menu —
 * do not re-add a PanelResetButton here.
 *
 * Fast-gesture contract: identical to the ShadowPanel (one checkpoint per
 * drag, volatile park per move, ONE Redux write at gesture end).
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import AngleDial, { angleDistanceFromOffset } from '@opengpex/editor/widgets/AngleDial';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import type { EffectInstance, Layer, InnerShadowParams, LayerBlendMode } from '@opengpex/editor/core/types/models';
import { updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';
import { BLEND_MODE_DROPDOWN_OPTIONS, BLEND_MODE_LABEL_MAP } from '@opengpex/editor/widgets/blendModes';

export function InnerShadowPanel({
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

  const params = instance.params as InnerShadowParams;

  const [fastColor, setFastColor] = useState<InnerShadowParams['color'] | null>(null);
  const [fastOffset, setFastOffset] = useState<{ x: number; y: number } | null>(null);
  const [fastBlur, setFastBlur] = useState<number | null>(null);
  const [fastSpread, setFastSpread] = useState<number | null>(null);
  const [fastStrength, setFastStrength] = useState<number | null>(null);

  const fastWrite = (next: InnerShadowParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: InnerShadowParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

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
    commitEffectCmd?.execute();
    setFastOffset(null);
    gesture.end();
  };

  const offset = fastOffset ?? { x: params.offsetX, y: params.offsetY };
  const polar = angleDistanceFromOffset(offset.x, offset.y);

  const bindNumericParam = (
    key: keyof InnerShadowParams,
    setFast: (v: number | null) => void,
  ) => ({
    onDragStart: () => {
      gesture.begin();
    },
    onChange: (value: number) => {
      const next = { ...params, [key]: value } as InnerShadowParams;
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
      commitEffectCmd?.execute();
      setFast(null);
      gesture.end();
    },
    onFieldCommit: (value: number) => {
      gesture.begin();
      applyOneShot({ ...params, [key]: value } as InnerShadowParams);
      gesture.end();
    },
  });

  const blurChannel = bindNumericParam('blurRadius', setFastBlur);
  const spreadChannel = bindNumericParam('spreadPx', setFastSpread);
  const strengthChannel = bindNumericParam('strength', setFastStrength);

  const handleColorChange = (color: InnerShadowParams['color']) => {
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    applyOneShot({ ...params, color });
    setFastColor(color);
  };

  const handleColorCommit = (color: InnerShadowParams['color']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };

  // Blend pick = a one-shot mini gesture.
  const blendMode: LayerBlendMode = params.blendMode ?? 'multiply';
  const handleBlendSelect = (value: string) => {
    const nextBlend = value as LayerBlendMode;
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, blendMode: nextBlend });
      return;
    }
    applyOneShot({ ...params, blendMode: nextBlend });
    gesture.end();
  };

  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastColor(null);
        setFastOffset(null);
        setFastBlur(null);
        setFastSpread(null);
        setFastStrength(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blendTrigger = (
    <div className="flex-1 flex items-center justify-between gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] transition-colors text-left cursor-pointer">
      <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
        {BLEND_MODE_LABEL_MAP.get(blendMode) || 'Multiply'}
      </span>
      <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-[var(--text-muted)]">
        <path d="M2 3L4 5L6 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      {/* Blend mode rides on TOP of the panel (house standard): inline
          label, 16-mode shared seat, popup opens DOWNWARD — the panel is
          tall and an upward popup clips against the drawer top. */}
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
      <ColorSwatchRow
        label="Color"
        className="px-0"
        labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
        value={fastColor ?? params.color}
        onValueChange={handleColorChange}
        onValueCommit={handleColorCommit}
      />
      {/* Zero-gap offset block: the dial's top edge sits FLUSH with the
            label line — PanelSection's space-y-1 would leave a visible seam
            at dial size 96, so this row hand-rolls the label instead. */}
      <div>
        <span className="block text-[9px] leading-none font-bold text-[var(--text-muted)] uppercase tracking-tight">
          Offset
        </span>
        {/* pl-16 = the ColorSwatchRow label width (w-14) + its gap (the
            ShadowPanel dial placement). The ring lands ON the offset's
            side: drag down -> the bottom inner edge darkens. */}
        <div className="flex items-start gap-3 pl-16">
          <AngleDial
            size={96}
            offsetX={offset.x}
            offsetY={offset.y}
            onDragStart={handleOffsetDragStart}
            onChange={handleOffsetChange}
            onDragEnd={handleOffsetDragEnd}
          />
          <div className="flex flex-col text-[10px] tabular-nums text-[var(--text-secondary)] leading-tight pt-1">
            <span>Distance {Math.round(polar.distance)} px</span>
            <span className="text-[var(--text-muted)]">Angle {Math.round(polar.angleDeg)}°</span>
          </div>
        </div>
      </div>
      <PanelSection label="Blur">
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastBlur ?? params.blurRadius}
            min={0}
            max={50}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Inner shadow blur"
            {...blurChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Spread">
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
            ariaLabel="Inner shadow spread"
            {...spreadChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">px</span>
        </div>
      </PanelSection>
      <PanelSection label="Strength">
        <FancySvgSlider
          value={fastStrength ?? params.strength ?? 1}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          slim
          withInput
          ariaLabel="Inner shadow strength"
          {...strengthChannel}
        />
      </PanelSection>
    </div>
  );
}
