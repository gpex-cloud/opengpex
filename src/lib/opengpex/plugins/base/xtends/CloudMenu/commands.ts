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

import { EditorContextValue, EditorCommand, Frame, AssetService, FrameExportResult } from '@opengpex/editor/core/types';
import * as P from './protocols';
import {
  packGpex,
  unpackGpex,
  type GpexManifest,
  type GpexAssetManifest,
} from '@opengpex/editor/core/helpers/gpex-format';
import { gpexStorage, type GpexFileProgress } from '@opengpex/editor/core/cloud';
import { zipSync, unzipSync } from 'fflate';
import { LayerFactory } from '@opengpex/editor/core/layer';

// ─── Sync Record Persistence ─────────────────────────────────────────────────

export function loadSyncRecord(frameId: string): P.SyncRecord | null {
  try {
    const raw = localStorage.getItem(P.SYNC_STORAGE_PREFIX + frameId);
    if (!raw) return null;
    return JSON.parse(raw) as P.SyncRecord;
  } catch { return null; }
}

export function saveSyncRecord(frameId: string, record: P.SyncRecord): void {
  try {
    localStorage.setItem(P.SYNC_STORAGE_PREFIX + frameId, JSON.stringify(record));
  } catch { /* noop */ }
}

export function clearSyncRecord(frameId: string): void {
  try {
    localStorage.removeItem(P.SYNC_STORAGE_PREFIX + frameId);
  } catch { /* noop */ }
}

export function hasUnsavedChanges(frameId: string, historyPastLength: number): boolean {
  const record = loadSyncRecord(frameId);
  if (!record) return false;
  return historyPastLength !== record.savedHistoryLength;
}

// ─── Command Payloads ────────────────────────────────────────────────────────

export interface SaveToCloudPayload {
  frame: Frame;
  onPhaseChange?: (phase: P.SavePhase) => void;
}

export interface OpenFromCloudPayload {
  fileId: string;
  /** Pre-fetched from GpexFileItem — enables conflict check before download */
  fileLocalId?: string;
  /** Pre-fetched manifest from GpexFileItem — used for pre-download conflict dialog */
  fileManifest?: GpexManifest;
  /** Expected file size in bytes (from GpexFileItem.fileSize) — used for progress when Content-Length header is unavailable */
  fileSize?: number;
  onConflict: (existingFrame: Frame, manifest: GpexManifest) => Promise<'overwrite' | 'cancel'>;
  onProgress?: GpexFileProgress;
}

// ─── Commands Registry ───────────────────────────────────────────────────────

