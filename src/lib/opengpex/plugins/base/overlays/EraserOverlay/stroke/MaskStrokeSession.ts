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
 * MaskStrokeSession — Mask editing session (eraser/restore)
 *
 * Manages the lifecycle of a non-destructive mask editing stroke across the
 * TWO-FAMILY record set pinned at session start:
 * - One scratch OffscreenCanvas PER targeted record (lazy: materialized on
 *   first write), each with its own upload-dedup `version` counter
 * - Op routing (see the OP MATRIX doc on `stampOps`): a restore op carves the
 *   restore-family record; an erase op carves the erase-family record AND
 *   white hole-fills every painted restore record
 * - Real-time fast-track override for live preview (the FULL live map is
 *   re-dispatched on every move — the channel replaces the map wholesale)
 * - Multi-record transactional bake request (all touched records land as ONE
 *   undoable unit through the batch command)
 */

import type { Frame, InteractionEvent, IMatrix3x3 } from '@opengpex/editor/core/types';
import type { BitmapMaskOverrideMap } from '@opengpex/editor/core/types';
import { CraftDrawerAPI } from '../../../drawers/CraftDrawer/protocols';
import { StrokeSmoother, type Point2D } from './smoothing';
import { StampEngine } from './stamp';
import type { StrokeSession, StrokeConfig, MaskBakeRequest, MaskBakeRecord, BakeRequest } from './types';

/** Shared signal key for active craft */
const ACTIVE_CRAFT_KEY = CraftDrawerAPI.signals.activeCraft;

// ─── Construction Params ───────────────────────────────────────────────────────

/**
 * ONE pinned target record of the session — a plain descriptor resolved by
 * the factory's family-discriminated selection. `existingMaskId === undefined`
 * marks a brand-new record (baked as an add at stroke end).
 */
export interface MaskSessionRecordDesc {
  /**
   * Override-map key AND bake identity. For new records this is a transient
   * session-local id (the real `BitmapMask.id` is minted by the add command);
   * it only has to be unique among the session's live entries.
   */
  maskId: string;
  existingMaskId: string | undefined;
  /** Existing record content source (undefined for a new record). */
  src: string | undefined;
  /** Record FAMILY (see `BitmapMask.inverted`). Fixed at record birth. */
  inverted: boolean;
  /** HARD edge flag — the record's own flag for existing records, the current AA toggle for new ones. */
  hard: boolean;
  /**
   * Whether the record has (or will receive) stamps. `false` marks a PRISTINE
   * new record: the erase op's hole-fill skips it until a restore stamp lands.
   */
  painted: boolean;
}

export interface MaskSessionParams {
  config: StrokeConfig;
  targetLayerId: string;
  frameId: string;
  localMatrixInverse: IMatrix3x3;
  localBrushSize: number;
  /**
   * Layer-local origin the mask canvases are anchored to (`LayerUtils.getMaskOrigin`).
   *
   * `localMatrixInverse` maps a canvas point into BOUNDING-local space, but the
   * mask canvases cover the layer-local rect `(origin.x, origin.y, bounding.w,
   * bounding.h)` — matching where `painter2d` actually blits the content. Stamps
   * therefore have to be translated by `-origin` before being written to the
   * mask canvases. `(0,0)` for regular full-layer images (no behaviour change).
   */
  maskOrigin: { x: number; y: number };
  /** Mask canvas dimensions (= target layer bounding). */
  maskW: number;
  maskH: number;
  /**
   * The PINNED target-record set, fixed for the whole stroke (Tab may switch
   * the op mid-stroke, but never the targets): the erase-family target, the
   * restore-family target, and every painted restore-family record (the erase
   * op's hole-fill set), deduped by maskId.
   */
  records: MaskSessionRecordDesc[];
  /** Which family the session's FIRST op routes to (craft at stroke start). */
  initialIsRestore: boolean;
}

// ─── Internal session record ───────────────────────────────────────────────────

interface SessionRecord extends MaskSessionRecordDesc {
  /** Scratch canvas — lazily materialized on first write (null = untouched). */
  canvas: OffscreenCanvas | null;
  ctx: OffscreenCanvasRenderingContext2D | null;
  /**
   * Per-record upload-dedup version. Bumped on EVERY content change of this
   * record (bootstrap async load, stamps) so the engine's upload dedup never
   * mistakes a redraw for "unchanged".
   */
  version: number;
}

