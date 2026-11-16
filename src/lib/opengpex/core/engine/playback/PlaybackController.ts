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

import type { PlaybackSessionSpec } from './protocol';
import { RingTextureSource } from './RingTextureSource';
import { PlaybackEngine } from './PlaybackEngine';
import { composeFrameView, type Affine2D } from './cameraFold';
import { snapCanvasRect } from '@opengpex/editor/core/geometry/operators/snapping';
import { setTickerActivityLock } from '@opengpex/editor/core/motion';
import { getSharedGpuDevice } from '../gpu/device/GpuDevice';
import type { Frame, CameraState, Dimensions, Layer } from '@opengpex/editor/core/types';

export interface PlaybackControllerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly session: PlaybackSessionSpec;
  readonly resolveSrc: (assetId: string, src: string) => string | null;
  readonly getBitmapSource: (src: string) => ImageBitmap | undefined;
}

export interface PlaybackTickInput {
  readonly camera: CameraState;
  /** The stage's current frame (draft-merged, sequence-silenced). */
  readonly frame: Frame;
  readonly viewportDim: Dimensions;
  readonly dpr: number;
  /** Layer local-matrix resolver (geometry service — document-space placement). */
  readonly getLayerLocalMatrix: (layer: Layer, frame: Frame) => Affine2D;
}

/**
 * PlaybackController — the SCHEDULER of a live playback session, the playback
 * twin of RenderController's orchestration role (clock / seek / session), with
 * all device-bound work delegated to PlaybackEngine (the GPU shell).
 *
 * Three-actor symmetry with the scene pipeline:
 *   PlaybackStage      <-> CanvasStage        (DOM host, stage/viewport/)
 *   PlaybackController <-> RenderController  (scheduler)
 *   PlaybackEngine     <-> WebGpuEngine      (GPU shell)
 *
 * The clock is ACCUMULATOR-based on external ticks (the viewport ticker drives
 * `tick()` — one clock producer for the whole editor, no second rAF): each
 * tick adds real elapsed time and consumes frame delays until the playhead
 * catches up. Catch-up is unbounded in INDEX but presents at most one NEW
 * frame per tick — hidden-tab jumps are clamped, frames may be skipped, the
 * clock never stalls (same discipline as the scene pipeline's dirty tick).
 */
export class PlaybackController {
  /** Self-acquired from the shared-device declaration point — the SAME
   * self-acquire idiom WebGpuEngine uses (its `gpu` field). Nullable with
   * per-method guards exactly like the engine: before `init` the session is
   * inert, and tick() re-probes once per tick so a controller born before
   * engine boot recovers on its own instead of staying dead. */
  private device: GPUDevice | null = null;
  private engine: PlaybackEngine | null = null;
  private source: RingTextureSource | null = null;

  private index = 0;
  /** Accumulated ms owed to the clock since the last frame advance. */
  private debtMs = 0;
  private lastTickMs = 0;
  private disposed = false;

  constructor(private readonly options: PlaybackControllerOptions) {
    // Resume support: start from the published playhead (default frame 0).
    const count = options.session.frames.length;
    this.index = Math.max(0, Math.min(count - 1, options.session.startIndex ?? 0));
    this.tryAcquireDevice();
  }

  /**
   * Self-acquire the shared device (the WebGpuEngine idiom). Called from the
   * constructor AND lazily re-probed by tick(): a controller born before
   * engine boot was previously dead forever (the 2026-11-16 review's race
   * finding) — now it recovers on its own the moment the engine resolves.
   * Also (re)starts the session-scoped side effects: activity lock, frame
   * source, first-frame decode prime, device-lost subscription.
   */
  private tryAcquireDevice(): boolean {
    if (this.engine) return true;
    const device = getSharedGpuDevice().getDevice();
    if (!device) return false;
    this.device = device;
    this.engine = new PlaybackEngine({ canvas: this.options.canvas, device });
    this.source = new RingTextureSource({
      device,
      frames: this.options.session.frames,
      resolveSrc: this.options.resolveSrc,
      getBitmapSource: this.options.getBitmapSource,
    });
    // An animation session IS user-visible activity: hold the ticker awake
    // for the whole session. Without this, the editor's idle power throttle
    // (motion/index.ts — no input events while watching a progress bar)
    // drops the shared ticker to 4Hz ~2s into playback and the playhead
    // bursts 6-7 frames per tick (2026-11-16 device finding).
    setTickerActivityLock(this.options.session.sequenceId, true);
    // Prime the first frame's decode so the session opens on real pixels.
    const first = this.options.session.frames[0];
    if (first) {
      const src = this.options.resolveSrc(first.assetId, first.src);
      if (src) this.options.getBitmapSource(src);
    }
    // Engine-owned device lifecycle: on loss the session ends cleanly (the
    // plugin pauses via onEnded; the document's committed state is untouched).
    device.lost.then(() => {
      if (!this.disposed) this.options.session.onEnded?.();
    });
    return true;
  }

