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

import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { PERSISTENT_PLUGINS_DIR } from '@opengpex/editor/core/helpers/config';
import { PluginManifest } from '@opengpex/editor/core/types';

export async function GET() {
  try {
    // Use dynamically configured plugin directory, adapting to SaaS deployment with local relative directory fallback
    const baseDir = PERSISTENT_PLUGINS_DIR;
    const pluginsDir = path.isAbsolute(baseDir) ? baseDir : path.join(/*turbopackIgnore: true*/ process.cwd(), baseDir);

    // Ensure directory exists so we don't crash if no plugins are installed
    await fs.mkdir(pluginsDir, { recursive: true });

    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });

    const plugins: { folderName: string; manifest: PluginManifest }[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = path.join(pluginsDir, entry.name);

        // A valid plugin must have dist/index.js
        try {
          const indexPath = path.join(pluginPath, 'dist', 'index.js');
          await fs.access(indexPath);

          let manifest: PluginManifest | null = null;
          const manifestPath = path.join(pluginPath, 'plugin.manifest');
          try {
            const content = await fs.readFile(manifestPath, 'utf-8');
            manifest = JSON.parse(content);
          } catch {
            // Check plugin.json fallback
            const oldManifestPath = path.join(pluginPath, 'plugin.json');
            try {
              const content = await fs.readFile(oldManifestPath, 'utf-8');
              manifest = JSON.parse(content);
            } catch {
              // Stub dummy manifest fallback
              manifest = {
                id: entry.name,
                displayName: entry.name,
                version: '-',
                description: 'User-installed plugin.',
                category: 'user',
                author: 'anonymous'
              };
            }
          }

          if (manifest) {
            plugins.push({
              folderName: entry.name,
              manifest
            });
          }
        } catch {
          // dist/index.js doesn't exist, ignore
        }
      }
    }

    return NextResponse.json({ success: true, plugins });
  } catch (error: unknown) {
    console.error('❌ Plugin list query error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
