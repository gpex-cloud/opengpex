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
import { IS_CLOUD_MODE, PERSISTENT_PLUGINS_DIR } from '@opengpex/editor/core/helpers/config';

export async function POST(req: Request) {
  // 🛡️ Block in Cloud Mode
  if (IS_CLOUD_MODE) {
    return NextResponse.json(
      { success: false, error: 'Feature Forbidden: Plugin deletion is disabled in Cloud Mode.' },
      { status: 403 }
    );
  }

  try {
    const body = await req.json() as { pluginId?: string };
    const pluginId = body.pluginId;

    if (!pluginId || typeof pluginId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing required field: pluginId' },
        { status: 400 }
      );
    }

    // 🛡️ Security Check: Prevent path traversal
    if (pluginId.includes('..') || pluginId.includes('/') || pluginId.includes('\\')) {
      return NextResponse.json(
        { success: false, error: 'Invalid plugin ID: path traversal detected.' },
        { status: 400 }
      );
    }

    // Resolve persistent plugins directory
    const baseDir = PERSISTENT_PLUGINS_DIR;
    const pluginsDir = path.isAbsolute(baseDir) ? baseDir : path.join(/*turbopackIgnore: true*/ process.cwd(), baseDir);
    const pluginDir = path.join(pluginsDir, pluginId);

    // Verify path safety
    const resolvedDir = path.resolve(pluginDir);
    const resolvedBase = path.resolve(pluginsDir);
    if (!resolvedDir.startsWith(resolvedBase + path.sep)) {
      return NextResponse.json(
        { success: false, error: 'Security: path escape detected.' },
        { status: 400 }
      );
    }

    // Check if directory exists
    try {
      await fs.access(pluginDir);
    } catch {
      return NextResponse.json(
        { success: false, error: `Plugin "${pluginId}" not found on disk.` },
        { status: 404 }
      );
    }

    // Physically delete plugin directory
    await fs.rm(pluginDir, { recursive: true, force: true });

    console.log(`🗑️ [Plugin Delete] Successfully removed plugin: "${pluginId}"`);

    return NextResponse.json({ success: true, deletedId: pluginId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Plugin Delete] Error:`, errMsg);
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}
