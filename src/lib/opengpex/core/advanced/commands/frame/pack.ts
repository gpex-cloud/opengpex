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

'use client';

import { EditorCommand, EditorContextValue, Frame } from '@opengpex/editor/core/types';
import type { FrameExportResult, FrameUnpackPayload } from '@opengpex/editor/core/types';
import * as P from '@opengpex/editor/core/advanced/protocols';
import { sanitizeFrame } from '@opengpex/editor/core/helpers/migrator/v1t2';

/**
 * FRAME_PACK_COMMANDS: Handles artboard (Frame) serialization/dehydration (pack)
 * and deserialization/hydration (unpack) for .gpex container exchange.
 */
export const FramePackCommands = {
  pack: {
    id: P.ADV_GPEX_PACK,
    name: 'Pack Frame GPEX',
    execute: async (ctx: EditorContextValue, frame: Frame): Promise<FrameExportResult> => {
      const { storage } = ctx;
      return storage.export(frame);
    },
  } as EditorCommand<Frame, Promise<FrameExportResult>>,

  unpack: {
    id: P.ADV_GPEX_UNPACK,
    name: 'Unpack Frame GPEX',
    /**
     * Hydration, NOT ingest. Every asset in the container already went through
     * `resolveIngestDecision` when the user first imported or baked it, and the
     * manifest carries the authoritative result. So we never re-rasterize here:
     * the old `createImageBitmap(blob)` loop threw away the colour identity
     * (everything came back 8-bit sRGB), threw away the asset id (re-hashing
     * broke `${fileHash}#${page}` addressing into white frames), and simply
     * crashed on any container holding a RAW/TIFF source file.
     *
     * Instead each asset is restored along the one path that is lossless for
     * its provenance (§4.1):
     *   ② source file present  → `storeRaw` + light record with `dataFormat`,
     *                            high-depth pixels rebuilt lazily by `recover()`;
     *   ③ bake product         → `storeBundle` with the shipped `dec:` pixels,
     *                            which are the only truth that exists for it;
     *   ① plain 8-bit          → `register` with the manifest geometry.
     */
    execute: async (ctx: EditorContextValue, payload: FrameUnpackPayload): Promise<Frame> => {
      const { assets, storage, actions } = ctx;
      const {
        state,
        assetBlobs,
        rawBlobs = {},
        decBuffers = {},
        manifest,
        replaceId,
        switchFrame = true,
      } = payload;

      // 1. Inject all assets into AssetService, category by category
      for (const [id, blob] of Object.entries(assetBlobs)) {
        const meta = manifest?.assets[id];
        const identity = meta?.colorIdentity;

        if (meta?.rawFileHash && rawBlobs[meta.rawFileHash]) {
          // ② Imported with a retained source file. `storeRaw` self-hashes, so
          // it lands back under the exact same `raw:${fileHash}` key and is
          // idempotent across the pages that share it. We declare `dataFormat`
          // WITHOUT writing `dec:` — the source file is authoritative and
          // `FileService.recover()` re-derives the pixels on first render.
          await assets.storeRaw(rawBlobs[meta.rawFileHash]);
          await assets.register(blob, {
            precomputedHash: id,
            width: meta.width,
            height: meta.height,
            dprScale: meta.dprScale,
            sourceFileName: meta.sourceFileName,
            ...identity,
          });
        } else if (meta?.bakedDecOnly && decBuffers[id] && identity) {
          // ③ Bake product (merge / rasterize / peel / create). No source file
          // can regenerate it, so the shipped naked pixels go straight back to
          // `dec:` — `storeBundle` keeps the §6.4 write ordering (dec first,
          // light record after) and warms HighDepthTextureCache.
          await assets.storeBundle({
            displayBlob: blob,
            width: meta.width,
            height: meta.height,
            dprScale: meta.dprScale,
            colorIdentity: identity,
            highDepthSource: { data: decBuffers[id], width: meta.width, height: meta.height },
            precomputedHash: id,
            sourceFileName: meta.sourceFileName,
          });
        } else {
          // ① Plain 8-bit — and the legacy-container fallback (§4.4): a .gpex
          // written before `assets-manifest.json` existed has no meta at all.
          // Such containers never carried raw:/dec: either, so 8-bit is their
          // own historical ceiling, not a loss introduced here.
          let width = meta?.width ?? 0;
          let height = meta?.height ?? 0;
          if ((width <= 0 || height <= 0) && typeof createImageBitmap === 'function') {
            try {
              const bmp = await createImageBitmap(blob);
              width = bmp.width;
              height = bmp.height;
              bmp.close();
            } catch {
              // Ignore failure (e.g. non-decodable format)
            }
          }

          await assets.register(blob, {
            precomputedHash: id, // ★ pin the original assetId — never re-hash
            width,
            height,
            dprScale: meta?.dprScale,
            sourceFileName: meta?.sourceFileName,
            ...identity,
          });
        }
      }

      // 2. Hydrate/restore artboard (sanitizing legacy v1 colors & fields if needed)
      const cleanState = state && typeof state === 'object' ? sanitizeFrame(state as Record<string, unknown>) : state;
      const frame = storage.import(cleanState);

      // 3. Add to store (supports add or overwrite mode)
      if (replaceId) {
        actions.resetHistory();
        actions.replaceFrame(replaceId, frame);
      } else {
        actions.addFrame(frame, switchFrame);
      }
      return frame;
    },
  } as EditorCommand<FrameUnpackPayload, Promise<Frame>>,
};
