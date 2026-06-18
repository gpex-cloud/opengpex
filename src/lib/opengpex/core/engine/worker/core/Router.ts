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
 * core/worker/core/Router.ts: Action dispatch center
 */

import { workerCache } from './WorkerCache';
import { PixelUtils } from '../../PixelUtils';
import * as explorer from '../handlers/explorer';
import * as transformer from '../handlers/transformer';
import * as merger from '../handlers/merger';
import * as transcoder from '../handlers/transcoder';

/* eslint-disable @typescript-eslint/no-explicit-any -- Worker message router: payload/result vary per message type */
export async function handleMessage(type: string, payload: any): Promise<{ result: any, transfer?: Transferable[] }> {
  let result: any;
  let transfer: Transferable[] = [];

  switch (type) {
    case 'HASH_ASSET':
      result = await PixelUtils.calculateHash(payload as Blob);
      break;

    case 'DECODE_AND_TILE':
      result = await explorer.decodeAndGetMetadata(payload.hash, payload.blob);
      break;

    case 'GET_TILE':
      const bitmap = await explorer.getTile(payload.hash, payload.level, payload.x, payload.y);
      result = bitmap;
      transfer = [bitmap];
      break;

    case 'CLONE_ASSET_REGION':
      result = await transformer.cloneAssetRegion(payload.hash, payload.rect, payload.shape);
      break;

    case 'BAKE_ASSET_MASKS':
      result = await transformer.bakeAssetMasks(payload.hash, payload.masks);
      break;

    case 'MERGE_LAYERS_TO_LAYER':
      result = await merger.mergeLayersToLayer(payload.canvas, payload.layers, payload.options);
      break;

    case 'RESAMPLE_IMAGE':
      result = await transformer.resampleImage(payload.src, payload.targetSize, payload.options);
      break;

    case 'TRANSCODE_SVG':
      const transcodedBlob = await transcoder.transcodeSvgToRaster(payload.blob, payload.maxDimension);
      result = { blob: transcodedBlob };
      break;

    case 'MERGE_LAYERS_WITH_SHAPE':
      result = await merger.mergeLayersWithShape(payload.canvas, payload.shape, payload.layers, payload.options);
      if (result && result.bitmap) {
        transfer.push(result.bitmap);
      }
      break;

    case 'FORGET_ASSET':
      workerCache.forget(payload as string);
      break;

    case 'INITIALIZE_WORKER':
      workerCache.initialize(payload);
      break;

    default:
      throw new Error(`[Worker] Unknown task type: ${type}`);
  }

  return { result, transfer };
}
