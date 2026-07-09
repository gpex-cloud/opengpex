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

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest configuration for OpenGPEX pure-function unit tests.
 *
 * Scope:
 *   Introduced in Step 2 of the filter-pipeline plan to guard the LUT math
 *   (curves / levels / brightness / contrast / channel mixer). We keep this
 *   suite intentionally minimal — only pure modules with no DOM / Canvas /
 *   Worker dependencies are covered here. Rendering-backend integration
 *   tests will land alongside the WorkerBridge changes in Step 3.
 *
 * Notes:
 *   - `environment: 'node'` — the LUT builders are DOM-free by design.
 *   - Path aliases mirror `tsconfig.json` so tests import through
 *     `@opengpex/editor/...` just like production code.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    reporters: 'default',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@opengpex/components': path.resolve(__dirname, './src/components'),
      '@opengpex/editor': path.resolve(__dirname, './src/lib/opengpex'),
    },
  },
});
