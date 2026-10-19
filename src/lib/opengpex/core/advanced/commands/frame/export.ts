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

'use client';

import { EditorCommand, EditorContextValue } from '@opengpex/editor/core/types';
import type {
  FrameExportEncodeConfig,
  FrameExportEncodePayload,
  FrameExportEncodeResult,
} from '@opengpex/editor/core/types';
import { resolveEgestDecision, mimeToFormat } from '@opengpex/editor/core/files';
import type { EncodeOptions } from '@opengpex/editor/core/files';
import { buildGainMapEncodeSource, assembleUltraHdr } from '@opengpex/editor/core/files/handlers/jpeg/ultrahdr';
import * as P from '@opengpex/editor/core/advanced/protocols';

/**
 * The encode command's contract lives in `core/types/services.ts` — the layer
 * below this one, so `types/actions.ts` and `useEditorStore.ts` can name it
 * without importing upwards into the command implementation. Re-exported here
 * so existing `from '.../commands/frame/export'` imports keep working.
 */
export type { FrameExportEncodeConfig, FrameExportEncodePayload, FrameExportEncodeResult };

/**
 * FRAME_EXPORT_COMMANDS: unified export-to-file LOGIC (decision + GPU
 * render + encode → Blob). Does NOT trigger the browser download — that
 * stays the caller's job (ImageInfoDrawer/commands.ts's `download` command),
 * mirroring `ExportDispatcher`'s own boundary (readback + encode only).
 */
