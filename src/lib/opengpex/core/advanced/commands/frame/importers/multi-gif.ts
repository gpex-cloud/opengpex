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
 * Animated GIF Import Strategy.
 *
 * Architecture:
 *   - `buildGifFrameContent` — Pure content builder (layers, camera, frame count dialog).
 *     Shared by both importAnimatedGif (new frame) and revertGifFrame (in-place rebuild).
 *   - `importAnimatedGif` — Creates a new GIF frame and adds it to the store.
 */

'use client';

import { asLocalShape, Layer, EditorContextValue, NormalizedState, CameraState, LocalShape, Dimensions } from '@opengpex/editor/core/types';
import type { ImageMetadata } from '@opengpex/editor/core/files/types';
import { getDefaultCanvasClipBox } from '@opengpex/editor/core/helpers/selection';
import { createFrameThumbnail } from '@opengpex/editor/core/helpers/thumbnail';
import { LayerFactory } from '@opengpex/editor/core/layer';
import { presets } from '@opengpex/editor/core/helpers/preferences';
const VIEWPORT_FIT_PADDING = presets.get('VIEWPORT_FIT_PADDING');
import type { DecodeResult } from '@opengpex/editor/core/files/types';
import type { ImportOptions } from './_types';

// ═══════════════════════════════════════════════════════════════════════════════
// buildGifFrameContent — Pure GIF content builder (shared by import + revert)
// ═══════════════════════════════════════════════════════════════════════════════

/** Output of buildGifFrameContent — everything needed to create or update a GIF frame. */
export interface GifFrameContent {
  layers: NormalizedState<Layer>;
  activeLayerId: string;
  canvas: Dimensions;
  camera: CameraState;
  canvasClipBox: LocalShape;
  /**
   * Asset id of the FIRST frame's registered StoredAsset (`${fileHash}#0`).
   * The owning Frame points its `assetId` here — not at the naked `raw:` file
   * hash — so every "document root asset" consumer (`assets.get(frame.assetId)`
   * for egest gamut/bit-depth arbitration, export source lookup, GC protection,
   * and the E2E StoredAsset readiness contract) resolves a real light record,
   * exactly as single.ts/multi-tiff.ts trunks do. The raw blob itself stays
   * reachable for revert: `getRaw` strips the `#index` suffix before lookup.
   */
  rootAssetId: string;
  gifSequenceId: string;
  gifFrameCount: number;
  metadata?: ImageMetadata;
}

/**
 * Builds GIF frame content from a decoded GIF — frame selection dialog, layers, camera.
 *
 * Shared by both `importAnimatedGif` (new frame) and `revertGifFrame` (in-place rebuild).
 * Includes the frame count selection dialog (user interactive).
 * Returns null if user cancelled the dialog.
 */