export const CLOUD_MENU_COMMANDS = {
  saveToCloud: {
    id: P.CMD_SAVE_TO_CLOUD,
    name: 'Save to Cloud',
    execute: async (ctx: EditorContextValue, payload: SaveToCloudPayload): Promise<P.SaveResult> => {
      const { assets, actions } = ctx;
      const { frame, onPhaseChange } = payload;

      try {
        onPhaseChange?.('PACKING');

        // 1. Generate thumbnail bytes
        const thumbnail = await generateThumbnail(frame, assets);

        // 2. Export frame via Advanced Command
        const exported = await actions.adv.gpex.pack.execute(frame);

        // 3. Build payload ZIP (state.json + assets-manifest.json + assets/ + raw/ + dec/)
        const zipPayload = await buildPayload(exported);

        // 4. Assemble manifest
        const manifest: GpexManifest = {
          format: 'gpex',
          version: 1,
          gpexVersion: 'v2',
          frameLocalId: frame.id,
          frameName: frame.name || 'Untitled',
          canvasWidth: frame.canvas?.w || 0,
          canvasHeight: frame.canvas?.h || 0,
          layerCount: LayerFactory.getHostLayers(frame.layers.order.map(id => frame.layers.byId[id])).length,
          assetCount: Object.keys(exported.assets).length,
          // `bitDepth` is deliberately NOT written (§8.4.4 R2): it is legacy
          // read-only in GpexManifest now — per-asset depth travels with each
          // asset in the payload ZIP.
          dpi: frame.dpi ?? 72,
          editorVersion: P.APP_VERSION,
        };

        // 5. Pack .gpex binary container
        const gpexBuffer = packGpex(thumbnail, manifest, zipPayload);

        // 6. Upload
        onPhaseChange?.('UPLOADING');
        const file = new File([gpexBuffer], `${manifest.frameName}.gpex`, {
          type: 'application/x-gpex',
        });
        const result = await gpexStorage.save(file);

        onPhaseChange?.('DONE');
        return { fileId: result.fileId, version: result.version };

      } catch (error) {
        onPhaseChange?.('ERROR');
        throw error;
      }
    }
  } as EditorCommand<SaveToCloudPayload, Promise<P.SaveResult>>,

  openFromCloud: {
    id: P.CMD_OPEN_FROM_CLOUD,
    name: 'Cloud Gallery',
    execute: async (ctx: EditorContextValue, payload: OpenFromCloudPayload): Promise<Frame | null> => {
      const { actions, state } = ctx;
      const { fileId, fileLocalId, fileManifest, fileSize, onConflict, onProgress } = payload;

      // 1. Pre-download conflict check (using metadata from file list, no download needed)
      if (fileLocalId && fileManifest) {
        const existingFrame = state.frames.byId[fileLocalId];
        if (existingFrame) {
          const decision = await onConflict(existingFrame, fileManifest);
          if (decision === 'cancel') return null; // User cancelled — skip download entirely
        }
      }

      // 2. Download (with optional progress reporting, using fileSize as fallback for Content-Length)
      const buffer = await gpexStorage.download(fileId, onProgress, fileSize);

      // 3. Unpack .gpex container
      const { manifest, payload: zipPayload } = unpackGpex(buffer);

      // 4. Unzip to extract state + asset blobs + heavy payloads + asset manifest
      const {
        state: frameState,
        assetBlobs,
        rawBlobs,
        decBuffers,
        manifest: assetManifest,
      } = unpackPayload(zipPayload);

      // 5. Post-download conflict detection (fallback if pre-check was skipped)
      const existingFrame = state.frames.byId[manifest.frameLocalId];
      if (existingFrame) {
        // If pre-check already confirmed overwrite, skip re-asking
        if (!fileLocalId || !fileManifest) {
          const decision = await onConflict(existingFrame, manifest);
          if (decision === 'cancel') return null;
        }

        // Overwrite path: import command handles resetHistory + replaceFrame
        return actions.adv.gpex.unpack.execute({
          state: frameState,
          assetBlobs,
          rawBlobs,
          decBuffers,
          manifest: assetManifest,
          replaceId: manifest.frameLocalId,
        });
      }

      // 6. No conflict: import as new frame
      return actions.adv.gpex.unpack.execute({
        state: frameState,
        assetBlobs,
        rawBlobs,
        decBuffers,
        manifest: assetManifest,
        switchFrame: true,
      });
    }
  } as EditorCommand<OpenFromCloudPayload, Promise<Frame | null>>,

  deleteFromCloud: {
    id: P.CMD_DELETE_FROM_CLOUD,
    name: 'Delete from Cloud',
    execute: async (ctx: EditorContextValue, payload: { fileId: string }): Promise<void> => {
      await gpexStorage.remove(payload.fileId);
    }
  } as EditorCommand<{ fileId: string }, Promise<void>>
};

// ─── Private Helpers ─────────────────────────────────────────────────────────

async function generateThumbnail(frame: Frame, assets: AssetService): Promise<Uint8Array> {
  const thumbAssetId = (frame as unknown as { thumbnail?: { assetId?: string } }).thumbnail?.assetId;
  if (!thumbAssetId) return new Uint8Array(0);

  const entry = assets.get(thumbAssetId);
  if (!entry?.blob) return new Uint8Array(0);

  return new Uint8Array(await entry.blob.arrayBuffer());
}

