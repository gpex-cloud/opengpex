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

import { createWorkerClient } from '../_shared/control/createWorkerClient';
import type { BgRemoverRequest, BgRemoverResult, BgRemoverProgress } from './worker.types';

/**
 * BgRemover Worker Client — singleton via createWorkerClient factory.
 *
 * Mode B Persistent Singleton:
 *   - Lazy: Worker constructed on first `run()`.
 *   - Pipeline cached: loaded model persists across calls.
 *   - Auto-disposes on WebGPU/ORT errors (corrupted backend state).
 *   - 30-second default timeout (first-time model download may be slow).
 */
export const bgRemoverClient = createWorkerClient<BgRemoverRequest, BgRemoverResult, BgRemoverProgress>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  {
    toolName: 'BgRemover',
    defaultTimeoutMs: 30_000,
    autoDisposeOnWebGpuError: true,
  },
);
