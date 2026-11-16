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
 * PlaybackFrameSource — the pluggable frame-provider seam of the playback
 * pipeline.
 *
 * The pipeline's architecture (see the 2026-11-16 presentation-pipeline
 * proposal) deliberately separates WHAT renders a frame (this interface's
 * implementations) from HOW it is presented (PlaybackStage's single blit
 * pass). Two implementations are planned:
 *
 *   • RingTextureSource (shipped) — frames already live in the editor as
 *     per-frame blobs; a ring of 2–4 reused GPUTextures is re-uploaded
 *     per tick (O(1) VRAM, alpha preserved, no transcode step).
 *
 *   • VideoDecoderSource (reserved, NOT implemented) — transcode + WebCodecs
 *     streaming for the future standalone video-layer use case. The seam
 *     below is shaped so that implementation drops in without touching the
 *     pipeline.
 */

/** A decoded, uploadable frame: its resident texture view plus the ring slot
 * it was uploaded into (opaque handle — consumers pass it straight back to
 * the pipeline's present path; the slot is a plain index, no WebGPU type). */
export interface PlaybackFrameHandle {
  readonly slot: number;
  readonly view: GPUTextureView;
}

/**
 * Frame-provider contract. All methods are synchronous from the clock's
 * perspective: sources manage their own async prefetch internally and return
 * `null` when the asked frame is not resident yet (the controller keeps
 * presenting the previous frame — catch-up is forbidden, the clock wins).
 */
export interface PlaybackFrameSource {
  /** Ask for a frame's presentation handle; null = not resident, keep last. */
  frameAt(index: number): PlaybackFrameHandle | null;
  /** Release all GPU/CPU resources (textures, decoders, prefetch state). */
  dispose(): void;
}