// ─── MaskStrokeSession ─────────────────────────────────────────────────────────

export class MaskStrokeSession implements StrokeSession {
  readonly isMaskEdit = true;

  private placeholderCanvas: OffscreenCanvas;
  private records: SessionRecord[];
  private eraseEntry: SessionRecord;
  private restoreEntry: SessionRecord;
  private smoother: StrokeSmoother;
  private stamp: StampEngine;
  private lastDrawnPoint: Point2D | null = null;
  private lastPoint: Point2D | null = null;
  private pointCount = 0;
  /** Last raw-pointer tip-cap position, quantized to the mask texel grid (see `stampRawTipCap`). */
  private lastTipCapX: number | null = null;
  private lastTipCapY: number | null = null;
  private _version = 0;

  private localMatrixInverse: IMatrix3x3;
  private maskOrigin: { x: number; y: number };
  private config: StrokeConfig;

  private targetLayerId: string;
  private frameId: string;
  private maskW: number;
  private maskH: number;

  /** Tracks the current eraser/restore op (may toggle via Tab during stroke) */
  private currentIsRestore: boolean;

  /** Set once end() has produced the bake request — async bootstrap loads must not re-dispatch after it. */
  private ended = false;

  get previewCanvas(): OffscreenCanvas {
    return this.placeholderCanvas;
  }

  get version(): number {
    return this._version;
  }

  constructor(params: MaskSessionParams) {
    this.config = params.config;
    this.targetLayerId = params.targetLayerId;
    this.frameId = params.frameId;
    this.localMatrixInverse = params.localMatrixInverse;
    this.maskOrigin = params.maskOrigin;
    this.maskW = params.maskW;
    this.maskH = params.maskH;
    this.currentIsRestore = params.initialIsRestore;

    this.records = params.records.map(desc => ({
      ...desc,
      canvas: null,
      ctx: null,
      version: 0,
    }));
    // Both family targets are ALWAYS pinned (the op may flip mid-stroke via
    // Tab, so both routing targets must exist from the start — see factory).
    // The factory pins each family target FIRST, so the first erase-family
    // record is the erase target and the first restore-family record is the
    // restore target; hole-fill extras follow in `records` order. A defensive
    // synthetic pristine placeholder replaces a missing family target so the
    // op matrix always has both routing targets.
    const ensureFamilyTarget = (inverted: boolean): SessionRecord => {
      const found = this.records.find(r => r.inverted === inverted);
      if (found) return found;
      const synthetic: SessionRecord = {
        maskId: `mask-${inverted ? 'restore' : 'erase'}-placeholder`,
        existingMaskId: undefined,
        src: undefined,
        inverted,
        hard: this.config.hard,
        painted: false,
        canvas: null,
        ctx: null,
        version: 0,
      };
      this.records.push(synthetic);
      return synthetic;
    };
    this.eraseEntry = ensureFamilyTarget(false);
    this.restoreEntry = ensureFamilyTarget(true);

    // Placeholder canvas for StrokePreview interface (mask preview uses fast.override)
    this.placeholderCanvas = new OffscreenCanvas(1, 1);

    // Create pre-rendered stamp engine in local space (white color for mask, local brush size).
    // A HARD mask record is GPU-thresholded at 0.5 — the dab must be binary so
    // repeated dest-out stamps are IDEMPOTENT (see createDab on the multiplicative
    // ramp-growth pitfall). Soft/AA strokes keep the antialiased dab.
    this.stamp = new StampEngine(
      params.localBrushSize, params.config.hardness,
      '#FFFFFF', params.config.opacity, params.config.hard,
    );

    this.smoother = new StrokeSmoother();
  }

  /**
   * Materializes the session-start op's canvases and dispatches the initial
   * live preview. Called by the factory BEFORE the first `begin()` — begin
   * stamps immediately, so every canvas that op routes into must exist by then.
   *
   * - Session starts as ERASE: the erase target plus the whole hole-fill set
   *   (begin's dot both carves and hole-fills).
   * - Session starts as RESTORE: only the restore target (a restore op never
   *   hole-fills).
   */
  bootstrap(e: InteractionEvent): void {
    for (const entry of this.records) {
      if (this.isEagerTarget(entry)) this.materialize(entry, e);
    }
    this.dispatchPreview(e);
  }

