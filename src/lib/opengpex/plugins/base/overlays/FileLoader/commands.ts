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

import { EditorContextValue, EditorCommand } from '@opengpex/editor/core/types';
import { detectFormat } from '@opengpex/editor/core/files';
import type { EncodeOptions, RawPixelSource } from '@opengpex/editor/core/files';
import * as P from './protocols';
import {
  buildFillBuffer,
  validateBlankCanvasSize,
  type BlankBackground,
  type BlankGamut,
} from './_new-doc';

/** Everything the New Document dialog resolves before handing off to `createBlank`. */
export interface CreateBlankPayload {
  /** Final pixel size — the dialog already converted physical units via DPI. */
  width: number;
  height: number;
  dpi: number;
  background: BlankBackground;
  gamut: BlankGamut;
  bitDepth: 8 | 16;
  /** Collision-free frame name (`creation-{ran}` by default, user-editable). */
  name: string;
}

/** Fallback when the GPU engine has not negotiated limits yet (matches the engine's own default). */
const FALLBACK_MAX_TEXTURE_DIMENSION = 8192;
const FALLBACK_MAX_BUFFER_SIZE = 256 * 1024 * 1024;

/**
 * FILE_LOADER_COMMANDS: Declarative command configuration (Single Source of Truth).
 */
