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

import React from 'react';
import { Star } from 'lucide-react';
import { fromHex } from '@opengpex/editor/core/engine/color';
import type { StarMarkerData } from '../../../types';
import { defineRadialKind } from '../definition';

/**
 * Default spike count. The spike SHAPE has no free parameter: the star is the
 * TRUE {n/2} star polygon (straight chords between alternate tips), with the
 * radial sharpness derived per n by `starTrueSharpness` at translation.
 */
export const STAR_DEFAULT_POINTS = 5;

/**
 * The ONLY star spike counts the product offers — a fixed preset set, no free
 * numeric range. Each preset is a valid TRUE {n/2} star (2n/(n−2) sharpness,
 * non-degenerate valleys); 4 is geometrically impossible for a true star (the
 * derived sharpness collapses the valleys onto the centre) and is therefore
 * not offered. Legacy documents may still hold off-preset counts: they render
 * exactly as stored and the panel simply shows no active preset for them.
 */
export const STAR_POINTS_PRESETS: readonly number[] = [5, 6, 8, 10, 12];

/**
 * StarDefinition: regular star inscribed in the layer bounding. A family
 * preset — the shared inscribed-box drag model comes from `defineRadialKind`;
 * the spike count is a fixed preset set (see STAR_POINTS_PRESETS), not a free
 * parameter.
 */
export const StarDefinition = defineRadialKind<StarMarkerData>({
  kind: 'star',
  label: 'Star',
  icon: React.createElement(Star, { size: 16 }),
  layerName: (data) => `${data.points}-Point Star`,

  defaults: (): StarMarkerData => ({
    kind: 'star',
    stroke: { color: fromHex('#FFCC00'), width: 3 },
    fill: { color: fromHex('#FFCC00'), opacity: 0 },
    points: STAR_DEFAULT_POINTS,
    // Content-bounding semantics from birth: the dragged box IS the painted
    // star's AABB (the same convention as rect / line-segment / polygon).
    // No sharpness: new stars are always the TRUE star polygon (see
    // starTrueSharpness); the field is legacy-only on old documents.
    bounding: true,
  }),
});
