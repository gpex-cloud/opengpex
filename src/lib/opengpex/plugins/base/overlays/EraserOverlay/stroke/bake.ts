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
 * Mask Bake Pipeline
 *
 * Commits a completed eraser/restore stroke into non-destructive bitmap masks:
 * register encoded blobs → apply ALL touched records as ONE undoable batch
 * (the erase record + every hole-filled restore record) → clear the
 * live-preview override. Runs entirely through the core `adv.layer.bitmapMask`
 * actions; no custom command and no Worker are involved.
 */

import { flushSync } from 'react-dom';
import type { InteractionEvent } from '@opengpex/editor/core/types';
import { asLocalRect } from '@opengpex/editor/core/types';
import type { BakeRequest, MaskBakeRequest } from './types';

// ─── Main Entry ────────────────────────────────────────────────────────────────

/**
 * Executes the bake process for a completed mask stroke.
 */
export async function executeBake(request: BakeRequest, e: InteractionEvent): Promise<void> {
  await executeMaskBake(request, e);
}

// ─── Mask Bake ─────────────────────────────────────────────────────────────────

async function executeMaskBake(request: MaskBakeRequest, e: InteractionEvent): Promise<void> {
  const { records, targetLayerId, maskBounds } = request;
  const frame = e.activeFrame;

  try {
    // Register every record's blob as an asset (parallel — independent uploads)
    const assets = await Promise.all(records.map(async (rec) => {
      const asset = await e.assets.register(rec.blob, { width: maskBounds.w, height: maskBounds.h });
      // Pre-warm the decode cache for the baked mask asset
      await e.pixels.image.cacheBitmap(asset.url, rec.blob);
      return asset;
    }));

    // Commit ALL record writes through ONE undoable batch command, synchronously.
    //
    // An erase stroke touches several records at once (the erase-family record
    // update + a white hole-fill into every painted restore-family record).
    // Those writes are one logical edit: separate undoable commands would let
    // undo/redo tear apart the "erase and hole-fill move together" invariant,
    // so they land as a single batch (single pre-execution SIGNAL_COMMIT →
    // one undo step restores every touched record).
    //
    // `execute` is a synchronous void command, so awaiting it would be a no-op;
    // flushSync forces the commit before the next stroke reads bitmapMasks.
    flushSync(() => {
      e.actions.adv.layer.bitmapMask.applyBatch.execute({
        frameId: frame.id,
        layerId: targetLayerId,
        ops: records.map((rec, i) => ({
          // Single APPLY semantic: the batch command routes on its own
          // membership lookup — an id present in layer.bitmapMasks is rewritten
          // in place, an absent one (the session's transient `mask-*-erase` /
          // `mask-*-restore`) is created and ADOPTED, which re-keys the live
          // preview's resident GPU texture under the bake instead of orphaning
          // it, and makes undo/redo re-executions id-stable.
          kind: 'apply' as const,
          maskId: rec.maskId,
          src: assets[i].url,
          assetId: assets[i].assetId,
          bounds: asLocalRect({
            x: maskBounds.x, y: maskBounds.y, w: maskBounds.w, h: maskBounds.h,
          }),
          // Rides both routes so an edited mask always re-syncs to the
          // panel's AA toggle (`false` clears a stale hard:true via the batch
          // command's patch spread).
          hard: rec.hard,
          // Family is only WRITTEN when the op creates the record (a record's
          // family is fixed at birth — restore records are born
          // `inverted: true`); an in-place rewrite ignores it.
          inverted: rec.inverted,
          painted: true,
        })),
      });
    });
  } finally {
    // Commit the fast-track override (clear live preview)
    e.actions.fast.commit(targetLayerId, 'layer');
  }
}
