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
 * utils.ts — shared, dependency-free predicates for the geometry operators.
 */

import type { Layer, Frame } from '@opengpex/editor/core/types';

/**
 * isLayerSource: narrow a `Layer | Frame` source/target down to `Layer`.
 *
 * The two candidate types are distinguished purely by structure: only `Layer`
 * carries a `type` field — `Frame` has none. So the presence of `type` is both
 * necessary and sufficient to identify a Layer, and TypeScript narrows the
 * union accordingly via the `s is Layer` predicate.
 *
 * NOTE: this intentionally does NOT enumerate the individual Layer `type`
 * literals ('image' | 'text' | 'vector' | 'color' | 'paint' | 'group' | ...).
 * The previous inlined checks did, which (a) was redundant for narrowing and
 * (b) silently dropped 'group' (and any future kind) into the Frame branch —
 * a latent coordinate-mapping bug. Keying off the structural `type` field keeps
 * every current and future Layer kind correctly on the Layer branch with no
 * further edits here.
 */
export function isLayerSource(s: Layer | Frame): s is Layer {
  return 'type' in s;
}
