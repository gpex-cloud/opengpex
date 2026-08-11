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

import { createWorkerClient } from '../../_shared/control/createWorkerClient';
import type { InpaintEraserRequest, InpaintEraserResult, InpaintEraserProgress } from './worker.types';

/**
 * Inpaint Eraser Worker Client — singleton via createWorkerClient factory.
 *
 * Mode B Persistent Singleton:
 *   - Lazy: Worker constructed on first `run()`.
 *   - Model session cached across calls.
 *   - No default timeout (inpainting can be slow on large masks).
 */
export const inpaintEraserClient = createWorkerClient<InpaintEraserRequest, InpaintEraserResult, InpaintEraserProgress>(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  {
    toolName: 'Inpaint eraser',
    defaultTimeoutMs: 0,
  },
);
