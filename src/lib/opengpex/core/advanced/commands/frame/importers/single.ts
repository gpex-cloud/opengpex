/**
 * OpenGPEX - An Open-source, Web-based Graphics and Photo editor.
 * Copyright (C) 2026 The OpenGPEX Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * Single Image Import Strategy.
 *
 * Architecture:
 *   - `importSingleImage` — Full pipeline: decode → asset registration →
 *     thumbnail → new frame → addFrame.
 *   - `revertSingleImage` — Lighter counterpart for `revertFrame` (in-place
 *     rebuild): same base-layer assembly, but skips thumbnail generation
 *     since a revert never changes it; commits via updateFrame instead of
 *     addFrame and reports success/failure as a boolean.
 */

'use client';

import { asLocalShape, EditorContextValue } from '@opengpex/editor/core/types';
import { getDefaultCanvasClipBox } from '@opengpex/editor/core/helpers/selection';
import { newFrameId } from '../_naming';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';
import { transcodeBlob } from '@opengpex/editor/core/engine/utils/pixel-utils';

// ═══════════════════════════════════════════════════════════════════════════════
// importSingleImage — Creates a new frame and adds to store
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Import a single image as a new frame with one layer.
 *
 * @param ctx - Editor context
 * @param file - Resolved source file (frame naming)
 * @param decoded - Decode result from FileService: { metadata, pages, sourceBlob }
 * @param opts - Import options, with `dpi` already finalized
 * @returns Frame ID of the created frame.
 */
export async function importSingleImage(
  ctx: EditorContextValue,
  file: File,
  decoded: DecodeResult,
  opts: ImportOptions,
): Promise<{ frameId: string; thumbnailUrl: string }> {
  const { actions, assets, pixels, state, geometry } = ctx;
  const { switchFrame, parentId, seqNum, nameOverride, extra } = opts;
  const { metadata, sourceBlob, pages } = decoded;

  // Single-image path: exactly one page (multi-page/animated routes through
  // multi-tiff.ts / multi-gif.ts before this function is ever reached).
  const page = pages[0];

  // 1. Ingest: register display asset + store raw source + warm high-depth
  // cache if the page carries pre-decoded naked pixels (TIFF/PNG/RAW). See
  // `AssetService.storeBundle` for the full rationale. `bundle.url` is always
  // the 8-bit display URL (fallback bitmap for a cold high-depth cache);
  // `bundle.assetId` is the page's unified content address — `${sourceHash}#${pageIndex}`
  // when a source file exists (light record + `dec:` under this id, `raw:` under
  // its `#` prefix), else the display asset hash. The base layer composites from
  // this single id, whichever richness it resolves to (banded 8-bit display blob
  // was never acceptable post-adjust).
  const bundle = await assets.storeBundle(page, sourceBlob);

  // 2. Concurrently: decode content bounds + generate thumbnail
  const [contentBounds, thumbResult] = await Promise.all([
    pixels.image.contentBounds(bundle.url),
    pixels.image.resample(bundle.url, { maxSize: 256 }),
  ]);
  const thumbBlob = await transcodeBlob(thumbResult.displayBlob, 'image/webp');

  // 3. Register thumbnail asset (dimensions from resample output)
  const { assetId: thumbAssetId, url: thumbAssetUrl } = await assets.register(thumbBlob, { width: thumbResult.width, height: thumbResult.height });

  // 4. Camera calculation
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim,
    { w: page.width, h: page.height },
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );
  const canvasClipBox = getDefaultCanvasClipBox({ w: page.width, h: page.height });

  // 5. Assemble base layer
  const baseLayer = LayerFactory.getNewLayer({
    name: 'Background',
    src: bundle.url,
    assetId: bundle.assetId,
    cx: 0,
    cy: 0,
    locked: true,
    bounding: { w: page.width, h: page.height },
    visibleShape: asLocalShape(contentBounds),
  });

  const expandedLayers = LayerFactory.expandLayers([baseLayer]);

  // Assemble and add the frame
  const frameName = file.name.replace(/\.[^.]+$/, '');
  const frame = LayerFactory.getNewFrame({
    id: newFrameId(!!parentId),
    parentId,
    seqNum,
    name: nameOverride || frameName || file.name,
    source: file.name,
    extra,
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: baseLayer.id,
    canvas: { w: page.width, h: page.height },
    camera,
    canvasClipBox,
    assetId: bundle.assetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    dpi: opts.dpi || metadata.dpi,
    metadata,
  });

  actions.addFrame(frame, switchFrame);
  return { frameId: frame.id, thumbnailUrl: thumbAssetUrl };
}

// ═══════════════════════════════════════════════════════════════════════════════
// revertSingleImage — Rebuilds an existing frame in-place and commits via updateFrame
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Rebuild `frameId`'s layers/camera/metadata from re-decoded original bytes and
 * commit in-place — the revert counterpart to `importSingleImage` (which commits
 * via `addFrame`; this commits via `updateFrame`). A revert re-decodes the same
 * original bytes, so frame.assetId/thumbnail/dpi never change and don't need
 * recomputing. Duplicates the base-layer assembly from `importSingleImage`
 * (asset registration, high-depth cache warm — see that function for the
 * rationale) minus the thumbnail generation that only a new frame needs.
 *
 * @returns true if reverted successfully, false otherwise.
 */
export async function revertSingleImage(
  ctx: EditorContextValue,
  frameId: string,
  decoded: DecodeResult,
): Promise<boolean> {
  const { actions, assets, pixels, state, geometry } = ctx;
  try {
    const { sourceBlob, pages, metadata } = decoded;
    const page = pages[0];

    // 1. Ingest: register display asset + store raw source + warm high-depth
    // cache (see importSingleImage / AssetService.storeBundle for rationale).
    const bundle = await assets.storeBundle(page, sourceBlob);

    // 2. Decode content bounds (no thumbnail — revert never changes it)
    const contentBounds = await pixels.image.contentBounds(bundle.url);

    // 3. Camera calculation
    const { insets } = state.ui.theme.config;
    const camera = geometry.camera.getFitCamera(
      state.ui.viewportDim,
      { w: page.width, h: page.height },
      { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
    );
    const canvasClipBox = getDefaultCanvasClipBox({ w: page.width, h: page.height });

    // 4. Assemble base layer
    const baseLayer = LayerFactory.getNewLayer({
      name: 'Background',
      src: bundle.url,
      assetId: bundle.assetId,
      cx: 0,
      cy: 0,
      locked: true,
      bounding: { w: page.width, h: page.height },
      visibleShape: asLocalShape(contentBounds),
    });
    const expandedLayers = LayerFactory.expandLayers([baseLayer]);

    // 5. Commit in-place (updateFrame, not addFrame) + reset history
    actions.updateFrame(frameId, {
      layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
      activeLayerId: baseLayer.id,
      canvas: { w: page.width, h: page.height },
      camera,
      canvasClipBox,
      metadata,
      clipBoxes: {},
    });
    actions.resetHistory();
    actions.setInteraction({ hud: { message: 'Reverted to original — all edits discarded.', type: 'success' } });
    return true;
  } catch (err) {
    console.error('[FrameService] Standard revert failed:', err);
    actions.setInteraction({ hud: { message: 'Failed to revert. Original asset may be missing.', type: 'error' } });
    return false;
  }
}
