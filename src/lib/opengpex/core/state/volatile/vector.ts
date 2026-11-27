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
 * vector.ts — Engine-neutral volatile preview protocol for in-flight vector
 * gestures that create their persisted layer on pointer-up rather than
 * pointer-down.
 *
 * The tool writes an ephemeral Layer snapshot into `volatile.transient` under
 * `VECTOR_TRANSIENT_KEY`; `RenderController` forwards it to
 * `SceneAssembler.composeView`, which inserts the assembled `LayerNode` at the
 * requested z-order without invalidating `SceneContentCache` or dispatching to
 * Redux `frame.layers`.
 */

import type { Layer } from '@opengpex/editor/core/types';

/** Transient key carrying an in-flight ephemeral vector preview layer. */
export const VECTOR_TRANSIENT_KEY = 'vector';

/** Payload for the ephemeral vector preview transient slot. */
export interface VectorPreviewPayload {
  readonly frameId: string;
  /** Temporary layer carrying a per-session unique id to avoid transient collisions. */
  readonly layer: Layer;
  /** Optional z-order anchor: insert right after this layer id (defaults to stack top). */
  readonly insertAfterLayerId?: string;
}
