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
 * Commits a completed eraser/restore stroke into a non-destructive bitmap mask:
 * register encoded blob → update/add bitmap mask → clear the live-preview
 * override. Runs entirely through the core `adv.layer.bitmapMask` actions; no
 * custom command and no Worker are involved.
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
  const { blob, targetLayerId, existingMaskId, maskBounds } = request;
  const frame = e.activeFrame;

  try {
    // Register mask blob as asset
    const asset = await e.assets.register(blob, { width: maskBounds.w, height: maskBounds.h });

    // Pre-warm the decode cache for the baked mask asset
    await e.pixels.image.cacheBitmap(asset.url, blob);

    // Force a SYNCHRONOUS commit of the bitmap-mask dispatch so the next stroke
    // reads the just-baked bitmapMasks (not the pre-bake empty array). Scoped to
    // THIS bake path only. `execute` is a synchronous void command, so awaiting
    // it would be a no-op.
    if (existingMaskId) {
      flushSync(() => {
        e.actions.adv.layer.bitmapMask.update.execute({
          frameId: frame.id,
          layerId: targetLayerId,
          maskId: existingMaskId,
          patch: {
            src: asset.url,
            assetId: asset.assetId,
            // Re-assert bounds: an older mask may have been persisted before the
            // fragment origin fix (bounds.x/y === 0). Rewriting it keeps the reused
            // mask on the same basis the stamps were just drawn in.
            bounds: asLocalRect({
              x: maskBounds.x, y: maskBounds.y, w: maskBounds.w, h: maskBounds.h,
            }),
          },
        });
      });
    } else {
      flushSync(() => {
        e.actions.adv.layer.bitmapMask.add.execute({
          frameId: frame.id,
          layerId: targetLayerId,
          src: asset.url,
          assetId: asset.assetId,
          bounds: asLocalRect({
            x: maskBounds.x, y: maskBounds.y, w: maskBounds.w, h: maskBounds.h,
          }),
        });
      });
    }
  } finally {
    // Commit the fast-track override (clear live preview)
    e.actions.fast.commit(targetLayerId, 'layer');
  }
}
