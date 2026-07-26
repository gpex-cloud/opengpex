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
 * entry.worker.ts — Engine V2 Web Worker entry point.
 *
 * Message protocol:
 *   Main → Worker: { id: number, job: Job }
 *   Worker → Main: { id: number, result?: unknown, error?: string }
 *
 * The Worker is self-contained: it receives Job descriptors, routes them
 * through `router()`, and sends back results with optional Transferable lists.
 * It never requests data from the main thread (WorkerCache is self-sufficient).
 */

import { router } from './router';
import type { Job } from '../protocol/jobs';

interface IncomingMessage {
  id: number;
  job: Job;
}

self.onmessage = async (e: MessageEvent<IncomingMessage>) => {
  const { id, job } = e.data;
  try {
    const { result, transfer } = await router(job);
    self.postMessage({ id, result }, { transfer: transfer || [] });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