export const FILE_LOADER_COMMANDS = {
  import: {
    id: P.CMD_IMPORT,
    name: 'Import Files',
    execute: async (ctx: EditorContextValue, files: File[]) => {
      const { state, actions } = ctx;
      if (!state.isLoaded) return;

      const imageFiles = files.filter(f => detectFormat(f) !== 'unknown');
      if (imageFiles.length === 0) return;

      try {
        for (let i = 0; i < imageFiles.length; i++) {
          const file = imageFiles[i];

          // Set importing progress (HUD always shows "Loading…" or "Loading 2/5…")
          actions.setStateSignal(P.SIGNAL_IMPORTING, { current: i + 1, total: imageFiles.length });

          // Match by frame.source (original filename with extension, set at import time)
          const existingFrame = state.frames.order.map(id => state.frames.byId[id]).find(f => f.source === file.name);
          if (existingFrame) {
            const choice = await actions.askChoice("Creation Exists", [
              { id: 'overwrite', label: 'Overwrite', description: 'Replace the existing creation', primary: true },
              { id: 'new', label: 'New Import', description: 'Keep both as separate creations' },
              { id: 'cancel', label: 'Never Mind', description: 'Skip this file' },
            ], `A creation from "${file.name}" already exists.`);

            if (!choice || choice === 'cancel') continue; // Cancel → skip this file
            if (choice === 'overwrite') {
              ctx.layers.removeFrame(existingFrame.id);
            }
            // 'new' → fall through to import as a new frame
          }

          // Standardized Frame Trunk Initialization Facade
          await actions.adv.frame.create.trunk.execute({ source: file });
        }
      } finally {
        // Always clear the signal, even on error
        actions.setStateSignal(P.SIGNAL_IMPORTING, null);
      }
    }
  } as EditorCommand<File[]>,

  pick: {
    id: P.CMD_PICK,
    name: 'Open File Picker',
    category: 'File',
    shortcuts: [{ key: 'o', meta: true }],
    execute: () => {
      window.dispatchEvent(new CustomEvent('editor:trigger-file-picker'));
    }
  } as EditorCommand,

  newBlank: {
    id: P.CMD_NEW_BLANK,
    name: 'New Document',
    category: 'File',
    // ⌥⌘N rather than ⌘N: ⌘N is a browser-reserved key on macOS (new window)
    // that never reaches the page, confirmed on real hardware.
    shortcuts: [{ key: 'n', meta: true, alt: true }],
    execute: (ctx: EditorContextValue) => {
      if (!ctx.state.isLoaded) return;
      ctx.actions.setStateSignal(P.SIGNAL_NEW_BLANK_MODAL, true);
    }
  } as EditorCommand,

  /**
   * createBlank — synthesize a real PNG for the requested canvas and run it
   * through the standard import pipeline.
   *
   * There is deliberately no hand-assembled metadata / asset bundle here: the
   * blank canvas becomes a `File` named `{name}.png` and takes the exact same
   * `adv.frame.trunk` road as a user-dropped PNG, so colour identity (iCCP →
   * gamut, IHDR → bit depth), DPI (pHYs → `dpiSource:'png-phys'`), base layer,
   * camera fit and HUD all come from the ingest decision matrix unchanged.
   * The only post-import touches are the two things ingest cannot know:
   *   - a transparent canvas is a working layer, not a locked Background;
   *   - the thumbnail is the shared "NEW" placeholder, not a resample of a
   *     uniform fill (which would be an unreadable solid block).
   * Both are applied by `FileLoaderComponent` on `SIGNAL_NEW_BLANK_FINALIZE`:
   * a command's `ctx.state` is a call-time snapshot, so the frame added by
   * `trunk` is only observable from React state.
   */
  createBlank: {
    id: P.CMD_CREATE_BLANK,
    name: 'Create Blank Document',
    execute: async (ctx: EditorContextValue, payload: CreateBlankPayload): Promise<string | undefined> => {
      const { actions, files, pixels, state } = ctx;
      if (!state.isLoaded) return;

      const gpu = pixels.system?.gpuInfo?.();
      const verdict = validateBlankCanvasSize(payload.width, payload.height, {
        maxTextureDimension2D: gpu?.ready ? gpu.limits.maxTextureDimension2D : FALLBACK_MAX_TEXTURE_DIMENSION,
        maxBufferSize: gpu?.ready ? gpu.limits.maxBufferSize : FALLBACK_MAX_BUFFER_SIZE,
      });
      if (!verdict.ok) {
        actions.setInteraction({ hud: { message: verdict.reason, type: 'error' } });
        return;
      }
      // The PNG container is written by wasm-vips, a pthreads build that needs
      // SharedArrayBuffer (cross-origin isolation). Without it the worker never
      // answers and the call only dies on the 120 s watchdog — fail fast instead.
      if (typeof SharedArrayBuffer === 'undefined') {
        actions.setInteraction({ hud: { message: 'New Document needs cross-origin isolation (SharedArrayBuffer), which this browser context does not provide.', type: 'error' } });
        return;
      }

      actions.setStateSignal(P.SIGNAL_NEW_BLANK_MODAL, null);
      actions.setStateSignal(P.SIGNAL_IMPORTING, { label: 'Creating document…', subtitle: `${payload.width} × ${payload.height} px` });
      try {
        // 1. Container: uniform fill → PNG via the egest encoder. 16-bit must
        //    go through the raw-pixel lane (canvas cannot emit 16-bit PNG);
        //    8-bit takes the same lane for one code path. `embedIcc` + `dpi`
        //    make the encoder write the iCCP/sRGB + pHYs chunks that ingest
        //    reads back as colour identity and DPI.
        const source: RawPixelSource = {
          width: payload.width,
          height: payload.height,
          data: buildFillBuffer(payload.width, payload.height, payload.background, payload.gamut, payload.bitDepth),
          bitDepth: payload.bitDepth,
        };
        const encodeOpts: EncodeOptions = {
          exportConfig: {
            dpi: payload.dpi,
            embedIcc: true,
            targetGamut: payload.gamut,
            writeSoftwareTag: true,
          },
        };
        const blob = await files.encode(source, 'image/png', encodeOpts);
        const file = new File([blob], `${payload.name}.png`, { type: 'image/png' });

        // 2. Standard import — identical to dropping this PNG onto the workspace.
        const frameId = await actions.adv.frame.create.trunk.execute({ source: file });

        // 3. Hand the finishing touches to the always-mounted overlay component.
        const finalize: P.NewBlankFinalizeSignal = { frameId, transparent: payload.background === 'transparent' };
        actions.setStateSignal(P.SIGNAL_NEW_BLANK_FINALIZE, finalize);
        return frameId;
      } catch (err) {
        console.error('[FileLoader] Failed to create blank document:', err);
        actions.setInteraction({ hud: { message: 'Could not create the document.', type: 'error' } });
        return;
      } finally {
        actions.setStateSignal(P.SIGNAL_IMPORTING, null);
      }
    }
  } as EditorCommand<CreateBlankPayload, Promise<string | undefined>>
};
