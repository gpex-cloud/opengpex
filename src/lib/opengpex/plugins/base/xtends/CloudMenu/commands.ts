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

import { EditorContextValue, EditorCommand, Frame, AssetService } from '@opengpex/editor/core/types';
import * as P from './protocols';
import { packGpex, unpackGpex, type GpexManifest } from '@opengpex/editor/core/helpers/gpex-format';
import { gpexStorage } from '@opengpex/editor/core/cloud';
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
  onConflict: (existingFrame: Frame, manifest: GpexManifest) => Promise<'overwrite' | 'cancel'>;
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
        const exported = await actions.adv.frame.create.export.execute(frame);

        // 3. Build payload ZIP (state.json + assets/)
        const zipPayload = await buildPayload(exported);

        // 4. Assemble manifest
        const manifest: GpexManifest = {
          format: 'gpex',
          version: 1,
          frameLocalId: frame.id,
          frameName: frame.name || 'Untitled',
          canvasWidth: frame.canvas?.w || 0,
          canvasHeight: frame.canvas?.h || 0,
          layerCount: LayerFactory.getHostLayers(frame.layers.order.map(id => frame.layers.byId[id])).length,
          assetCount: Object.keys(exported.assets).length,
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
      const { fileId, onConflict } = payload;

      // 1. Download
      const buffer = await gpexStorage.download(fileId);

      // 2. Unpack .gpex container
      const { manifest, payload: zipPayload } = unpackGpex(buffer);

      // 3. Unzip to extract state + asset blobs
      const { state: frameState, assetBlobs } = unpackPayload(zipPayload);

      // 4. Conflict detection
      const existingFrame = state.frames.byId[manifest.frameLocalId];
      if (existingFrame) {
        const decision = await onConflict(existingFrame, manifest);
        if (decision === 'cancel') return null;

        // Overwrite path: import command handles resetHistory + replaceFrame
        return actions.adv.frame.create.import.execute({
          state: frameState,
          assetBlobs,
          replaceId: manifest.frameLocalId,
        });
      }

      // 5. No conflict: import as new frame
      return actions.adv.frame.create.import.execute({
        state: frameState,
        assetBlobs,
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

async function buildPayload(exported: { state: unknown; assets: Record<string, Blob> }): Promise<Uint8Array> {
  const stateBytes = new TextEncoder().encode(JSON.stringify(exported.state));

  const files: Record<string, Uint8Array> = {
    'state.json': stateBytes,
  };

  for (const [id, blob] of Object.entries(exported.assets)) {
    const ext = blob.type.includes('png') ? 'png' : 'webp';
    files[`assets/${id}.${ext}`] = new Uint8Array(await blob.arrayBuffer());
  }

  return zipSync(files, { level: 0 });
}

function unpackPayload(payload: ArrayBuffer): { state: unknown; assetBlobs: Record<string, Blob> } {
  const zipData = unzipSync(new Uint8Array(payload));

  const stateJsonBytes = zipData['state.json'];
  if (!stateJsonBytes) throw new Error('Invalid .gpex payload: missing state.json');
  const state = JSON.parse(new TextDecoder().decode(stateJsonBytes));

  const assetBlobs: Record<string, Blob> = {};
  for (const [path, data] of Object.entries(zipData)) {
    if (path.startsWith('assets/') && data.byteLength > 0) {
      const ext = path.split('.').pop() || 'png';
      const mimeType = ext === 'png' ? 'image/png' : 'image/webp';
      assetBlobs[path.replace('assets/', '').replace(/\.[^.]+$/, '')] = new Blob([data], { type: mimeType });
    }
  }

  return { state, assetBlobs };
}

