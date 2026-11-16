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
 * Animation playback pipeline — session protocol.
 *
 * The playback pipeline (this directory) is an engine SIBLING of the scene
 * compositing pipeline: it shares the GPUDevice and engineering foundations
 * but imports NOTHING from the scene path (WebGpuEngine / RenderController /
 * SceneAssembler / SceneContentCache). The two pipelines communicate through
 * the interaction-signal channel only, with these two keys:
 *
 *   • PLAYBACK_SESSION_SIGNAL_KEY — the plugin publishes a
 *     {@link PlaybackSessionSpec} when a playback session starts and clears it
 *     (null) on pause/stop. The PlaybackStage host component (mounted in the
 *     viewport) reads it and drives the pipeline.
 *
 * Both signals are interaction signals: session-scoped transients, never
 * persisted. The stage-side silence is NOT part of this protocol: the stage
 * exposes its own generic content filter (see
 * `stage/viewport/CanvasStageFilter.ts`) and the plugin publishes the
 * sequence's layer ids there — the playback pipeline carries no stage
 * vocabulary at all.
 */

/** Interaction-signal key carrying the {@link PlaybackSessionSpec}. */
export const PLAYBACK_SESSION_SIGNAL_KEY = 'playback.session';

/**
 * Interaction-signal key carrying a seek request for the LIVE session
 * ({@link PlaybackSeekRequest}). Plugin→pipeline direction: writing this
 * signal while a session is open moves that session's playhead. The `rev`
 * counter disambiguates repeated seeks to the same index (effects key on it).
 */
export const PLAYBACK_SEEK_SIGNAL_KEY = 'playback.seekRequest';

/** Seek-request payload (plugin → playback pipeline). */
export interface PlaybackSeekRequest {
  readonly sequenceId: string;
  readonly index: number;
  /** Monotonic counter — re-trigger guarantee for identical indexes. */
  readonly rev: number;
}

/** One playable frame of the sequence (a doc layer snapshot at publish time). */
export interface PlaybackFrameSpec {
  /** Owning layer id (drives the seek→layer-selection mapping). */
  readonly layerId: string;
  readonly assetId: string;
  /** Layer src token — resolved through AssetService.resolve before decode. */
  readonly src: string;
  /** Frame delay in ms (already includes the user FPS override). */
  readonly delay: number;
}

/**
 * Playback session descriptor published by the AnimatedImagesDrawer player
 * and consumed by the PlaybackStage host (stage/viewport/). Everything the pipeline needs to
 * run is snapshotted here at publish time — the pipeline never reads the
 * document again during playback (the document is frozen while playing).
 */
export interface PlaybackSessionSpec {
  // Index signature: session specs travel through the interaction-signal
  // channel whose value type is `{ [key: string]: unknown }`.
  [key: string]: unknown;
  readonly sequenceId: string;
  readonly frames: readonly PlaybackFrameSpec[];
  /** Loop config (user toggle) — a non-looping session stops at the last frame. */
  readonly loop: boolean;
  /** Resume point: the frame index playback starts from (default 0). The
   * plugin publishes the paused playhead so resume continues, not restarts. */
  readonly startIndex?: number;
  /** Clock→UI feedback: the playing frame index changed. */
  readonly onFrameChange?: (index: number) => void;
  /** Non-looping sessions only: the last frame finished playing. */
  readonly onEnded?: () => void;
}

