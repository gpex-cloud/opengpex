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

import { promises as fs } from 'fs';
import path from 'path';

// Static source-level plugin directory (for fallback resource reading during local development)
// NOTE: Using inline literal path (not imported variable) so Turbopack can statically scope NFT tracing to this subfolder
const STATIC_USER_PLUGINS_DIR = path.join(process.cwd(), 'src', 'lib', 'opengpex', 'plugins', 'user');

export async function GET(req: Request, { params }: { params: Promise<{ paths: string[] }> }) {
  try {
    // Compatible with Next.js dynamic route segment (params is a Promise in newer Next.js versions and must be safely resolved)
    const resolvedParams = await params;
    const pathsList: string[] = resolvedParams.paths;

    if (!pathsList || pathsList.length < 2) {
      return new Response("Not Found", { status: 404 });
    }

    const pluginId = pathsList[0];
    const subPath = pathsList.slice(1).join('/'); // e.g. "dist/index.js" or "dist/index.css"

    // NOTE: Using inline literal path segments (not imported variable) so Turbopack can statically scope NFT tracing
    const pluginsDir = path.join(process.cwd(), 'data', 'plugins', 'user');
    const dynamicFilePath = path.join(pluginsDir, pluginId, subPath);

    // [Strongest Path Defense] Physical boundary review, preventing path traversal via proxy requests to read sensitive files
    const relativePath = path.relative(pluginsDir, dynamicFilePath);
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
      console.error(`[Security Alarm] Traversal attempt blocked in Proxy serve API: "${dynamicFilePath}"`);
      return new Response("Forbidden: Path traversal attempt blocked.", { status: 403 });
    }

    // Dual-track search: prioritize reading from dynamic persistent disk, fallback to static source directory (for local dev)
    let filePath = '';
    try {
      await fs.access(dynamicFilePath);
      filePath = dynamicFilePath;
    } catch {
      // Fallback: attempt reading from static source directory (enables useAsset to work during local dev)
      const staticFilePath = path.join(STATIC_USER_PLUGINS_DIR, pluginId, subPath);
      const staticRelative = path.relative(STATIC_USER_PLUGINS_DIR, staticFilePath);
      if (staticRelative.includes('..') || path.isAbsolute(staticRelative)) {
        return new Response("Forbidden: Path traversal attempt blocked.", { status: 403 });
      }
      try {
        await fs.access(staticFilePath);
        filePath = staticFilePath;
      } catch {
        return new Response("Not Found: Plugin resource file not found on disk.", { status: 404 });
      }
    }

    const ext = path.extname(subPath).toLowerCase();
    let fileContent: Buffer | string = await fs.readFile(filePath);

    // On-the-fly import rewriting for JS files:
    // Browsers cannot resolve bare specifiers (e.g. "react", "react/jsx-runtime") in native ESM.
    // Rewrite them to window.__GPEX__["pkg"] variable access at serve time.
    if (ext === '.js' || ext === '.mjs') {
      let jsContent = fileContent.toString('utf-8');
      const EXTERNAL_PKGS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'lucide-react'];
      const isExternal = (pkg: string) => EXTERNAL_PKGS.includes(pkg) || pkg.startsWith('@opengpex/editor/');

      const importRegex = /^import\s+(.+?)\s+from\s+["']([^"']+)["']\s*;?\s*$/gm;
      const sideEffectRegex = /^import\s+["']([^"']+)["']\s*;?\s*$/gm;

      jsContent = jsContent.replace(sideEffectRegex, (match: string, pkg: string) => {
        if (isExternal(pkg)) return `/* [GPEX] side-effect import removed: ${pkg} */`;
        return match;
      });

      jsContent = jsContent.replace(importRegex, (match: string, importClause: string, pkg: string) => {
        if (!isExternal(pkg)) return match;

        const g = `window.__GPEX__["${pkg}"]`;

        // "default, { named }" pattern
        const comboMatch = importClause.match(/^(\w+)\s*,\s*\{([^}]*)\}$/);
        if (comboMatch) {
          const defaultName = comboMatch[1].trim();
          const namedPart = comboMatch[2].trim();
          const parts = [`var ${defaultName} = ${g}.default || ${g};`];
          if (namedPart) {
            const converted = namedPart.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
            parts.push(`var { ${converted} } = ${g};`);
          }
          return parts.join('\n');
        }

        // Namespace: import * as X from "pkg"
        const nsMatch = importClause.match(/^\*\s+as\s+(\w+)$/);
        if (nsMatch) return `var ${nsMatch[1]} = ${g};`;

        // Named: import { A, B as C } from "pkg"
        const namedMatch = importClause.match(/^\{([^}]*)\}$/);
        if (namedMatch) {
          const converted = namedMatch[1].trim().replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
          return `var { ${converted} } = ${g};`;
        }

        // Default: import X from "pkg"
        const defaultMatch = importClause.match(/^(\w+)$/);
        if (defaultMatch) return `var ${defaultMatch[1]} = ${g}.default || ${g};`;

        return match;
      });

      fileContent = jsContent;
    }

    // Adaptively set response Content-Type to ensure browser loads JS modules as ESM and assets render correctly
    const MIME_MAP: Record<string, string> = {
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.pdf': 'application/pdf',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4',
      '.wasm': 'application/wasm',
    };
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    // Convert Buffer to Uint8Array for Response compatibility
    const body = typeof fileContent === 'string' ? fileContent : new Uint8Array(fileContent);

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Do not apply strong HTTP caching to dynamic code during development and usage to prevent hot-update failure
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
      }
    });

  } catch (error: unknown) {
    console.error('❌ Proxy serve error:', error);
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    return new Response(message, { status: 500 });
  }
}