  private isEagerTarget(entry: SessionRecord): boolean {
    if (entry === this.eraseEntry && !this.currentIsRestore) return true;
    if (entry === this.restoreEntry && this.currentIsRestore) return true;
    // Erase start also hole-fills: every painted restore record needs its canvas.
    if (!this.currentIsRestore && entry.inverted && entry.painted) return true;
    return false;
  }

  /**
   * Projects a canvas-space point into MASK-CANVAS space.
   *
   * Two steps, both mandatory:
   *   1. `localMatrixInverse` → bounding-local space (undoes camera + layer pose).
   *   2. `- maskOrigin`       → mask-canvas space.
   *
   * Step 2 exists because the mask canvas covers the layer-local rect
   * `(originX, originY, bounding.w, bounding.h)` rather than `(0, 0, ...)`.
   * That is the rect where `painter2d` actually blits the layer content
   * (`drawImage(src, v.x, v.y, v.w, v.h, v.x, v.y, v.w, v.h)`), so anchoring the
   * mask there is what makes `destination-in` overlap the content instead of
   * missing it entirely.
   *
   * For regular full-layer images `maskOrigin` is `(0, 0)`, making this
   * arithmetically identical to the previous plain `localMatrixInverse.apply()`.
   */
  private toMaskSpace(point: Point2D): Point2D {
    const local = this.localMatrixInverse.apply(point);
    return { x: local.x - this.maskOrigin.x, y: local.y - this.maskOrigin.y };
  }

  // ── OP MATRIX ────────────────────────────────────────────────────────────────
  //
  // The two-family combine (`vis = max( Π erase αᵢ , max_j (1 − α_restore_j) )`)
  // gives the restore family OR semantics — without a compensating write, any
  // restoration would permanently override ALL later erasing (the eraser would
  // "stop working"). The hole-fill is therefore HALF of the erase op, not an
  // optional add-on:
  //
  //   restore op → `destination-out` into the restore-family target ONLY
  //                (α↓ → its 1−α contribution rises → content comes back).
  //   erase op   → `destination-out` into the erase-family target (α↓ → vis↓)
  //                AND `source-over` white into EVERY PAINTED restore record
  //                (hole-fill: α↑ → 1−α↓ → previously restored areas hide
  //                again). Pristine (never-painted) restore records are
  //                SKIPPED — they are all-white, so filling them is a no-op
  //                that would only waste an epoch bump + upload.
  //
  // Known, accepted semantics: the hole-fill lands INSIDE the restore record,
  // so its edge hardness follows THAT RECORD's `hard` flag at GPU sample time
  // (the sampler thresholds the record's entire texture), never the eraser's
  // current AA toggle.
  private stampOps(isRestore: boolean, stamp: (ctx: OffscreenCanvasRenderingContext2D) => void): boolean {
    if (isRestore) {
      return this.stampInto(this.restoreEntry, 'destination-out', stamp);
    }
    let stamped = this.stampInto(this.eraseEntry, 'destination-out', stamp);
    for (const entry of this.records) {
      if (!entry.inverted || !entry.painted) continue;
      stamped = this.stampInto(entry, 'source-over', stamp) || stamped;
    }
    return stamped;
  }

  private stampInto(
    entry: SessionRecord,
    compositeOp: GlobalCompositeOperation,
    stamp: (ctx: OffscreenCanvasRenderingContext2D) => void,
  ): boolean {
    if (!entry.ctx) return false;
    entry.ctx.save();
    entry.ctx.globalCompositeOperation = compositeOp;
    stamp(entry.ctx);
    entry.ctx.restore();
    entry.painted = true;
    entry.version++;
    return true;
  }

