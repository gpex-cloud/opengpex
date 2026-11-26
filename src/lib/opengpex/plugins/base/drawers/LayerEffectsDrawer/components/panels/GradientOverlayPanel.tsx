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
 * GradientOverlayPanel — the gradient-overlay effect's parameter rows:
 * preset swatch chips (the frozen GRADIENT_PRESETS table), the two ramp
 * stop colours, the linear/radial style toggle (FunctionTabs — a two-option
 * segmented control; the house segmented widget fits an either/or choice
 * better than a dropdown), the ramp angle (FancySvgSlider + numeric input,
 * 0–360 — the AngleDial is a DISTANCE dial: its drag vector encodes
 * (x, y) magnitude+direction for the shadow offset, not a pure angle, so a
 * slider keeps the 0–360 wrap semantics honest), scale and strength, and
 * the full 16-mode blend dropdown through the shared vocabulary seat.
 *
 * Fast-gesture contract (identical to the color-overlay panel): pointerdown
 * opens ONE undoable checkpoint (`beginEffectEdit`), every drag move parks
 * the full GradientOverlayParams on the volatile buffer
 * (`fastUpdateEffectParams` → `fast.overrideLayer`), and pointerup lands
 * ONE Redux write (`commitEffectParams`) — the whole drag is exactly one
 * Undo step. Discrete actions (preset click, style toggle, blend pick,
 * reset) are one-shot mini gestures through the same patch channel.
 */

import React, { useState } from 'react';
import ColorSwatchRow from '@opengpex/editor/widgets/ColorSwatchRow';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import ActionDropdown from '@opengpex/editor/widgets/ActionDropdown';
import FunctionTabs from '@opengpex/editor/widgets/FunctionTabs';
import type { EffectInstance, Layer, GradientOverlayParams, GradientOverlayStyle, LayerBlendMode } from '@opengpex/editor/core/types/models';
import { GRADIENT_PRESETS, updateEffectParams } from '@opengpex/editor/core/layer/effects';
import { usePluginCommands } from '@opengpex/editor/core/context';
import { useFilterGesture } from '@opengpex/editor/plugins/base/drawers/AdjustmentDrawer/hooks';
import type { LayerEffectsDrawerCommandsMap } from '../../commands.d';
import { PanelSection } from './shared';
import { BLEND_MODE_DROPDOWN_OPTIONS, BLEND_MODE_LABEL_MAP } from '@opengpex/editor/widgets/blendModes';

