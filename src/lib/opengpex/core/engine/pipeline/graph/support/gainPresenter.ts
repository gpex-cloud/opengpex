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
 * gainPresenter.ts — the present-time gain-map decision collaborator (phase
 * C1): the frame-level counterpart of `roiFrame`/`layerGeometry`, owning
 * everything between "the scene names a gain-map asset" and "the view pass
 * samples a decoded, eased map":
 *
 *   - GPU residency: the decoded CPU payload (`gainMapSourceCache`) is
 *     uploaded to an r8unorm texture ONCE per asset and reused every present;
 *   - the gain ease (the gradual brighten macOS Photos applies when an
 *     Adaptive-HDR image opens): one strength, eased over GAIN_RAMP_MS toward
 *     1 when gain presentation starts and toward 0 when HDR is switched off,
 *     instead of snapping either way;
 *   - the rAF self-pump: the render ticker skips static scenes, so while the
 *     ease is running the presenter re-presents the last frame itself through
 *     the injected `replayFrame` (the composite is signature-cached — each
 *     replayed frame is a cheap present-only pass).
 *
 * The ease scales BOTH affine decode parameters by the strength s: the shader
 * computes exp2(min + lin·(max−min)), so min/max ×= s yields exactly
 * exp2(s·gain) — ×1 at s=0, the authored factor at s=1, with the map's
 * spatial structure intact through the whole ramp.
 *
 * Deliberately NOT a pass: the pixel work is three shader lines inside the
 * view fragment (a separate full-screen gain pass would cost a read+write for
 * ~10 ALU ops — the same reason the W→display projection is inlined there).
 * This class is the DECISION half the pass consumes via its uniform.
 *
 * Device/env access is injected as read-only closures, keeping the dependency
 * one-way (never imports the engine) and the state machine unit-testable with
 * a fake clock.
 *
 * @module core/engine/pipeline/graph/support/gainPresenter
 */

import { GPUTextureUsage } from '@opengpex/editor/core/engine/gpu/constants';
import { gainMapSourceCache } from '@opengpex/editor/core/engine/sources/GainMapSource';

/** Everything the view pass needs to reconstruct the HDR rendition. The uv
 * placement is derived separately at present (RenderGraph folds the ROI); the
 * presenter owns texture + parameters only. */
export interface PresentGainMap {
  readonly textureView: GPUTextureView;
  readonly gainMin: number;
  readonly gainMax: number;
  readonly gamma: number;
}

/** Duration of the gain ease, both directions: switching HDR on (or the map
 * decode landing) brightens from ×1 to the full factor, switching it off
 * dims back to ×1 before the surface leaves HDR. 500ms reads as a calm fade
 * rather than a snap. */
export const GAIN_RAMP_MS = 500;

interface GainPresenterDeps {
  /** The live device, or null before init / during loss (resolve degrades). */
  readonly getDevice: () => GPUDevice | null;
  /** Whether the surface is in HDR presentation (extended + float16). */
  readonly isHdrActive: () => boolean;
  /** Re-present the last frame once — the ease's render pump. */
  readonly replayFrame: () => void;
}

/** One running ease: strength moves from `from` to `to` starting at `t0`. */
interface Ramp {
  readonly from: number;
  readonly to: number;
  readonly t0: number;
}

export class GainPresenter {
  private readonly deps: GainPresenterDeps;
  private readonly now: () => number;

  /** Device-owned r8unorm textures keyed by asset id — upload once, reused
   * every present; destroyed (and re-uploaded on demand) with the device. */
  private readonly textures = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();

  /** Applied gain strength, 0 (SDR base) … 1 (full HDR rendition). */
  private strength = 0;
  private ramp: Ramp | null = null;
  private raf = 0;
  /** Settles the pending {@link beginDim} once the strength reaches 0. */
  private dimDone: (() => void) | null = null;

  constructor(deps: GainPresenterDeps, now: () => number = () => performance.now()) {
    this.deps = deps;
    this.now = now;
  }