  /**
   * Stamp the RAW pointer position as a tip cap — quantized to the mask TEXEL
   * grid, deduped against the previous cap.
   *
   * The quantization is the fix for "repeated clicks at the same spot keep
   * growing the hole": the OS pointer jitters by fractions of a pixel between
   * clicks (192.84 vs 192.65 …). Antialiased dabs at DIFFERENT subpixel
   * positions union in the alpha channel, and the GPU's hard-edge 0.5
   * threshold turns that union into a visibly larger hole on every click.
   * Quantized to the texel grid, the same resting spot always produces the
   * IDENTICAL dab — dest-out is saturating, so the hole converges after the
   * first click (Photoshop semantics: input is pixel-sampled at 100%).
   * The ≤0.5px quantization error is invisible under the brush cursor.
   *
   * Returns whether a dab actually landed (the caller decides whether the
   * canvas changed enough to dispatch). The dedup skip also avoids a
   * pointless version bump + texture re-DMA when the pointer rests or
   * micro-jitters inside one texel.
   */
  private stampRawTipCap(point: Point2D, e?: InteractionEvent): boolean {
    const localTip = this.toMaskSpace(point);
    const gx = Math.round(localTip.x);
    const gy = Math.round(localTip.y);
    if (gx === this.lastTipCapX && gy === this.lastTipCapY) return false;
    this.ensureOpContexts(this.currentIsRestore, e);
    const landed = this.stampOps(
      this.currentIsRestore,
      (ctx) => this.stamp.stampAt(ctx, gx, gy),
    );
    if (landed) {
      this.lastTipCapX = gx;
      this.lastTipCapY = gy;
    }
    return landed;
  }

  /**
   * Materializes every canvas the given op routes into that does not exist
   * yet (lazy creation keeps pure single-family strokes at one canvas).
   * `e` is only needed for the async-load re-dispatch — begin() has no event
   * and materializes without it.
   */
  private ensureOpContexts(isRestore: boolean, e?: InteractionEvent): void {
    if (isRestore) {
      this.materialize(this.restoreEntry, e);
      return;
    }
    this.materialize(this.eraseEntry, e);
    for (const entry of this.records) {
      if (entry.inverted && entry.painted) this.materialize(entry, e);
    }
  }

  /**
   * Creates the record's scratch canvas and loads its content.
   *
   * New records boot WHITE (fully visible α=1 — family-neutral, identical for
   * both families: erase family contributes α=1 to the product, restore family
   * contributes 1−α=0 to the max). Existing records load their baked content;
   * if the bitmap is not resident yet, an async fallback draws it in later
   * (destination-over, UNDER whatever was stamped meanwhile) and re-dispatches.
   */
  private materialize(entry: SessionRecord, e?: InteractionEvent): void {
    if (entry.canvas) return;
    try {
      const canvas = new OffscreenCanvas(this.maskW, this.maskH);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (!ctx) {
        console.warn('[EraserOverlay] Failed to get OffscreenCanvas 2D context for mask', entry.maskId);
        return;
      }
      entry.canvas = canvas;
      entry.ctx = ctx;
      entry.version = 0;

      if (!entry.existingMaskId || !entry.src) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, this.maskW, this.maskH);
        return;
      }