export const FrameExportCommands = {
  encode: {
    id: P.ADV_FRAME_EXPORT_ENCODE,
    name: 'Export Frame to File',
    undoable: false,
    execute: async (ctx: EditorContextValue, payload: FrameExportEncodePayload): Promise<FrameExportEncodeResult> => {
      const { activeFrame, pixels, files, assets } = ctx;
      if (!activeFrame) throw new Error('No active frame to export');

      const { exportWidth, exportHeight, region, config } = payload;
      const dpi = config.dpi || activeFrame.dpi || 72;
      const layerMeta = activeFrame.metadata;
      const baseW = region ? region.w : activeFrame.canvas.w;
      const baseH = region ? region.h : activeFrame.canvas.h;
      const needsResize = exportWidth !== baseW || exportHeight !== baseH;
      const exportFormat = mimeToFormat[config.format] ?? 'unknown';
      // WYSIWYG: the per-document HDR switch drives BOTH the presentation and
      // the HDR-container export semantics — OFF means the HDR lanes ship the
      // white-clamped SDR rendition, never a headroom surprise. Resolved BEFORE
      // the egest decision: the AVIF container routes onto its HDR PQ lane
      // (`raw-10`) exactly when this is true, and the same value feeds
      // `renderForExport` below so decision and pixels cannot disagree.
      const hdrSemantics = activeFrame.hdrRender === true;

      // ═══ The single egest decision (core/files/strategy/egest.ts) ═══════
      // Output gamut + container clamp + encode lane + canvas tag + ICC embed
      // + the colour half of the pass-through gate, all resolved together so
      // they cannot disagree. Everything colour-related below just READS it.
      const sourceAsset = activeFrame.assetId ? assets.get(activeFrame.assetId) : undefined;
      const sourceGamut = sourceAsset?.gamut;
      const egest = resolveEgestDecision({
        format: exportFormat,
        sourceGamut,
        requestedGamut: config.targetGamut,
        requestedBitDepth: config.exportBitDepth,
        hdrSemantics,
        embedIccOverride: config.embedIccOverride,
      });

      // ═══ Pass-through (unedited + full-frame + format match + sourceBlob) ═══
      // Download the ORIGINAL file bytes verbatim — no RenderGraph, no
      // re-compression, original ICC/EXIF preserved (pass-through).
      const srcFormat = activeFrame.metadata?.sourceFormat;
      const frameHistory = ctx.state.history.byFrameId[activeFrame.id];
      const unedited = !frameHistory || (frameHistory.past.length === 0 && !frameHistory.checkpoint);

      const isPassThroughEligible =
        !region &&
        !needsResize &&
        unedited &&
        srcFormat === exportFormat &&
        egest.gamutPassThroughEligible &&
        !!activeFrame.assetId;

      if (isPassThroughEligible && activeFrame.assetId) {
        const sourceBlob = await assets.getRaw(activeFrame.assetId);
        if (sourceBlob) {
          const filename = files.getExportFilename(activeFrame.name, exportWidth, exportHeight, config.format);
          return { blob: sourceBlob, filename };
        }
      }

      // ═══ Unified WebGPU export (Readback → encode) ═══════════════════════
      // Sunk into `ExportDispatcher`, reached
      // via `pixels.render.renderForExport`. ONE PIPELINE
      // EQUIVALENCE — see `ExportDispatcher.ts`'s doc comment.
      // `hdrSemantics` was resolved above, before the egest decision.

      // ═══ UltraHDR lane (gain-map JPEG export) ════════════════════════════
      // Trigger (D-c3), resolved HERE so the dispatcher never reads files:
      // JPEG container + the document's HDR switch ON + the canvas-8 lane
      // (an 8-bit sRGB/P3 rendition is what a gain map is FOR) + a decodable
      // source gain map. The dispatcher answers through the ONE export
      // method — `result.gainMap` present = the lane fired (assemble it
      // beside the base); absent = an honest plain file.
      const wantUltraHdr =
        exportFormat === 'jpeg' &&
        hdrSemantics &&
        egest.channel === 'canvas-8' &&
        !!activeFrame.assetId;
      const sourceGainMap = wantUltraHdr
        ? await files.decodeGainMap(activeFrame.metadata)
        : null;

      const rendered = await pixels.render.renderForExport({
        frame: activeFrame,
        viewportDim: ctx.state.ui.viewportDim,
        targetWidth: exportWidth,
        targetHeight: exportHeight,
        region,
        targetGamut: egest.targetGamut,
        channel: egest.channel,
        canvasColorSpace: egest.canvasColorSpace,
        hdrSemantics,
        sourceGainMap,
      });
      const encodeSource = rendered.encodeSource;
      const ultraHdrGainMap = rendered.gainMap ?? null;

      // Encode the composited pixels via FileService handlers (container +
      // ICC/EXIF/DPI injection).
      const encodeOpts: EncodeOptions = {
        quality: config.quality ? config.quality / 100 : 0.92,
        metadata: layerMeta,
        exportConfig: {
          dpi,
          preserveExif: config.keepExif,
          writeSoftwareTag: true,
          embedIcc: egest.embedIcc,
          targetGamut: egest.targetGamut,
          tiffCompression: config.tiffCompression,
          pngCompression: config.pngCompression,
          tiffJpegQuality: config.tiffJpegQuality,
          tiffPredictor: config.tiffPredictor,
          tiffBigtiff: config.tiffBigtiff,
          tiffTile: config.tiffTile,
          tiffTileWidth: config.tiffTileWidth,
          tiffTileHeight: config.tiffTileHeight,
        },
      };

      const blob = await files.encode(encodeSource, config.format, encodeOpts);
      if (encodeSource instanceof ImageBitmap) {
        encodeSource.close();
      }

      // ═══ UltraHDR assembly ═══════════════════════════════════════════════
      // Both halves are finished encodes by this point (base from the JPEG
      // handler, gain plane through its own high-quality JPEG encode); the
      // assembler wraps the GContainer XMP + ISO 21496-1 + MPF around them.
      // The MIME contract is load-bearing twice: `files.encode`'s second
      // argument is a MIME ('image/jpeg' — a bare 'jpeg' silently falls to
      // the PNG fallback and the assembler's SOI gate rejects the result),
      // and `getExportFilename` reads the same MIME for its extension.
      let finalBlob = blob;
      if (ultraHdrGainMap && blob.type === 'image/jpeg') {
        const gainSource = buildGainMapEncodeSource(ultraHdrGainMap);
        const gainBlob = await files.encode(gainSource, 'image/jpeg', { quality: 0.95 });
        const assembled = assembleUltraHdr({
          baseJpeg: new Uint8Array(await blob.arrayBuffer()),
          gainMapJpeg: new Uint8Array(await gainBlob.arrayBuffer()),
          gainMapMin: ultraHdrGainMap.gainMin,
          gainMapMax: ultraHdrGainMap.gainMax,
          gainMapGamma: ultraHdrGainMap.gamma,
        });
        finalBlob = new Blob([assembled.buffer as ArrayBuffer], { type: 'image/jpeg' });
      }

      const actualFormat = finalBlob.type || config.format;
      const filename = files.getExportFilename(activeFrame.name, exportWidth, exportHeight, actualFormat);
      return { blob: finalBlob, filename };
    },
  } as EditorCommand<FrameExportEncodePayload, Promise<FrameExportEncodeResult>>,
};
