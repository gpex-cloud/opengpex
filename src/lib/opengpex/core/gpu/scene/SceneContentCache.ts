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
 * SceneContentCache.ts — CPU-side compose-once/view-many for scene ASSEMBLY
 * (P1 §4, the residual of 缺陷 5).
 *
 * PROBLEM: 缺陷 5 阶段 2 stopped the GPU re-compositing on pan/zoom, but
 * `CanvasStage` still called `SceneAssembler.assemble(...)` — which re-runs the
 * O(layers) CONTENT assembly (matrix build, cull, bitmap resolve, mask
 * rasterize, upload planning) — on EVERY camera frame. That per-frame CPU cost
 * is the P1 "静止后开始缩放/平移瞬间 120→100、持续 100–120 波动".
 *
 * FIX: memoize the camera-INDEPENDENT content half ({@link SceneContent} +
 * uploads). On a cam-only frame the reuse key is unchanged, so we return the
 * SAME content object (stable `layers` reference) and only
 * `SceneAssembler.composeView` (one snap + one matmul) runs. The stable `layers`
 * reference also lets the engine skip its per-frame signature-string rebuild.
 *
 * SOUNDNESS — WHY THIS CANNOT REGRESS 缺陷 5 (never false-CLEAN):
 * The reuse key is built ONLY from inputs `computeCompositeSignature` itself
 * derives from:
 *   • `layersRef` — the frame's layer container reference. During pan/zoom no
 *     layer draft exists, so `mergeFrameSnapshot` does NOT rebuild
 *     `frame.layers` → the reference is stable. ANY genuine edit (buffered draft
 *     or committed Redux change) produces a NEW `frame.layers` → key miss →
 *     re-assemble. (See merge.ts `mergeFrameSnapshot`.)
 *   • `canvasW/H` + `colorSpace` — the only other `SceneContent` inputs.
 *   • `dirty` — an explicit repaint request. Async milestones that change
 *     content WITHOUT changing `layersRef` (bitmap decode / tile ready via the
 *     cache `subscribe` callbacks; buffer resize; active-frame switch) all set
 *     `needsRenderRef`, surfaced here as `dirty`.
 *   • `animating` — a tween is mutating a display value each frame.
 *
 * Because every one of these is an input the signature is a PURE FUNCTION of,
 * "same key ⟹ same signature". The cache can therefore only ever be falsely
 * DIRTY (a wasted rebuild — harmless, same cost as today), NEVER falsely clean
 * (the only thing that would bring back 缺陷 5). The engine's own signature gate
 * remains the correctness backstop (defence in depth).
 *
 * @module core/gpu/scene/SceneContentCache
 */

import type { SceneContent } from './Scene';
import type { AssetUpload } from './SceneAssembler';

/**
 * The camera-independent reuse key. All fields are cheap scalars / one object
 * reference — comparison is O(1), never a deep walk. A field set here MUST be an
 * input to `computeCompositeSignature` (see module SOUNDNESS note); adding a
 * camera/view field here would be a 缺陷-5 regression.
 */
export interface ContentKey {
  /** The `frame.layers` container reference (stable on pan/zoom, new on edit). */
  readonly layersRef: unknown;
  /** Document (canvas native) dimensions — a resize rebuilds content. */
  readonly canvasW: number;
  readonly canvasH: number;
  /** Working colour space — part of SceneContent. */
  readonly colorSpace: string;
  /**
   * Explicit repaint request for this tick (needsRender / bufferResized). When
   * true the cache ALWAYS rebuilds — covers content mutations that do not change
   * `layersRef` (async bitmap/tile decode, active-frame switch, buffer resize).
   */
  readonly dirty: boolean;
  /** A tween is animating a display value this frame — always rebuild. */
  readonly animating: boolean;
}


function keysEqual(a: ContentKey, b: ContentKey): boolean {
  // `dirty` / `animating` force a rebuild by never comparing equal when set —
  // a dirty or animating frame must not be served from cache.
  if (a.dirty || b.dirty || a.animating || b.animating) return false;
  return (
    a.layersRef === b.layersRef &&
    a.canvasW === b.canvasW &&
    a.canvasH === b.canvasH &&
    a.colorSpace === b.colorSpace
  );
}

/**
 * A tiny, framework-agnostic memo of the last `{content, uploads}` keyed by a
 * {@link ContentKey}. Not React-coupled so it is directly unit-testable (mirrors
 * compositeSignature.test / WebGpuEngine.composeCache.test "还原即失败" style).
 */
export class SceneContentCache {
  private lastKey: ContentKey | null = null;
  private lastContent: SceneContent | null = null;
  /** Diagnostics: true iff the most recent {@link get} was served from cache. */
  private lastWasHit = false;

  /**
   * Return the memoized content for `key`, or rebuild via `build()` on a miss.
   * On a HIT the returned `content` is the SAME object reference as the previous
   * call — that reference stability is what the engine's signature memo and the
   * "skip re-composite" path rely on.
   *
   * On a hit, `uploads` is returned EMPTY: the resident textures were already
   * flushed on the building frame and the engine dedups by reference/version, so
   * re-flushing the same bitmaps every pan/zoom frame is pure waste. (A genuine
   * pixel edit changes `layersRef` → miss → rebuild → fresh uploads.)
   */
  get(
    key: ContentKey,
    build: () => { content: SceneContent; uploads: AssetUpload[] },
  ): { content: SceneContent; uploads: readonly AssetUpload[]; hit: boolean } {
    if (this.lastKey && this.lastContent && keysEqual(this.lastKey, key)) {
      // ── CACHE HIT (cam-only frame) ─────────────────────────────────────────
      // NOTE (P1 真机结论 2026-09, 见 §4): the "120→100 on pan/zoom" report that
      // motivated this cache turned out to be a DevTools MEASUREMENT ARTIFACT —
      // with F12 CLOSED the pipeline sits at the vsync ceiling (~120, min 116),
      // and PERF_MON measured this whole build at assemble≈0.01ms. So this hit
      // path is NOT curing a pipeline defect (there was none). It is a
      // DEFENCE-IN-DEPTH optimization that keeps the per-frame cost O(1) instead
      // of O(layers) for the cases the 2-layer test scene did not stress:
      // many-layer / heavy-mask documents and low-end machines, where the skipped
      // assembly + skipped signature JSON.stringify is a real, if situational,
      // win. Reverting would re-add per-frame busywork for zero correctness gain.
      this.lastWasHit = true;
      return { content: this.lastContent, uploads: [], hit: true };
    }
    const { content, uploads } = build();
    this.lastKey = key;
    this.lastContent = content;
    this.lastWasHit = false;
    return { content, uploads, hit: false };
  }

  /** Whether the last {@link get} was a cache hit (diagnostics / tests). */
  wasHit(): boolean {
    return this.lastWasHit;
  }

  /** Drop the memo (e.g. on unmount / device loss). */
  clear(): void {
    this.lastKey = null;
    this.lastContent = null;
    this.lastWasHit = false;
  }
}