  /**
   * Resolve THIS present's gain context: undefined when nothing is applied
   * (HDR off and not dimming, no eligible asset, map still decoding, no
   * device) — the view pass then presents the SDR base with `gain_enabled = 0`.
   * While enabled the strength eases toward 1; after {@link beginDim} it
   * eases toward 0 on the still-HDR surface.
   */
  resolve(assetId: string | undefined): PresentGainMap | undefined {
    const dimming = this.dimDone !== null;
    const src = assetId ? gainMapSourceCache.get(assetId) : undefined;
    const device = this.deps.getDevice();
    if (!assetId || !src || !device || (!dimming && !this.deps.isHdrActive())) {
      this.settle(0);
      return undefined;
    }
    const entry = dimming ? this.textures.get(assetId) : this.ensureTexture(assetId, src, device);
    if (!entry) {
      this.settle(0);
      return undefined;
    }
    if (!dimming && this.strength < 1 && (!this.ramp || this.ramp.to !== 1)) {
      this.startRamp(1);
    }
    const strength = this.advance();
    if (dimming && strength <= 0) return undefined;
    return {
      textureView: entry.view,
      gainMin: src.gainMin * strength,
      gainMax: src.gainMax * strength,
      gamma: src.gamma,
    };
  }

  /**
   * HDR switched off: ease the applied strength to 0. The caller keeps the
   * surface in HDR until the promise resolves, then reconfigures to SDR —
   * dimming on an SDR surface would clip the highlights in one frame.
   * Resolves immediately when no gain is applied.
   */
  beginDim(): Promise<void> {
    this.advance();
    if (this.strength <= 0) {
      this.settle(0);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.dimDone = resolve;
      this.startRamp(0);
    });
  }

  /** HDR switched back on mid-dim: the next resolve eases up from the current strength. */
  cancelDim(): void {
    if (!this.dimDone) return;
    this.advance();
    this.ramp = null;
    this.finishDim();
  }

  /**
   * Device loss / teardown: the textures belonged to the dead device (the CPU
   * payload in gainMapSourceCache survives, so the next resolve re-uploads and
   * re-runs the ease).
   */
  release(): void {
    for (const entry of this.textures.values()) entry.texture.destroy();
    this.textures.clear();
    this.settle(0);
  }

  private ensureTexture(
    assetId: string,
    src: { map: Uint8Array; width: number; height: number },
    device: GPUDevice,
  ): { texture: GPUTexture; view: GPUTextureView } {
    let entry = this.textures.get(assetId);
    if (!entry) {
      const texture = device.createTexture({
        label: `Gain Map (${assetId})`,
        size: { width: src.width, height: src.height },
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      // Single-channel rows upload straight from the decoded payload
      // (bytesPerRow = width; writeTexture has no 256-alignment demand).
      device.queue.writeTexture(
        { texture },
        src.map,
        { bytesPerRow: src.width, rowsPerImage: src.height },
        { width: src.width, height: src.height },
      );
      entry = { texture, view: texture.createView({ label: `Gain Map View (${assetId})` }) };
      this.textures.set(assetId, entry);
    }
    return entry;
  }

  private startRamp(to: number): void {
    this.ramp = { from: this.strength, to, t0: this.now() };
    this.pump();
  }

  /** Advance the running ease (smoothstep on wall-clock) and return the strength. */
  private advance(): number {
    const r = this.ramp;
    if (!r) return this.strength;
    const t = Math.min(1, (this.now() - r.t0) / GAIN_RAMP_MS);
    this.strength = r.from + (r.to - r.from) * (t * t * (3 - 2 * t));
    if (t >= 1) {
      this.ramp = null;
      this.strength = r.to;
      if (r.to === 0) this.finishDim();
    }
    return this.strength;
  }

  /** Jump to a strength with no ease (nothing presentable / teardown). */
  private settle(strength: number): void {
    this.strength = strength;
    this.ramp = null;
    if (this.raf) {
      const cancel = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : ((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
      cancel(this.raf);
      this.raf = 0;
    }
    this.finishDim();
  }

  private finishDim(): void {
    const done = this.dimDone;
    this.dimDone = null;
    done?.();
  }

  /**
   * rAF self-pump while an ease runs: re-present via the injected replay so
   * `resolve` advances the ease next frame, despite the static-skipping
   * ticker. Falls back to setTimeout where rAF does not exist (tests).
   */
  private pump(): void {
    if (this.raf) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
    const step = () => {
      this.raf = 0;
      if (!this.ramp) return;
      this.deps.replayFrame();
      if (this.ramp) this.raf = schedule(step);
    };
    this.raf = schedule(step);
  }
}