      const bmp = e?.pixels.image.ensureBitmap(entry.src);
      if (bmp) {
        ctx.drawImage(bmp, 0, 0, this.maskW, this.maskH);
      } else {
        loadImageBitmap(entry.src).then(bitmap => {
          if (entry.ctx) {
            entry.ctx.save();
            entry.ctx.globalCompositeOperation = 'destination-over';
            entry.ctx.drawImage(bitmap, 0, 0, this.maskW, this.maskH);
            entry.ctx.restore();
          }
          bitmap.close();
          // Distinct per-record version — the engine's upload dedup must see
          // this redraw even though an earlier dispatch already used version 0.
          entry.version++;
          // Re-dispatch the FULL live map (the channel replaces it wholesale) —
          // unless the stroke already ended and baked (a late dispatch here
          // would re-add a stale override on top of the just-committed state),
          // or the materialization came from begin() which has no event.
          if (e && !this.ended) this.dispatchPreview(e);
        }).catch(err => {
          console.warn('[EraserOverlay] Async mask load failed:', err);
        });
      }
    } catch (err) {
      console.warn('[EraserOverlay] OffscreenCanvas creation for mask failed:', err);
    }
  }

  /**
   * Builds the FULL live override map — every materialized record keyed by its
   * maskId. The channel replaces the map wholesale, so each dispatch must
   * carry every live record, touched or not (untouched records re-send their
   * unchanged version, which the engine's upload dedup drops for free).
   *
   * Every entry mirrors the exact fields the bake will persist (`bounds`,
   * `hard`, `inverted`) — the "preview == landing" contract.
   */
  private buildOverrideMap(): BitmapMaskOverrideMap {
    const map: BitmapMaskOverrideMap = {};
    for (const entry of this.records) {
      if (!entry.canvas) continue;
      map[entry.maskId] = {
        source: entry.canvas,
        bounds: this.maskOrigin,
        version: entry.version,
        hard: entry.hard,
        inverted: entry.inverted,
      };
    }
    return map;
  }

  private dispatchPreview(e: InteractionEvent): void {
    const map = this.buildOverrideMap();
    if (Object.keys(map).length === 0) return;
    this._version++;
    e.actions.fast.override(this.frameId, this.targetLayerId, {
      bitmapMaskOverride: map,
    }, 'layer');
  }

  begin(point: Point2D, _pressure: number): void {
    this.lastPoint = point;
    this.lastDrawnPoint = point;
    this.pointCount = 1;

    // Transform start point to mask-canvas coordinates
    const localPoint = this.toMaskSpace(point);

    // Initialize stamp position in mask-canvas space
    this.stamp.lastStampX = localPoint.x;
    this.stamp.lastStampY = localPoint.y;

    // Draw initial stamp dot through the op matrix. Materialize first: the
    // factory's bootstrap usually already did (eager path), but a directly
    // constructed session (and any future caller skipping bootstrap) still
    // needs its begin-op canvases to exist. Quantized tip cap — seeds
    // `lastTipCap` so resting micro-jitter after the click dedups against it.
    this.stampRawTipCap(point);

    // Initialize smoother
    this.smoother.begin(point);
  }

  move(point: Point2D, pressure: number, e: InteractionEvent): void {
    if (!this.lastPoint) return;

    const dx = point.x - this.lastPoint.x;
    const dy = point.y - this.lastPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Determine erase vs restore from current craft signal (toggled via Tab key)
    const craft = e.state.interaction.signals[ACTIVE_CRAFT_KEY] as string;
    this.currentIsRestore = craft === 'restore';

    // MICRO-MOVE TIP CAP — the pitfall this closes:
    // The `dist < 2` gate below exists to protect the SPACING path from
    // micro-move noise, but it used to early-return and silently DROP the
    // displacement: the pointer could travel up to 2px between qualifying
    // moves without any dab landing there. The visible trail tip therefore
    // lagged the cursor by up to 2px — with a small brush (size 4-7, radius
    // 2-3.5) that is half to ALL of the brush radius, which read as "the
    // trail tip is not erased"; end()'s final cap then stamped the release
    // point, making the gap vanish on pointerup ("preview ≠ landing").
    // Every pipeline stage (canvas, upload dedup, bmask combine, render,
    // cursor overlay) was probe-verified correct — the gap lived entirely in
    // this unlogged sub-gate interval. Fix: sub-gate moves STILL stamp a raw
    // pointer tip cap and dispatch. The spacing state (lastStamp/accDistance)
    // and the smoother window are deliberately untouched — `lastPoint` only
    // advances on qualifying moves so the spacing grid keeps accumulating
    // slow drags correctly (the stamp below is a saturating op, so the extra
    // density is invisible at full opacity).
    if (dist < 2) {
      if (this.stampRawTipCap(point, e)) this.dispatchPreview(e);
      return;
    }

    this.pointCount++;
    const smoothPoints = this.smoother.addPoint(point);

    // Lazy canvas creation for targets this op routes into that the session
    // start did not materialize (e.g. Tab flipped to the other family, or an
    // erase op reaching restore records skipped at bootstrap).
    this.ensureOpContexts(this.currentIsRestore, e);

    // Transform smooth points to mask-canvas space
    const localSmoothPoints = smoothPoints.map(p => this.toMaskSpace(p));

    let stamped = false;
    if (localSmoothPoints.length > 0) {
      stamped = this.stampOps(this.currentIsRestore, (ctx) => this.stamp.stampAlongPath(ctx, localSmoothPoints));
      this.lastDrawnPoint = smoothPoints[smoothPoints.length - 1];
    } else if (this.pointCount === 2) {
      const localNewPoint = this.toMaskSpace(point);
      stamped = this.stampOps(this.currentIsRestore, (ctx) => this.stamp.stampAlongPath(ctx, [localNewPoint]));
    }

    // TIP CAP: guarantee a dab centered at the RAW pointer position on every
    // qualifying move. Two lag sources would otherwise leave the visible trail
    // tip short of the cursor circle: the Catmull-Rom window only emits the
    // segment up to the SECOND-TO-LAST raw sample, and the spacing loop holds
    // back tails shorter than one stamp spacing. BrushOverlay's GPU ribbon
    // never lags because it extrudes raw samples directly — this cap gives
    // the dab engine the same guarantee. The position is texel-quantized and
    // deduped (see `stampRawTipCap`): the extra dab is a saturating op
    // (dest-out carve / source-over white hole-fill), so the density bump is
    // invisible at full opacity, and the spacing state is deliberately
    // untouched (the cap is coverage insurance, not a spacing-grid stamp).
    // Dispatch only when THIS move actually changed a canvas — the cap dedup
    // makes resting/micro-jittering pointers dispatch-free.
    const capLanded = this.stampRawTipCap(point, e);
    if (stamped || capLanded) this.dispatchPreview(e);

    this.lastPoint = point;
  }

  async end(_frame: Frame, upPoint?: Point2D, e?: InteractionEvent): Promise<BakeRequest | null> {
    // Flush trailing segment from smoother
    if (this.lastDrawnPoint) {
      const finalSegment = this.smoother.finish();
      if (finalSegment.length > 0) {
        const localFinalSegment = finalSegment.map(p => this.toMaskSpace(p));
        this.stampOps(this.currentIsRestore, (ctx) => this.stamp.stampAlongPath(ctx, localFinalSegment));
      }
    }

    // FINAL CAP: the stroke must end exactly where the pointer was released
    // (BrushOverlay parity — "the final sample always lands"). The pointerup
    // position can differ from the last move sample (micro-moves); the
    // texel-quantized cap dedups it against the last tip cap, so releasing
    // without further movement is a no-op (identical hole on repeated clicks).
    if (upPoint) this.stampRawTipCap(upPoint, e);

    // FINAL PREVIEW DISPATCH: the trailing smoother segment and the final cap
    // above land AFTER the last move's dispatch, so the live preview would
    // otherwise end short of the baked result — the first recomposite after
    // the bake (pan, next edit) visibly changed the trail tail. The bake below
    // commits the exact same pixels (lossless WebP), so dispatching the final
    // map here closes the preview == landing contract end-to-end. For a CLICK
    // stroke (no moves) this is ALSO the only dispatch that ever carries the
    // dot — begin() stamps after the bootstrap dispatch.
    if (e) this.dispatchPreview(e);

    // Encode EVERY painted record's canvas — the erase record AND each
    // hole-filled restore record. They must all land (one undoable batch, see
    // bake.ts) or undo/redo would tear the "erase and hole-fill move together"
    // invariant apart.
    const records: MaskBakeRecord[] = [];
    for (const entry of this.records) {
      if (!entry.canvas || !entry.painted) continue;
      const blob = await entry.canvas.convertToBlob({ type: 'image/webp', quality: 1.0 });
      records.push({
        blob,
        maskId: entry.maskId,
        inverted: entry.inverted,
        hard: entry.hard,
      });
    }
    if (records.length === 0) return null;

    // From here on, late async bootstrap loads must not re-dispatch a stale
    // override on top of the state the bake is about to commit.
    this.ended = true;

    const request: MaskBakeRequest = {
      type: 'mask',
      targetLayerId: this.targetLayerId,
      records,
      maskBounds: {
        // Origin is carried through so the persisted BitmapMask.bounds matches
        // the basis used by the stamps above AND by the live preview override.
        x: this.maskOrigin.x,
        y: this.maskOrigin.y,
        w: this.maskW,
        h: this.maskH,
      },
    };

    return request;
  }
}

/**
 * Loads image as ImageBitmap via URL.
 */
async function loadImageBitmap(src: string): Promise<ImageBitmap> {
  const response = await fetch(src);
  const blob = await response.blob();
  return createImageBitmap(blob);
}
