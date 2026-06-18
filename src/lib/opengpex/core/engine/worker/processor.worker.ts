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

/* eslint-disable @typescript-eslint/no-explicit-any, import/no-anonymous-default-export */

/**
 * processor.worker.ts: Image processing worker thread (modular refactored version)
 * Responsibility: As the sole Worker entry, parses messages and forwards to Router.
 */

import { handleMessage } from './core/Router';

const ctx: Worker = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent<{ id: string; type: string; payload: any }>) => {
  const { id, type, payload } = e.data;

  try {
    const { result, transfer } = await handleMessage(type, payload);
    ctx.postMessage({ id, success: true, result }, transfer || []);
  } catch (error: unknown) {
    console.error(`[Worker] Error handling ${type}:`, error);
    ctx.postMessage({ 
      id, 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown worker error' 
    });
  }
};

// Meets TypeScript module requirements
export default {};
