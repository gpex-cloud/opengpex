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
 * ResidentTransientCache.ts — engine-owned, exact-size reuse for the ONE class
 * of compositor transient the POT pool can't hold: full-canvas / oversized ones.
 *
 * It mirrors the composite-target pattern: a full-canvas-class transient
 * (the active vector stroke's transient, the ping-pong buffers) is allocated
 * EXACT-size (never POT), kept resident, and reused in place frame after frame,
 * so the per-frame `createTexture(hundreds of MiB) + destroy` churn that poisoned
 * the pool is gone on the hot path.
 *
 * ── REUSE BY SHAPE, NOT BY IDENTITY (①) ──
 * The active brush stroke is a SINGLETON — only one stroke is ever in progress —
 * but "one stroke = one layer" gives each stroke a fresh `layerId`. Keying reuse
 * on that id meant every mousedown was a cache MISS → a fresh full-canvas alloc
 * per stroke (the drag-start hitch). So reuse is keyed on the SHAPE
 * (`width×height:format:usage`) instead: consecutive strokes at the same canvas
 * dims hand back the SAME physical texture, and a real `createTexture` happens
 * only on the FIRST stroke (or the first after the idle-grace reclaim).
 *
 * Content identity across frames is NOT required for correctness: every consumer
 * (vector prepass, ping-pong buffers) fully rewrites its transient each frame
 * (loadOp:'clear' + redraw), so which physical texture a logical slot gets is
 * immaterial — only the exact size is.
 *
 * ── CONCURRENCY WITHIN A FRAME ──
 * Two slots of the SAME shape may be live at once (ping-pong needs buffer A AND
 * buffer B, both frame-sized). A texture is therefore handed out to at most ONE
 * `acquire` per frame (tracked by generation): the second same-shape acquire of
 * a frame skips the just-handed-out texture and reuses/creates another. So A and
 * B always get distinct textures, and both are reused next frame.
 *
 * ── IDLE-GRACE RECLAIM (①) ──
 * A slot NOT acquired this frame is kept for `IDLE_GRACE_MS` of wall-clock so the
 * NEXT stroke can reuse it, then destroyed by `endFrame`. Grace is time-based,
 * not frame-based: when the editor is fully idle no frame renders, so `endFrame`
 * never runs and an unused slot simply persists until rendering resumes — at
 * which point, if it has gone unused past the grace window, it is reclaimed. Two
 * strokes drawn within the grace window reuse; a long-abandoned slot is freed the
 * first render frame after the window elapses. No high-water-mark, no manual
 * release.
 *
 * @module core/engine/gpu/resources/ResidentTransientCache
 */

import { estimateTextureBytes } from './TexturePool';
import { PERF_MON } from '@opengpex/editor/core/helpers/config';

/**
 * How long an unused resident slot survives before `endFrame` reclaims it, so a
 * quick succession of strokes reuses one allocation instead of one-per-stroke.
 * 2 s comfortably covers the gap between a stroke's commit and the next
 * pointerdown for continuous painting, while still releasing the (hundreds of
 * MiB) slot promptly once the user moves on.
 */
const IDLE_GRACE_MS = 2000;

/** Shape of a resident slot's texture — the reuse key beyond the string id. */
export interface ResidentTransientDesc {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly usage: number;
  readonly label?: string;
}

interface ResidentSlot {
  texture: GPUTexture;
  width: number;
  height: number;
  format: GPUTextureFormat;
  usage: number;
  /** `width×height:format:usage` — the reuse bucket. */
  sig: string;
  /** Generation of the last frame that `acquire`d this slot (concurrency guard). */
  lastGen: number;
  /** `performance.now()` when last acquired (idle-grace clock). */
  lastUsedAt: number;
}

/** Shape signature: two slots share a reuse bucket iff every dimension matches. */
function shapeSig(desc: ResidentTransientDesc): string {
  return `${desc.width}×${desc.height}:${desc.format}:${desc.usage}`;
}

export class ResidentTransientCache {
  /** All live textures, reused across frames by shape (see header). */
  private slots: ResidentSlot[] = [];
  private gen = 0;

  constructor(private readonly device: GPUDevice) {}

  /** Open a frame: bump the generation so each shape can hand out fresh slots. */
  beginFrame(): void {
    this.gen++;
  }

  /**
   * Return an EXACT-size texture matching `desc`'s shape, reused in place from a
   * slot not already handed out this frame; a real `createTexture` runs only when
   * no free slot of that shape exists. `key` is diagnostic only — reuse is by
   * shape, not by key (see header). Marks the slot live for the current frame.
   */
  acquire(key: string, desc: ResidentTransientDesc): GPUTexture {
    const { width, height, format, usage, label } = desc;
    const sig = shapeSig(desc);
    const now = performance.now();

    // Reuse a slot of this shape that no earlier acquire THIS frame already took
    // (so same-shape concurrent buffers — ping-pong A/B — stay distinct).
    for (const s of this.slots) {
      if (s.sig === sig && s.lastGen !== this.gen) {
        s.lastGen = this.gen;
        s.lastUsedAt = now;
        return s.texture;
      }
    }

    // No free slot of this shape → real allocation (first stroke / after reclaim).
    const texture = this.device.createTexture({
      size: [width, height, 1],
      format,
      usage,
      label: label ?? `Resident Transient (${key})`,
    });
    this.slots.push({ texture, width, height, format, usage, sig, lastGen: this.gen, lastUsedAt: now });

    // [PERF_MON] A CREATE here is a real GPU allocation. With shape reuse it fires
    // only on a genuine miss — the FIRST stroke at these dims, or the first after
    // the idle-grace reclaim — not once per mousedown. If it still prints on every
    // brush drag-start, the shape is drifting frame-to-frame (investigate dims).
    if (PERF_MON) {
      const mib = estimateTextureBytes(width, height, format) / (1024 * 1024);
      console.warn(
        `[ResidentTransient] CREATE ${key} ${width}×${height} ${format} ≈${mib.toFixed(1)}MiB (live slots: ${this.slots.length})`,
      );
    }

    return texture;
  }

  /**
   * Close a frame: destroy every slot untouched this frame that has also sat idle
   * past `IDLE_GRACE_MS`, keeping recently-used slots resident so the next stroke
   * reuses them (①). Slots acquired this frame are always kept.
   */
  endFrame(): void {
    if (this.slots.length === 0) return;
    const now = performance.now();
    const cutoff = now - IDLE_GRACE_MS;
    this.slots = this.slots.filter((s) => {
      const idleThisFrame = s.lastGen !== this.gen;
      if (idleThisFrame && s.lastUsedAt < cutoff) {
        s.texture.destroy();
        return false;
      }
      return true;
    });
  }

  /** Immediate, total reclaim (dimsChanged / device loss / teardown). */
  clear(): void {
    for (const s of this.slots) s.texture.destroy();
    this.slots = [];
  }

  /** Sum of resident bytes across all live slots (diagnostics / GpuInfo). */
  totalBytes(): number {
    let bytes = 0;
    for (const s of this.slots) {
      bytes += estimateTextureBytes(s.width, s.height, s.format);
    }
    return bytes;
  }
}