export function GradientOverlayPanel({
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

  const params = instance.params as GradientOverlayParams;

  // Fast-drag mirrors: while a drag runs, the store stays frozen until the
  // gesture's single commit, so the controls feed from THIS local state.
  const [fastStart, setFastStart] = useState<GradientOverlayParams['start'] | null>(null);
  const [fastEnd, setFastEnd] = useState<GradientOverlayParams['end'] | null>(null);
  const [fastAngle, setFastAngle] = useState<number | null>(null);
  const [fastScale, setFastScale] = useState<number | null>(null);
  const [fastStrength, setFastStrength] = useState<number | null>(null);

  // Shared fast write: full GradientOverlayParams against the freshest draft.
  const fastWrite = (next: GradientOverlayParams) => {
    fastUpdateEffectCmd?.execute({ instanceId: instance.id, params: next });
  };

  const applyOneShot = (next: GradientOverlayParams) => {
    const patch = updateEffectParams(layer, instance.id, next);
    if (patch) applyEffectPatchCmd?.execute({ patch });
  };

  // ─── Preset chips (frozen table): fill start/end + style in one shot ──
  const handlePreset = (index: number) => {
    const preset = GRADIENT_PRESETS[index];
    if (!preset) return;
    gesture.begin();
    applyOneShot({ ...params, start: preset.start, end: preset.end, style: preset.style });
    setFastStart(null);
    setFastEnd(null);
    gesture.end();
  };

  // ─── Style toggle (discrete: a one-shot mini gesture) ─────────────────
  const style: GradientOverlayStyle = params.style ?? 'linear';
  const handleStyle = (next: GradientOverlayStyle) => {
    if (next === style) return;
    gesture.begin();
    applyOneShot({ ...params, style: next });
    gesture.end();
  };

  // ─── Scalar sliders (the ShadowPanel scalar contract) ─────────────────
  const bindNumericParam = (
    key: 'angleDeg' | 'scale' | 'opacity',
    setFast: (v: number | null) => void,
  ) => ({
    onDragStart: () => {
      gesture.begin();
    },
    onChange: (value: number) => {
      const next = { ...params, [key]: value } as GradientOverlayParams;
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
      applyOneShot({ ...params, [key]: value } as GradientOverlayParams);
      gesture.end();
    },
  });

  const angleChannel = bindNumericParam('angleDeg', setFastAngle);
  const scaleChannel = bindNumericParam('scale', setFastScale);
  const strengthChannel = bindNumericParam('opacity', setFastStrength);

  // ─── Stop colours ──────────────────────────────────────────────────────
  const handleStopChange = (key: 'start' | 'end', color: GradientOverlayParams['start']) => {
    gesture.begin();
    const next = { ...params, [key]: color } as GradientOverlayParams;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite(next);
      (key === 'start' ? setFastStart : setFastEnd)(color);
      return;
    }
    applyOneShot(next);
    (key === 'start' ? setFastStart : setFastEnd)(color);
  };

  const handleStopCommit = (key: 'start' | 'end', color: GradientOverlayParams['start']) => {
    if (!gesture.isDragging()) return;
    if (fastUpdateEffectCmd && commitEffectCmd) {
      fastWrite({ ...params, [key]: color } as GradientOverlayParams);
    }
    commitEffectCmd?.execute();
    (key === 'start' ? setFastStart : setFastEnd)(null);
    gesture.end();
  };

  // ─── Blend mode (dropdown pick = a one-shot mini gesture) ─────────────
  const blendMode: LayerBlendMode = params.blendMode ?? 'source-over';
  const handleBlendSelect = (value: string) => {
    // Discrete pick → ONE patch inside a begin/end mini gesture (the
    // StrokePanel position precedent). Never route through the fast buffer:
    // a fast write without its commit leaves the gesture dangling and the
    // NEXT drag replays stale params over the pick.
    gesture.begin();
    applyOneShot({ ...params, blendMode: value as LayerBlendMode });
    gesture.end();
  };


  // A drag interrupted by unmount must still land its volatile draft — the
  // same cleanup contract as the other surface panels.
  React.useEffect(() => {
    return () => {
      if (gesture.isDragging()) {
        commitEffectCmd?.execute();
        setFastStart(null);
        setFastEnd(null);
        setFastAngle(null);
        setFastScale(null);
        setFastStrength(null);
        gesture.end();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blendTrigger = (
    <div className="flex-1 flex items-center justify-between gap-1 px-2 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-panel)] hover:bg-[var(--border-subtle)] transition-colors text-left cursor-pointer">
      <span className="text-[9px] font-bold text-[var(--text-main)] truncate">
        {BLEND_MODE_LABEL_MAP.get(blendMode) || 'Normal'}
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
      {/* Preset chips on ONE row with the inline label (house pattern):
          the frozen GRADIENT_PRESETS table — one click fills start/end +
          style; the other parameters stay untouched. Chips share the line
          evenly (flex-1) so all six fit beside the label. */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0">
          Presets
        </span>
        <div className="flex flex-1 items-center gap-1 min-w-0">
          {GRADIENT_PRESETS.map((preset, i) => (
            <button
              key={preset.id}
              title={preset.label}
              aria-label={`Gradient preset ${preset.label}`}
              onClick={() => handlePreset(i)}
              className="flex-1 min-w-0 h-4 rounded outline-none cursor-pointer border border-[var(--border-subtle)] hover:border-[var(--border-light)] transition-colors"
              style={{ background: `linear-gradient(90deg, ${preset.start.hex}, ${preset.end.hex})` }}
            />
          ))}
        </div>
      </div>
      <ColorSwatchRow
        label="From"
        className="px-0"
        labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
        value={fastStart ?? params.start}
        onValueChange={(c) => handleStopChange('start', c)}
        onValueCommit={(c) => handleStopCommit('start', c)}
      />
      <ColorSwatchRow
        label="To"
        className="px-0"
        labelClassName="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0"
        value={fastEnd ?? params.end}
        onValueChange={(c) => handleStopChange('end', c)}
        onValueCommit={(c) => handleStopCommit('end', c)}
      />
      {/* Single-row layout, the house inline-label pattern: label sits inline
          LEFT of the segmented control (not stacked in a section). */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-tight w-14 shrink-0">
          Style
        </span>
        {/* FunctionTabs: the house two-option segmented control — an
            either/or geometry choice, no dropdown chrome needed.
            flex-1 + min-width: inside the inline-label row the control has
            no intrinsic width, and its buttons collapse onto each other
            without an explicit stretch. */}
        <FunctionTabs<GradientOverlayStyle>
          size="sm"
          className="flex-1 min-w-[140px]"
          value={style}
          onChange={handleStyle}
          options={[
            { label: 'Linear', value: 'linear' },
            { label: 'Radial', value: 'radial' },
          ]}
        />
      </div>
      {/* Angle is a LINEAR-only parameter: a radial falloff is
            direction-free, so the row greys out (no-op, value kept) when the
            style is radial instead of hiding — switching back to linear
            restores the previous angle. */}
      <PanelSection label="Angle">
        {/* FancySvgSlider + input over the AngleDial: the dial is a DISTANCE
            dial (its drag encodes an (x, y) vector for the shadow offset);
            the gradient needs pure 0–360 angle semantics with wrap, which a
            slider + numeric field expresses without ambiguity. */}
        <div className={`flex items-center gap-1 ${style === 'radial' ? 'opacity-40 pointer-events-none' : ''}`}>
          <FancySvgSlider
            className="flex-1"
            value={fastAngle ?? params.angleDeg ?? 90}
            min={0}
            max={360}
            step={1}
            precision={0}
            slim
            withInput
            disabled={style === 'radial'}
            ariaLabel="Gradient angle"
            {...angleChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">°</span>
        </div>
      </PanelSection>
      <PanelSection label="Scale">
        <div className="flex items-center gap-1">
          <FancySvgSlider
            className="flex-1"
            value={fastScale ?? params.scale ?? 100}
            min={1}
            max={200}
            step={1}
            precision={0}
            slim
            withInput
            ariaLabel="Gradient scale"
            {...scaleChannel}
          />
          <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">%</span>
        </div>
      </PanelSection>
      <PanelSection label="Strength">
        <FancySvgSlider
          value={fastStrength ?? params.opacity ?? 1}
          min={0}
          max={1}
          step={0.01}
          precision={2}
          slim
          withInput
          ariaLabel="Gradient strength"
          {...strengthChannel}
        />
      </PanelSection>
    </div>
  );
}
