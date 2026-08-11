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
 * AIToolsDrawer Plugin Protocols — Cross-Plugin Facade
 *
 * This file provides:
 *   1. Plugin identity constants (PLUGIN_ID, PLUGIN_AUTHOR)
 *   2. AIToolsDrawerAPI — typed cross-plugin facade for external consumers
 *
 * It does NOT re-export sub-module types. Internal consumers import directly
 * from sub-module protocols (e.g. `./segmentation/protocols`).
 * External consumers import AIToolsDrawerAPI from this file for command UIDs
 * and signal keys, and import specific types from sub-module protocols directly.
 */

// ─── Plugin Identity ─────────────────────────────────────────────────────────

export const PLUGIN_ID = 'drawers.ai_tools';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Cross-Plugin Typed Facade ───────────────────────────────────────────────

import type { SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult } from './segmentation/protocols';
import { SIGNAL_ACTIVE_TAB, CMD_SEG_ENCODE, CMD_SEG_DECODE } from './segmentation/protocols';

/**
 * AIToolsDrawerAPI: Structured cross-plugin facade for external consumers.
 *
 * Usage (from ClipOverlay or any other plugin):
 *   import { AIToolsDrawerAPI } from '...drawers/AIToolsDrawer/protocols';
 *
 *   // Encode:
 *   const encResult = await actions.executeCommand<SegEncodePayload, Promise<SegEncodeResult>>(
 *     AIToolsDrawerAPI.commands.segEncode.uid, payload
 *   );
 *
 *   // Decode:
 *   const decResult = await actions.executeCommand<SegDecodePayload, Promise<SegDecodeResult>>(
 *     AIToolsDrawerAPI.commands.segDecode.uid, payload
 *   );
 *
 *   // Write results to store (after projecting to frame coordinates):
 *   import { segStore } from '...drawers/AIToolsDrawer/protocols';
 *   segStore.setState({ lastResult: { candidates, candidateFramePolygons, ... } });
 */
export const AIToolsDrawerAPI = {
  signals: {
    /** Active tab within the AITools drawer ('bg-removal' | 'segmentation') */
    activeTab: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_ACTIVE_TAB}` as const,
  },
  commands: {
    /** Encode image → SAM embedding (async, ~500ms first time). */
    segEncode: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SEG_ENCODE}` } as { uid: string; _payload: SegEncodePayload; _result: Promise<SegEncodeResult> },
    /** Decode prompts → polygon masks (async, ~10ms). */
    segDecode: { uid: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${CMD_SEG_DECODE}` } as { uid: string; _payload: SegDecodePayload; _result: Promise<SegDecodeResult> },
  },
  configKey: `${PLUGIN_AUTHOR}.${PLUGIN_ID}` as const,
} as const;
