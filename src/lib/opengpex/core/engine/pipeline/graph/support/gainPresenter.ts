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
 *   - the reveal ease (the gradual brighten macOS Photos applies when an
 *     Adaptive-HDR image opens): transitioning INTO active gain
 *     presentation ramps the effective headroom from ×1 to the full factor
 *     over GAIN_REVEAL_MS instead of snapping (real-device feedback 2026-10-15);
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

/** Reveal ramp duration for the gradual brighten when an Adaptive-HDR file
 * opens: the presenter eases exp2(s·gain) from ×1 to the full factor over
 * this window. Calibrated at 500ms — long enough to read as a calm fade
 * rather than a snap when the map decode lands late. */
export const GAIN_REVEAL_MS = 500;

interface GainPresenterDeps {
  /** The live device, or null before init / during loss (resolve degrades). */
  readonly getDevice: () => GPUDevice | null;
  /** Whether the surface is in HDR presentation (extended + float16). */
  readonly isHdrActive: () => boolean;
  /** Re-present the last frame once — the ease's render pump. */
  readonly replayFrame: () => void;
}

type RevealState = 'idle' | 'animating' | 'done';

export class GainPresenter {
  private readonly deps: GainPresenterDeps;
  private readonly now: () => number;

  /** Device-owned r8unorm textures keyed by asset id — upload once, reused
   * every present; destroyed (and re-uploaded on demand) with the device. */
  private readonly textures = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();

  private revealState: RevealState = 'idle';
  private revealT0 = 0;
  private revealRaf = 0;

  constructor(deps: GainPresenterDeps, now: () => number = () => performance.now()) {
    this.deps = deps;
    this.now = now;
  }

  /**
   * Resolve THIS present's gain context: undefined when anything is unresolved
   * (HDR off, no eligible asset, map still decoding, no device) — the view
   * pass then presents the authoritative SDR base with `gain_enabled = 0`.
   * Entry into application starts the reveal ramp; while animating, the rAF
   * pump re-presents so the ramp advances despite the static-skipping ticker.
   */
  resolve(assetId: string | undefined): PresentGainMap | undefined {
    if (!this.deps.isHdrActive() || !assetId) {
      this.reset();
      return undefined;
    }
    const src = gainMapSourceCache.get(assetId);
    if (!src) {
      this.reset();
      return undefined;
    }
    const device = this.deps.getDevice();
    if (!device) {
      this.reset();
      return undefined;
    }

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

    // Reveal ease: 'idle' → 'animating' on entering application; the ramp
    // advances on wall-clock and settles into 'done' at t = 1 (the frame that
    // observes t ≥ 1 already presents full strength). Dropping out of
    // application anywhere resets to idle — re-entering restarts the ramp,
    // which is exactly the HDR-toggle-on and map-just-decoded behaviours.
    const t0 = this.now();
    if (this.revealState === 'idle') {
      this.revealState = 'animating';
      this.revealT0 = t0;
      this.pump();
    }
    let strength = 1;
    if (this.revealState === 'animating') {
      const t = Math.min(1, (t0 - this.revealT0) / GAIN_REVEAL_MS);
      strength = t * t * (3 - 2 * t); // smoothstep — decelerating ramp like macOS
      if (t >= 1) this.revealState = 'done';
    }
    return {
      textureView: entry.view,
      gainMin: src.gainMin * strength,
      gainMax: src.gainMax * strength,
      gamma: src.gamma,
    };
  }

  /**
   * Device loss / teardown: the textures belonged to the dead device (the CPU
   * payload in gainMapSourceCache survives, so the next resolve re-uploads and
   * — gracefully — re-runs the reveal ease).
   */
  release(): void {
    for (const entry of this.textures.values()) {
      entry.texture.destroy();
    }
    this.textures.clear();
    this.reset();
  }

  /**
   * rAF self-pump while the ease runs: re-present via the injected replay so
   * `resolve` advances the ease next frame. Re-arms itself from inside the
   * render it triggers until the state leaves 'animating'. Falls back to
   * setTimeout where rAF does not exist (tests / non-window contexts).
   */
  private pump(): void {
    if (this.revealRaf) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
    const step = () => {
      this.revealRaf = 0;
      if (this.revealState !== 'animating') return;
      this.deps.replayFrame();
      if (this.revealState === 'animating') {
        this.revealRaf = schedule(step);
      }
    };
    this.revealRaf = schedule(step);
  }

  private reset(): void {
    if (this.revealState === 'idle' && !this.revealRaf) return;
    this.revealState = 'idle';
    if (this.revealRaf) {
      const cancel = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : ((handle: number) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
      cancel(this.revealRaf);
      this.revealRaf = 0;
    }
  }
}
