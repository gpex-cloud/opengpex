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
 * InnerGlowPanel — the inner-glow effect's parameter rows: color swatch,
 * blur, spread and strength sliders (mirroring OuterGlowPanel) PLUS the
 * full 16-mode blend dropdown (the shared BLEND_MODE_DROPDOWN_OPTIONS seat)
 * — the inner effects blend against the LAYER'S OWN CONTENT (a layer-local
 * operation), so unlike the outer glow the blend mode is a real parameter.
 *
 * Reset is NOT a panel atom: it lives in the drawer header's split menu
 * (the AdjustmentDrawer precedent) — do not re-add a PanelResetButton here.
 *
 * Fast-gesture contract (identical to the outer-glow panel): pointerdown
 * opens ONE undoable checkpoint, every drag move parks the full
 * InnerGlowParams on the volatile buffer, pointerup lands ONE Redux write.
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import type { EffectInstance, Layer, InnerGlowParams, LayerBlendMode } from '@opengpex/editor/core/types/models';
import { updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';
import { BLEND_MODE_DROPDOWN_OPTIONS, BLEND_MODE_LABEL_MAP } from '@opengpex/editor/widgets/blendModes';

export function InnerGlowPanel({
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

  const params = instance.params as InnerGlowParams;

  const [fastColor, setFastColor] = useState<InnerGlowParams['color'] | null>(null);
  const [fastBlur, setFastBlur] = useState<number | null>(null);
  const [fastSpread, setFastSpread] = useState<number | null>(null);
  const [fastStrength, setFastStrength] = useState<number | null>(null);

  const fastWrite = (next: InnerGlowParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: InnerGlowParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

  const bindNumericParam = (
    key: keyof InnerGlowParams,
    setFast: (v: number | null) => void,
  ) => ({
    onDragStart: () => {
      gesture.begin();
    },
    onChange: (value: number) => {
      const next = { ...params, [key]: value } as InnerGlowParams;
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
      applyOneShot({ ...params, [key]: value } as InnerGlowParams);
      gesture.end();
    },
  });

  const blurChannel = bindNumericParam('blurRadius', setFastBlur);
  const spreadChannel = bindNumericParam('spreadPx', setFastSpread);
  const strengthChannel = bindNumericParam('strength', setFastStrength);

  const handleColorChange = (color: InnerGlowParams['color']) => {
    gesture.begin();
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
      setFastColor(color);
      return;
    }
    applyOneShot({ ...params, color });
    setFastColor(color);
  };

  const handleColorCommit = (color: InnerGlowParams['color']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, color });
    }
    commitEffectCmd?.execute();
    setFastColor(null);
    gesture.end();
  };

  // Blend pick = a one-shot mini gesture (a discrete action, not a drag).
  const blendMode: LayerBlendMode = params.blendMode ?? 'screen';
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
        {BLEND_MODE_LABEL_MAP.get(blendMode) || 'Screen'}
      </span>
      <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-[var(--text-muted)]">
        <path d="M2 3L4 5L6 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 px-3 pt-2 pb-3">
      {/* Blend mode rides on TOP of the panel (house standard): inline
          label, 16-mode shared seat, popup opens DOWNWARD. */}
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
            ariaLabel="Inner glow blur"
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
            ariaLabel="Inner glow spread"
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
          ariaLabel="Inner glow strength"
          {...strengthChannel}
        />
      </PanelSection>
    </div>
  );
}
