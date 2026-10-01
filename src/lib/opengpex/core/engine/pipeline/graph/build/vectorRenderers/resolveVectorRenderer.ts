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
 * resolveVectorRenderer.ts — Exhaustive strategy selector for the vector spine.
 *
 * Breaks `prepareVectorSources`'s direct dependency on the concrete `SdfRenderer` /
 * `StrokeRenderer` singletons (previously imported and ternary-dispatched inline).
 * The `switch` has NO `default` arm: `VectorRendererId` is a closed union, so TS
 * flags any unhandled id at COMPILE time. This also fixes a latent bug in the old
 * ternary (`source.renderer === 'sdf' ? sdfRenderer : strokeRenderer`), which would
 * have silently routed any future third id to `strokeRenderer`.
 *
 * @module core/gpu/graph/build/vectorRenderers/resolveVectorRenderer
 */

import type { VectorRendererId } from '../../../scene/Scene';
import type { VectorRenderer } from './VectorRenderer';
import { sdfRenderer } from './SdfRenderer';
import { strokeRenderer } from './StrokeRenderer';

export function resolveVectorRenderer(id: VectorRendererId): VectorRenderer {
  switch (id) {
    case 'sdf':
      return sdfRenderer;
    case 'stroke':
      return strokeRenderer;
  }
}
