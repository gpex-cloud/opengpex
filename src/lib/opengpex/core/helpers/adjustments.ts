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

/**
 * adjustments.ts — Identity predicates for the adjustment-mask grade chain
 * (`Layer.adjustMasks`), shared by every consumer that must agree on what
 * "no observable change" means: the render-side translation (an identity arm
 * emits no descriptor), the legacy migration (an all-identity fold yields no
 * mask) and the layers panel indicator (an identity mask is not an
 * "adjustment"). The baselines mirror the panel defaults.
 *
 * @module core/helpers/adjustments
 */

import type {
  AdjustmentState,
  ChannelMixState,
  ColorBalanceState,
  CurvesState,
  GradeState,
  LevelsState,
} from '@opengpex/editor/core/types';


/** Basic COLOUR scalars at defaults (brightness/contrast/saturation=100, hue=0). */
export function isIdentityBasicColor(a: AdjustmentState | undefined): boolean {
  if (!a) return true;
  return (
    (a.brightness ?? 100) === 100 &&
    (a.contrast ?? 100) === 100 &&
    (a.saturation ?? 100) === 100 &&
    (a.hueRotate ?? 0) === 0
  );
}

/** Basic scalars including the neighbourhood quantities (blur / edgeFeather). */
export function isIdentityBasic(a: AdjustmentState | undefined): boolean {
  if (!a) return true;
  return (
    isIdentityBasicColor(a) &&
    (a.blur ?? 0) === 0 &&
    (a.edgeFeather ?? 0) === 0
  );
}

export function isIdentityCurve(pts: readonly (readonly [number, number])[] | undefined): boolean {
  if (!pts || pts.length === 0) return true;
  if (pts.length !== 2) return false;
  const [a, b] = pts;
  return a[0] === 0 && a[1] === 0 && b[0] === 1 && b[1] === 1;
}

export function isIdentityCurves(c: CurvesState | undefined): boolean {
  if (!c) return true;
  return (
    isIdentityCurve(c.rgb) &&
    isIdentityCurve(c.red) &&
    isIdentityCurve(c.green) &&
    isIdentityCurve(c.blue)
  );
}

export function isIdentityLevels(l: LevelsState | undefined): boolean {
  if (!l) return true;
  return (
    l.inputBlack === 0 &&
    l.inputWhite === 255 &&
    l.gamma === 1 &&
    l.outputBlack === 0 &&
    l.outputWhite === 255
  );
}

export function isIdentityChannelMix(m: ChannelMixState | undefined): boolean {
  if (!m) return true;
  const eq = (v: readonly [number, number, number], t: [number, number, number]) =>
    v[0] === t[0] && v[1] === t[1] && v[2] === t[2];
  return (
    eq(m.red, [1, 0, 0]) &&
    eq(m.green, [0, 1, 0]) &&
    eq(m.blue, [0, 0, 1]) &&
    (!m.constant || eq(m.constant, [0, 0, 0]))
  );
}

export function isIdentityColorBalance(cb: ColorBalanceState | undefined): boolean {
  if (!cb) return true;
  const isZero = (v: readonly [number, number, number]) => v[0] === 0 && v[1] === 0 && v[2] === 0;
  return isZero(cb.shadows) && isZero(cb.midtones) && isZero(cb.highlights);
}

/**
 * Whether a grade bundle carries no observable change in ANY arm. Shared by
 * the legacy migration (an all-identity fold yields no mask) and the layers
 * panel indicator (an identity mask is not an "adjustment").
 */
export function isIdentityGrade(g: GradeState | undefined): boolean {
  if (!g) return true;
  return (
    isIdentityBasic(g.adjustments) &&
    isIdentityLevels(g.levels) &&
    isIdentityCurves(g.curves) &&
    isIdentityChannelMix(g.channelMix) &&
    isIdentityColorBalance(g.colorBalance)
  );
}