  /** User seek: jump the playhead, restart the tick clock from the new frame. */
  seek(index: number): void {
    const count = this.options.session.frames.length;
    if (count === 0) return;
    this.index = ((index % count) + count) % count;
    this.debtMs = 0;
    this.lastTickMs = performance.now();
  }

  /**
   * Per-tick body, driven by the viewport ticker (the editor's single clock).
   * Advances the playhead by real elapsed time, then presents the current
   * frame (upload -> fold -> bind -> present).
   */
  tick(input: PlaybackTickInput): void {
    if (this.disposed) return;
    this.tryAcquireDevice();
    const engine = this.engine;
    const source = this.source;
    if (!engine || !source) return;

    const now = performance.now();
    const dt = this.lastTickMs === 0 ? 0 : Math.min(now - this.lastTickMs, 250); // clamp hidden-tab jumps
    this.lastTickMs = now;
    this.debtMs += dt;

    const count = this.options.session.frames.length;
    if (count === 0) return;

    // Consume the debt one delay at a time; present at most one NEW frame per
    // tick (skipping ahead is fine — the clock never stalls on a slow frame).
    while (this.debtMs >= this.frameDelay(this.index)) {
      this.debtMs -= this.frameDelay(this.index);
      if (this.index + 1 >= count) {
        if (this.options.session.loop) {
          this.index = 0;
        } else {
          this.options.session.onEnded?.();
          return; // session over — the plugin clears the signals
        }
      } else {
        this.index += 1;
      }
    }

    // ── Buffer sizing (engine-side, mirror of the stage's contract) ──
    engine.syncTarget(input.viewportDim, input.dpr);
    const targetW = Math.max(1, Math.floor(input.viewportDim.w * input.dpr));
    const targetH = Math.max(1, Math.floor(input.viewportDim.h * input.dpr));

    // ── Frame acquisition + fold ──
    // Camera uniforms refresh EVERY tick, unconditionally (engine contract):
    // a pan/zoom while the current frame is not resident (decode miss) must
    // still re-place the last presented frame under the NEW camera.
    const handle = source.frameAt(this.index);
    const spec = this.options.session.frames[this.index];
    const layer = spec ? input.frame.layers.byId[spec.layerId] : undefined;
    if (layer && layer.bounding.w > 0 && layer.bounding.h > 0) {
      const snap = snapCanvasRect(input.camera, input.frame.canvas, input.dpr);
      // Identical fold to the stage's view pass:
      //   M_camera = translate(snap origin) o scale(renderScale)
      // (composeView builds exactly this; re-derived via snapCanvasRect, the
      // shared geometry operator — no scene-path import).
      const camera = {
        a: snap.renderScale.x, b: 0, c: 0, d: snap.renderScale.y,
        tx: snap.physical.x, ty: snap.physical.y,
      };
      const layerM = input.getLayerLocalMatrix(layer, input.frame);
      const view = composeFrameView(camera, layerM, layer.bounding.w, layer.bounding.h, targetW, targetH);
      engine.updateView(view, layer.bounding.w, layer.bounding.h, targetW, targetH);
    }

    // handle = null → decode miss: the engine re-presents its newest slot
    // under the refreshed uniforms (camera pan/zoom never tears the frame
    // loose).
    engine.presentFrame(handle);

    this.options.session.onFrameChange?.(this.index);    this.options.session.onFrameChange?.(this.index);
  }

  private frameDelay(index: number): number {
    return Math.max(16, this.options.session.frames[index]?.delay ?? 100);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.device) setTickerActivityLock(this.options.session.sequenceId, false);
    this.source?.dispose();
    this.engine?.dispose();
  }
}
