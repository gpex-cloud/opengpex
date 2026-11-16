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

import type { PlaybackFrameSource, PlaybackFrameHandle } from './frameSource';
import type { PlaybackFrameSpec } from './protocol';

/** Ring pool depth: 2 textures is the minimum that lets a frame be written
 * and the previous one keep being presented; more buys nothing at tick rate. */
const RING_DEPTH = 2;
/** Async decode-ahead depth (frames kicked for decode past the playhead). */
const PREFETCH_AHEAD = 3;

export interface RingTextureSourceOptions {
  readonly device: GPUDevice;
  readonly frames: readonly PlaybackFrameSpec[];
  /** AssetService.resolve — turns (assetId, src) into the cacheable src URL. */
  readonly resolveSrc: (assetId: string, src: string) => string | null;
  /**
   * Decoded-bitmap read seam (the engine's shared CPU bitmap cache — the same
   * seam the scene pipeline's raster arm probes). Synchronous with a miss:
   * returns undefined and kicks the one-shot async decode; the cache notifies
   * subscribers, so the NEXT tick finds the bitmap resident. The ring source
   * exploits this twice: frameAt re-probes the playhead (null → keep last
   * frame, clock never stalls), and prefetch() re-probes the window ahead so
   * decodes are always in flight before the clock arrives.
   */
  readonly getBitmapSource: (src: string) => ImageBitmap | undefined;
}

/**
 * RingTextureSource — the shipped PlaybackFrameSource (the "2a'" decision of
 * the 2026-11-16 proposal §4).
 *
 * WHY A RING (not one-texture-per-frame): frames live in the editor as
 * per-frame blobs; uploading them into 2–4 REUSED GPUTextures gives O(1) VRAM
 * regardless of frame count, preserves the decoded alpha exactly (no transcode
 * step exists to drop it), has no encoder/codec platform constraints, and
 * costs an in-budget per-tick upload (~2.5 MiB for an 800² frame, ~13 MiB at
 * 2k — a fraction of the 16 ms budget at tick rate).
 *
 * NOT a plain "all frames resident" map — that 2a reading was retired by the
 * same review (a false dichotomy: residency in CPU-side blob storage is free
 * and already paid by import).
 */
export class RingTextureSource implements PlaybackFrameSource {
  private readonly device: GPUDevice;
  private readonly frames: readonly PlaybackFrameSpec[];
  private readonly resolveSrc: RingTextureSourceOptions['resolveSrc'];
  private readonly getBitmapSource: RingTextureSourceOptions['getBitmapSource'];

  /** Ring pool — created lazily on the first decoded bitmap (dims source). */
  private textures: (GPUTexture | null)[] = [null, null];
  private views: (GPUTextureView | null)[] = [null, null];
  private ringIndex = 0;
  /** Dims the pool was created at — a change (shouldn't happen within one
   * sequence, all frames share bounds) rebuilds the pool defensively. */
  private texW = 0;
  private texH = 0;
  private destroyed = false;

  constructor(options: RingTextureSourceOptions) {
    this.device = options.device;
    this.frames = options.frames;
    this.resolveSrc = options.resolveSrc;
    this.getBitmapSource = options.getBitmapSource;
  }

  frameAt(index: number): PlaybackFrameHandle | null {
    if (this.destroyed) return null;
    const spec = this.frames[index];
    if (!spec) return null;

    // Decode-ahead: always keep the window past the playhead in flight. The
    // cache dedups in-flight fetches, so re-probing is a cheap map hit.
    for (let ahead = 1; ahead <= PREFETCH_AHEAD; ahead++) {
      const next = this.frames[(index + ahead) % this.frames.length];
      if (next) {
        const src = this.resolveSrc(next.assetId, next.src);
        if (src) this.getBitmapSource(src);
      }
    }

    const src = this.resolveSrc(spec.assetId, spec.src);
    if (!src) return null;
    const bitmap = this.getBitmapSource(src);
    if (!bitmap) return null; // decode in flight — caller keeps the last frame

    if (bitmap.width !== this.texW || bitmap.height !== this.texH) {
      this.rebuildPool(bitmap.width, bitmap.height);
    }
    const texture = this.textures[this.ringIndex];
    if (!texture) return null;

    // Frames are straight-alpha RGBA; the copy premultiplies to match the
    // playback surface's 'premultiplied' alphaMode (single premultiply, done
    // on the GPU copy path — the blit then passes texels through untouched).
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      // premultipliedAlpha rides the destination tag in this project's
      // WebGPU typings — straight-alpha texels arrive premultiplied, matching
      // the surface's 'premultiplied' alphaMode.
      { texture, premultipliedAlpha: true },
      [texture.width, texture.height],
    );
    const view = this.views[this.ringIndex]!;
    const slot = this.ringIndex;
    this.ringIndex = (this.ringIndex + 1) % RING_DEPTH;
    return { slot, view };
  }

  /** (Re)create the ring pool at the given frame dims, destroying old texels. */
  private rebuildPool(width: number, height: number): void {
    for (const t of this.textures) t?.destroy();
    this.texW = width;
    this.texH = height;
    for (let i = 0; i < RING_DEPTH; i++) {
      const texture = this.device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.textures[i] = texture;
      this.views[i] = texture.createView();
    }
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of this.textures) t?.destroy();
    this.textures = [null, null];
    this.views = [null, null];
  }
}
