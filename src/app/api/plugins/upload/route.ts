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
import unzipper from 'unzipper';
import { IS_CLOUD_MODE, PERSISTENT_PLUGINS_DIR } from '@opengpex/editor/core/helpers/config';

export async function POST(req: Request) {
  // 1. [First Line of Defense] Strict backend validation of SaaS cloud-disabled mode, blocking unauthorized requests with 403 Forbidden
  if (IS_CLOUD_MODE) {
    console.warn(`[Security Alarm] Unauthorized plugin upload attempt blocked in Cloud Mode.`);
    return NextResponse.json(
      { success: false, error: 'Feature Forbidden: Dynamic plugin uploading is disabled on this server instance.' },
      { status: 403 }
    );
  }

  try {
    // 2. Retrieve the securely configured physical directory for persistent plugins (supports local zero-config relative path fallback)
    const baseDir = PERSISTENT_PLUGINS_DIR;
    const pluginsDir = path.isAbsolute(baseDir) ? baseDir : path.join(/*turbopackIgnore: true*/ process.cwd(), baseDir);

    // Ensure the physical folder exists
    await fs.mkdir(pluginsDir, { recursive: true });

    const buffer = Buffer.from(await req.arrayBuffer());

    // 3. Pre-extract in memory for security auditing and verification
    const directory = await unzipper.Open.buffer(buffer);

    let pluginId = "";
    let author = "";

    // Find metadata file plugin.manifest (prioritized) or plugin.json (fallback)
    const manifestEntry = directory.files.find(f => f.path.endsWith('plugin.manifest')) ||
      directory.files.find(f => f.path.endsWith('plugin.json'));

    if (!manifestEntry) {
      return NextResponse.json(
        { success: false, error: 'Upload Rejected: Plugin must contain a plugin.manifest or plugin.json file.' },
        { status: 400 }
      );
    }

    try {
      const contentBuf = await manifestEntry.buffer();
      const manifest = JSON.parse(contentBuf.toString('utf-8'));
      pluginId = manifest.id || "";
      author = manifest.author || "";
    } catch {
      return NextResponse.json(
        { success: false, error: 'Upload Rejected: Failed to parse manifest file as valid JSON.' },
        { status: 400 }
      );
    }

    if (!pluginId || !author) {
      return NextResponse.json(
        { success: false, error: 'Upload Rejected: Plugin manifest is missing required fields "id" or "author".' },
        { status: 400 }
      );
    }

    // [Second Line of Defense] Core namespace audit: prevent third-party plugins from impersonating official 'base' or 'com.gpex.plugins.base.' prefixes
    if (pluginId) {
      const lowerId = pluginId.toLowerCase();
      if (lowerId.startsWith('base.') || lowerId.startsWith('com.gpex.plugins.base.')) {
        console.error(`❌ [Security Block] Uploaded plugin attempts to impersonate official base namespace: "${pluginId}"`);
        return NextResponse.json(
          { success: false, error: 'Upload Rejected: Impersonating or hijacking the official "base" namespace is forbidden.' },
          { status: 400 }
        );
      }
    }

    // [Fourth Line of Defense] Static source-level plugin conflict detection: if uploaded plugin conflicts with static user plugin, auto-disable static version
    let conflictingStaticUid: string | null = null;
    if (pluginId) {
      try {
        const registryPath = path.join(/*turbopackIgnore: true*/ process.cwd(), 'src/lib/opengpex/plugins/registry-user.ts');

        // Extract all registered uids from static registry
        const staticUids: string[] = [];
        try {
          const registryContent = await fs.readFile(registryPath, 'utf-8');
          const uidMatches = registryContent.matchAll(/uid:\s*['"`]([^'"`]+)['"`]/g);
          for (const m of uidMatches) {
            staticUids.push(m[1]);
          }
        } catch { /* registry-user.ts may not exist in production builds */ }

        // Conflict judgment: local ID of uploaded plugin collides with static registry uid
        const uploadedLocalId = pluginId.includes('.') ? pluginId.split('.').pop()! : pluginId;
        conflictingStaticUid = staticUids.find(uid =>
          uid === pluginId || uid.endsWith(`.${uploadedLocalId}`)
        ) || null;

        if (conflictingStaticUid) {
          console.warn(`⚠️ [Upload] Uploaded plugin "${pluginId}" conflicts with static plugin "${conflictingStaticUid}". The static version will be auto-disabled.`);
        }
      } catch (conflictCheckErr) {
        // Non-fatal: if the conflict check fails (e.g., in containerized prod without source), proceed with upload
        console.warn(`⚠️ [Upload] Static conflict check skipped due to error:`, conflictCheckErr);
      }
    }

    // 4. Adaptive flat/nested ZIP extraction stream, defending against Zip Slip directory escape attacks
    // Analyze if files within ZIP share the same root directory
    const firstLevelDirs = directory.files.map(f => f.path.split('/')[0]);
    const isNestedZip = firstLevelDirs.length > 0 && firstLevelDirs.every(d => d === firstLevelDirs[0]);

    // If Flat ZIP (files at root), use the extracted local ID (last segment) as the sandbox folder prefix
    const localId = pluginId.includes('.') ? pluginId.split('.').pop() : pluginId;
    const defaultFolderName = localId ? localId.replace(/[^a-zA-Z0-9_-]/g, '_') : `plugin_${Date.now()}`;

    for (const file of directory.files) {
      const normalizedPath = path.normalize(file.path);

      // [Third Line of Defense] Zip Slip directory traversal path escape audit
      if (normalizedPath.includes('..') || path.isAbsolute(normalizedPath)) {
        return NextResponse.json({ success: false, error: 'Security Warning: Directory traversal (Zip Slip) attempt detected.' }, { status: 400 });
      }

      // Calculate final extraction path on disk
      let relativeExtractPath = normalizedPath;
      if (!isNestedZip) {
        relativeExtractPath = path.join(defaultFolderName, normalizedPath);
      }

      const finalWritePath = path.join(pluginsDir, relativeExtractPath);

      // Validate again to prevent exceeding safety boundaries
      if (!finalWritePath.startsWith(pluginsDir)) {
        return NextResponse.json({ success: false, error: 'Security Warning: Destructive path traversal blocked.' }, { status: 400 });
      }

      if (file.type === 'File') {
        await fs.mkdir(path.dirname(finalWritePath), { recursive: true });
        await fs.writeFile(finalWritePath, await file.buffer());
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Plugin uploaded, audited, and extracted successfully.',
      // If conflict with static plugin is detected, notify front-end to disable the static version
      conflictingStaticUid: conflictingStaticUid || undefined,
    });
  } catch (error: unknown) {
    console.error('❌ Plugin upload error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
