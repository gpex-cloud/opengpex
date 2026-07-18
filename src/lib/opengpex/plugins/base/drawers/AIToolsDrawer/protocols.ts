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
 * AIToolsDrawer Plugin Protocols — Aggregation Module
 *
 * This file serves as the public API surface for the AIToolsDrawer plugin.
 * It re-exports all types and constants from the three feature sub-modules:
 *   - bgremover/protocols.ts  — Background removal types & config
 *   - segmentation/protocols.ts — SAM segmentation types & config
 *   - upscaler/protocols.ts  — AI upscaler types & config
 *
 * External consumers (e.g. ClipOverlay/sam.ts) import from THIS file,
 * ensuring stable import paths regardless of internal restructuring.
 */

// ─── Plugin Identity ─────────────────────────────────────────────────────────

export const PLUGIN_ID = 'drawers.ai_tools';
export const PLUGIN_AUTHOR = 'opengpex';

// ─── Re-export: BgRemover ────────────────────────────────────────────────────

export {
  CMD_REMOVE_BG,
  CMD_DOWNLOAD_MODEL,
  CMD_ABORT,
  CMD_OPEN_SETTINGS,
  SIGNAL_STATUS,
  INITIAL_STATUS,
  BUILTIN_MODELS,
  DEFAULT_BG_REMOVAL_CONFIG,
  getBgRemoverModelFiles,
  DEFAULT_BG_ONNX_FILE,
} from './bgremover/protocols';

export type {
  BgRemoverStage,
  BgRemoverStatus,
  BgModelEntry,
  BgRemoverConfig,
} from './bgremover/protocols';

// ─── Re-export: Segmentation ─────────────────────────────────────────────────

export {
  CMD_SEG_ENCODE,
  CMD_SEG_DECODE,
  CMD_SEG_ALL,
  SIGNAL_SEG_STATUS,
  SIGNAL_ACTIVE_TAB,
  INITIAL_SEG_STATUS,
  BUILTIN_SEG_MODELS,
  DEFAULT_SEG_CONFIG,
  SEG_MODEL_FILES,
  getSegModelFiles,
  DEFAULT_SEG_ENCODER_FILE,
  DEFAULT_SEG_DECODER_FILE,
} from './segmentation/protocols';

export type {
  SegStage,
  SegStatus,
  SegModelEntry,
  SegConfig,
  SegPrompt,
  SegEncodePayload,
  SegEncodeResult,
  SegDecodePayload,
  SegDecodeResult,
} from './segmentation/protocols';

// ─── Re-export: Upscaler ─────────────────────────────────────────────────────

export {
  CMD_UPSCALE,
  CMD_UPSCALE_DOWNLOAD,
  CMD_UPSCALE_ABORT,
  SIGNAL_UPSCALE_STATUS,
  INITIAL_UPSCALE_STATUS,
  BUILTIN_UPSCALE_MODELS,
  DEFAULT_UPSCALE_CONFIG,
  DEFAULT_UPSCALE_ONNX_FILE,
  getUpscaleModelFiles,
} from './upscaler/protocols';

export type {
  UpscaleStage,
  UpscaleStatus,
  UpscaleModelEntry,
  UpscaleDpiMode,
  UpscaleConfig,
} from './upscaler/protocols';

// ─── Combined Plugin Config ──────────────────────────────────────────────────

import type { BgRemoverConfig } from './bgremover/protocols';
import type { SegConfig } from './segmentation/protocols';
import type { UpscaleConfig } from './upscaler/protocols';
import { DEFAULT_BG_REMOVAL_CONFIG } from './bgremover/protocols';
import { DEFAULT_SEG_CONFIG } from './segmentation/protocols';
import { DEFAULT_UPSCALE_CONFIG } from './upscaler/protocols';

/** Combined plugin config (BgRemoval + Segmentation + Upscaler) */
export interface AIToolsConfig extends BgRemoverConfig {
  seg: SegConfig;
  upscale: UpscaleConfig;
}

export const DEFAULT_AI_TOOLS_CONFIG: AIToolsConfig = {
  ...DEFAULT_BG_REMOVAL_CONFIG,
  seg: DEFAULT_SEG_CONFIG,
  upscale: DEFAULT_UPSCALE_CONFIG,
};

// ─── Cross-Plugin Typed Facade ───────────────────────────────────────────────

import type { SegEncodePayload, SegEncodeResult, SegDecodePayload, SegDecodeResult } from './segmentation/protocols';
import { SIGNAL_SEG_STATUS, SIGNAL_ACTIVE_TAB, CMD_SEG_ENCODE, CMD_SEG_DECODE } from './segmentation/protocols';
import { SIGNAL_STATUS } from './bgremover/protocols';

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
 *   // Read status:
 *   state.getStateSignal(AIToolsDrawerAPI.signals.segStatus);
 */
export const AIToolsDrawerAPI = {
  signals: {
    /** Segmentation status (stage, progress, embedding state, candidates) */
    segStatus: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_SEG_STATUS}` as const,
    /** Background removal status */
    bgStatus: `${PLUGIN_AUTHOR}.${PLUGIN_ID}.${SIGNAL_STATUS}` as const,
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