export async function buildPayload(exported: FrameExportResult): Promise<Uint8Array> {
  const stateBytes = new TextEncoder().encode(JSON.stringify(exported.state));

  const files: Record<string, Uint8Array> = {
    'state.json': stateBytes,
    'assets-manifest.json': new TextEncoder().encode(JSON.stringify(exported.manifest)),
  };

  for (const [id, blob] of Object.entries(exported.assets)) {
    const ext = blob.type.includes('png') ? 'png' : 'webp';
    files[`assets/${id}.${ext}`] = new Uint8Array(await blob.arrayBuffer());
  }

  // Category ②: original source files, already deduplicated by content hash
  // upstream — one physical copy per file, shared by every page it decoded to.
  for (const [fileHash, blob] of Object.entries(exported.rawBlobs)) {
    files[`raw/${fileHash}`] = new Uint8Array(await blob.arrayBuffer());
  }

  // Category ③: bake products' naked high-depth pixels, written as the bare
  // TypedArray bytes. The element type is NOT encoded here — the reader takes
  // it from the manifest's `colorIdentity.dataFormat`, the single authority.
  for (const [id, buffer] of Object.entries(exported.decBuffers)) {
    files[`dec/${id}.bin`] = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  return zipSync(files, { level: 0 });
}

export interface UnpackedPayload {
  state: unknown;
  assetBlobs: Record<string, Blob>;
  rawBlobs: Record<string, Blob>;
  decBuffers: Record<string, Uint16Array | Float32Array>;
  /** Undefined for legacy containers written before `assets-manifest.json`. */
  manifest?: GpexAssetManifest;
}

export function unpackPayload(payload: ArrayBuffer): UnpackedPayload {
  const zipData = unzipSync(new Uint8Array(payload));

  const stateJsonBytes = zipData['state.json'];
  if (!stateJsonBytes) throw new Error('Invalid .gpex payload: missing state.json');
  const state = JSON.parse(new TextDecoder().decode(stateJsonBytes));

  // Read the asset manifest first — `dec/` entries cannot be interpreted
  // without each asset's `dataFormat`. Absent ⇒ legacy container (§4.4), and
  // `unpack` degrades every asset to category ①.
  let manifest: GpexAssetManifest | undefined;
  const manifestBytes = zipData['assets-manifest.json'];
  if (manifestBytes && manifestBytes.byteLength > 0) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as GpexAssetManifest;
    } catch (err) {
      console.warn('[CloudMenu] Malformed assets-manifest.json, falling back to legacy unpack:', err);
    }
  }

  const assetBlobs: Record<string, Blob> = {};
  const rawBlobs: Record<string, Blob> = {};
  const decBuffers: Record<string, Uint16Array | Float32Array> = {};

  for (const [path, data] of Object.entries(zipData)) {
    if (data.byteLength === 0) continue;

    if (path.startsWith('assets/')) {
      const id = path.replace('assets/', '').replace(/\.[^.]+$/, '');
      const ext = path.split('.').pop() || 'png';
      const mimeType = manifest?.assets[id]?.mimeType
        ?? (ext === 'png' ? 'image/png' : 'image/webp');
      assetBlobs[id] = new Blob([data], { type: mimeType });
    } else if (path.startsWith('raw/')) {
      // No extension and no reliable MIME: format routing on the far side goes
      // through the manifest's `sourceFileName`, not this blob's type.
      rawBlobs[path.slice('raw/'.length)] = new Blob([data], { type: 'application/octet-stream' });
    } else if (path.startsWith('dec/') && path.endsWith('.bin')) {
      const id = path.slice('dec/'.length, -'.bin'.length);
      // Copy into a fresh 0-offset buffer: the unzip output is a view into a
      // shared arena whose byteOffset need not satisfy TypedArray alignment.
      const bytes = data.slice();
      decBuffers[id] = manifest?.assets[id]?.colorIdentity.dataFormat === 'rgba32float'
        ? new Float32Array(bytes.buffer)
        : new Uint16Array(bytes.buffer);
    }
  }

  return { state, assetBlobs, rawBlobs, decBuffers, manifest };
}