export async function buildGifFrameContent(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  /**
   * The original GIF's `raw:` hash, used to mint per-frame asset ids of the
   * SAME shape `single.ts`/`multi-tiff.ts` produce via storeBundle
   * (`${fileHash}#${index}`). Pass `undefined` to let `register` self-hash each
   * frame blob (pre-change behaviour) — callers that have no original file hash.
   */
  fileHash: string | undefined,
): Promise<GifFrameContent | null> {
  const { assets, actions, state, geometry } = ctx;
  const { metadata, pages } = decoded;

  let framesToImport = pages;
  const totalFrames = framesToImport.length;
  const GIF_DEFAULT_LIMIT = 30;

  // Frame count selection dialog (user can cancel → returns null)
  if (totalFrames > GIF_DEFAULT_LIMIT) {
    const targetCounts = [10, 20, 30, 60, 100].filter(n => n < totalFrames);
    const limitOptions = targetCounts.map(target => {
      const step = Math.ceil(totalFrames / target);
      let actualCount = 0;
      for (let i = 0; i < totalFrames; i += step) actualCount++;
      return { id: String(step), label: `${actualCount} frames`, description: `Keep 1 of every ${step} frames` };
    }).filter((opt, idx, arr) => idx === 0 || opt.label !== arr[idx - 1].label);

    limitOptions.push({ id: '1', label: `All ${totalFrames} frames`, description: 'May use significant memory' });

    const choiceResult = await actions.askChoice(
      `GIF has ${totalFrames} frames`,
      limitOptions,
      `This animated GIF contains ${totalFrames} frames. Importing all frames may use significant memory. Choose a frame limit for decimation.`,
      {
        label: 'Preserve Frame Rate',
        description: 'Keep original playback fps (overall duration will be shortened)',
        defaultValue: true,
      },
    );
    if (!choiceResult) return null; // User cancelled

    const chosenStep = typeof choiceResult === 'string' ? choiceResult : choiceResult.id;
    const keepFps = typeof choiceResult === 'object' && choiceResult ? !!choiceResult.switchValue : false;

    const step = parseInt(chosenStep, 10) || 1;
    if (step > 1) {
      const sampled: typeof framesToImport = [];
      for (let i = 0; i < totalFrames; i += step) {
        const si = framesToImport[i];
        const delay = keepFps ? (si.delay || 100) : (si.delay || 100) * step;
        // Keep the ORIGINAL source index in `index` — do NOT renumber to the
        // sampled slot. The per-frame asset id mints as `${fileHash}#${index}`,
        // whose contract is "frame `index` of this source file": the same id
        // must resolve to the same frame regardless of which decimation choice
        // produced it, or content-addressed dedupe in `register` silently
        // returns a DIFFERENT frame for that slot (previously: renumbered ids
        // collided with an earlier import's records, so a decimated re-import
        // rendered the old import's first-N consecutive frames).
        sampled.push({ ...si, delay });
      }
      framesToImport = sampled;
      actions.notifyHUD(
        `Decimated: ${totalFrames} → ${sampled.length} frames (step=${step}${keepFps ? ', preserve fps' : ''})`,
        'info',
      );
    }
  }

  // Register frame assets + build layers.
  // Canvas size is the GIF's logical screen — established by the first page.
  const canvasDim: Dimensions = { w: pages[0].width, h: pages[0].height };
  const gifSequenceId = `gif-seq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const frameAssets = await Promise.all(
    framesToImport.map(async (f) => {
      const { assetId, url: assetUrl } = await assets.register({
        displayBlob: f.displayBlob,
        width: f.width,
        height: f.height,
        colorIdentity: f.colorIdentity,
        precomputedHash: fileHash ? `${fileHash}#${f.index}` : undefined,
      });
      return { assetId, assetUrl, delay: f.delay || 100, index: f.index, width: f.width, height: f.height, contentBounds: f.contentBounds };
    }),
  );

  const frameLayers: Layer[] = frameAssets.map((fa, i) => LayerFactory.createLayer('image', {
    name: `Frame ${i + 1}`,
    src: fa.assetUrl,
    assetId: fa.assetId,
    cx: 0, cy: 0,
    locked: false,
    visible: i === 0,
    bounding: { w: fa.width, h: fa.height },
    // Crop window = the frame's own opaque-content bbox (decode precomputes it
    // per page). The window stays in source-canvas coordinates and is NOT
    // re-based: the layer's local space remains the full logical canvas, so
    // the cropped region renders exactly where it always did — the transparent
    // margins it excludes contribute nothing to compositing. What it changes:
    // the LayersDrawer tile (object-view-box against source dims) shows the
    // frame's content filling the square instead of a mostly transparent
    // checkerboard when content sits in one corner.
    visibleShape: asLocalShape(fa.contentBounds ?? { x: 0, y: 0, w: fa.width, h: fa.height }),
    metadata: {
      gifSequenceId,
      gifFrameIndex: i, gifFrameDelay: fa.delay, gifTotalFrames: framesToImport.length,
    },
  }));

  const expandedLayers = frameLayers.flatMap(l => LayerFactory.expandLayers([l]));

  // Camera calculation
  const { insets } = state.ui.theme.config;
  const camera = geometry.camera.getFitCamera(
    state.ui.viewportDim, canvasDim,
    { padding: VIEWPORT_FIT_PADDING, maxScale: 1, offsetTop: insets.top, offsetLeft: insets.fixed.left, offsetRight: insets.fixed.right },
  );

  return {
    layers: { byId: Object.fromEntries(expandedLayers.map(l => [l.id, l])), order: expandedLayers.map(l => l.id) },
    activeLayerId: frameLayers[0].id,
    canvas: canvasDim,
    camera,
    canvasClipBox: getDefaultCanvasClipBox(canvasDim),
    rootAssetId: frameAssets[0].assetId,
    gifSequenceId,
    gifFrameCount: framesToImport.length,
    metadata,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// importAnimatedGif — Creates new frame from GIF (uses buildGifFrameContent)
// ═══════════════════════════════════════════════════════════════════════════════

export async function importAnimatedGif(
  ctx: EditorContextValue,
  decoded: DecodeResult,
  file: File,
  opts: ImportOptions,
): Promise<string> {
  const { assets, pixels, actions } = ctx;
  const { switchFrame, extra } = opts;

  // 1. Store original GIF file as raw source (for future revert) — done first so
  //    buildGifFrameContent can mint per-frame asset ids of the same shape
  //    (`${fileHash}#${index}`) single.ts/multi-tiff.ts produce via storeBundle.
  //    The raw hash stays the `raw:` key; it is NOT used as frame.assetId (see
  //    rootAssetId below — the frame points at the first frame's StoredAsset).
  const rawFileHash = await assets.storeRaw(file);

  // 2. Build GIF content (includes frame count dialog)
  const content = await buildGifFrameContent(ctx, decoded, rawFileHash);
  if (!content) return ''; // User cancelled

  // 3. Generate thumbnail via the shared frame-thumbnail authority. GIF frames
  // composite over the full logical canvas, so the first frame's content can
  // sit in one small region — the decode-precomputed `contentBounds` crop
  // keeps the thumbnail showing actual content instead of a mostly
  // transparent checkerboard. The first kept frame is always `pages[0]`
  // (decimation sampling starts at index 0), so the page's bounds match the
  // first layer's asset coordinates.
  const firstLayerId = content.layers.order[0];
  const firstLayer = content.layers.byId[firstLayerId];
  const firstPage = decoded.pages[0];
  const { assetId: thumbAssetId, src: thumbAssetUrl } = await createFrameThumbnail(
    { pixels, assets },
    { url: firstLayer.src, width: firstPage.width, height: firstPage.height },
    { rect: firstPage.contentBounds },
  );

  // 4. Assemble and add frame
  const frameName = file.name.replace(/\.[^.]+$/, '');
  const frame = LayerFactory.getNewFrame({
    id: `f-${Date.now().toString(36)}-trunk`,
    name: frameName || file.name,
    source: file.name,
    canvas: content.canvas,
    dpi: decoded.metadata.dpi,
    layers: content.layers,
    activeLayerId: content.activeLayerId,
    camera: content.camera,
    canvasClipBox: content.canvasClipBox,
    assetId: content.rootAssetId,
    thumbnail: { src: thumbAssetUrl, assetId: thumbAssetId },
    extra: { ...extra, gifSequenceId: content.gifSequenceId, gifFrameCount: content.gifFrameCount },
    metadata: content.metadata,
  });

  actions.addFrame(frame, switchFrame);
  actions.notifyHUD(`Imported GIF: ${content.gifFrameCount} frames as layer sequence`, 'success');
  return frame.id;
}
