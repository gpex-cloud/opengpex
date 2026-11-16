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
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The animation playback pipeline — the engine's lightweight sibling of the
 * scene compositing pipeline (2026-11-16 presentation-pipeline proposal).
 *
 * DECOUPLING CONTRACT: this directory is PURE HEADLESS engine logic (no JSX,
 * no React) — the DOM host for its output lives at
 * `stage/viewport/PlaybackStage.tsx` (CanvasStage's sibling file). Nothing
 * here imports the scene path (WebGpuEngine / RenderController /
 * SceneAssembler / SceneContentCache), and nothing in the scene path imports
 * this directory. The shared foundations (GPUDevice, geometry operators,
 * bitmap cache, interaction-signal channel) are explicitly allowed — they
 * are the engine's engineering base, not the scene pipeline.
 */

export {
  PLAYBACK_SESSION_SIGNAL_KEY,
  PLAYBACK_SEEK_SIGNAL_KEY,
} from './protocol';
export type {
  PlaybackSessionSpec,
  PlaybackFrameSpec,
  PlaybackSeekRequest,
} from './protocol';
export { PlaybackController } from './PlaybackController';
export { PlaybackEngine } from './PlaybackEngine';
export type { PlaybackEngineOptions, PlaybackFrameBindInput } from './PlaybackEngine';
export type { PlaybackControllerOptions, PlaybackTickInput } from './PlaybackController';
export type { PlaybackFrameSource, PlaybackFrameHandle } from './frameSource';
