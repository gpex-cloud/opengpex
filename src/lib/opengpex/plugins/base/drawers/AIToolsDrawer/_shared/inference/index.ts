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
 * Shared Inference Backend — Public API
 *
 * Barrel export for the unified inference abstraction layer.
 * Workers import `createSession(backend)` to get the correct session
 * implementation without coupling to concrete classes.
 *
 * ⚠️ This module is imported by Web Workers — keep it free of DOM/React deps.
 */

import type { BackendType, InferenceSession as ISession } from './types';
import { OrtSession } from './ort-session';
import { TransformersSession } from './tfm-session';

// ─── Core types ──────────────────────────────────────────────────────────────

export type {
  BackendType,
  InferenceArgs,
  InferenceInput,
  InferenceOutput,
  InferenceSession,
  WorkerRequest,
  WorkerProgress,
  WorkerError,
} from './types';

// ─── Session Factory ─────────────────────────────────────────────────────────

/**
 * Create an inference session for the specified backend.
 *
 * This is the sole entry point for workers — they never instantiate
 * OrtSession or TransformersSession directly.
 */
export function createSession(backend: BackendType): ISession {
  if (backend === 'ort') return new OrtSession();
  return new TransformersSession();
}

// ─── Backend implementations (legacy — will be removed once all workers migrate) ─

/** @deprecated Use `createSession('ort')` instead. */
export { OrtSession } from './ort-session';
/** @deprecated Use `createSession('transformers')` instead. */
export { TransformersSession } from './tfm-session';

// ─── Tensor utilities ────────────────────────────────────────────────────────

export {
  rgbaToNchw,
  tensorToRgba,
  detectOutputRange,
  detectLayout,
} from './tensor-utils';

// ─── Session Pipeline Orchestrator ───────────────────────────────────────────

export { createInference } from './createInference';
export type { PipelineConfig, PipelineReport } from './createInference';

// ─── Tile utilities ──────────────────────────────────────────────────────────

export type { TileSpec } from './tile-utils';
export {
  computeTiles,
  extractTile,
  padTile,
  unpadTile,
  pasteTileBlend,
} from './tile-utils';
