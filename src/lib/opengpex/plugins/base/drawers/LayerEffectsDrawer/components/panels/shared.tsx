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
 * shared.tsx — small building blocks shared by the per-category effect
 * panels (StrokePanel, ShadowPanel, …): the section-row wrapper every
 * parameter row uses, and the empty/placeholder body for categories whose
 * panel has nothing to show yet. Deliberately NOT a registry or any
 * cross-panel abstraction — panels own their parameter logic; only the
 * presentation atoms live here.
 */

import React from 'react';
import FancySvgSlider from '@opengpex/editor/widgets/FancySvgSlider';
import type { EffectNumericParamSpec } from '@opengpex/editor/core/layer/effects';

/** Section row: the tiny uppercase label above one parameter control. */
export function PanelSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[9px] leading-none font-bold text-[var(--text-muted)] uppercase tracking-tight">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * SpecSliderRow — the generic numeric parameter row driven by the core spec
 * table (`EFFECT_PARAM_SPECS`): label/range/step/precision/unit/aria all
 * come from the spec, the panel only feeds the value and the gesture
 * channel (onDragStart/onChange/onDragEnd/onFieldCommit — the fast-track
 * lifecycle whose shape is identical across panels; spread a panel's
 * `bindNumericParam` result straight into these props).
 */
export function SpecSliderRow({
  spec,
  value,
  disabled,
  onDragStart,
  onChange,
  onDragEnd,
  onFieldCommit,
}: {
  spec: EffectNumericParamSpec;
  value: number;
  disabled?: boolean;
  onDragStart?: () => void;
  onChange: (value: number) => void;
  onDragEnd?: () => void;
  onFieldCommit?: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <FancySvgSlider
        className="flex-1"
        value={value}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        precision={spec.precision}
        slim
        withInput
        disabled={disabled}
        ariaLabel={spec.ariaLabel}
        onDragStart={onDragStart}
        onChange={onChange}
        onDragEnd={onDragEnd}
        onFieldCommit={onFieldCommit}
      />
      {spec.unit && (
        <span className="text-[8px] font-bold text-[var(--text-muted)] shrink-0">{spec.unit}</span>
      )}
    </div>
  );
}


/**
 * Placeholder body: an AVAILABLE category whose panel has no pipeline yet
 * (Shadow until P5), or the one-frame transient while the lazy floor
 * ensure lands; unavailable future categories get the family-shape copy.
 */
export function EmptyCategoryPanel({ label, available }: { label: string; available: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 flex-1 py-16 px-4 text-center">
      <span className="text-[9px] font-black uppercase tracking-widest text-[var(--text-muted)]">
        {label}
      </span>
      <span className="text-[9px] text-[var(--text-muted)] tracking-tight max-w-[200px]">
        {available
          ? 'Parameters arrive with this effect\'s render pipeline.'
          : 'Not in the first release — the tab shows the final family shape.'}
      </span>
    </div>
  );
}

