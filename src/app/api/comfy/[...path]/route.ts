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
 * ComfyUI Proxy Route
 *
 * Proxies HTTP requests from the browser to a local/remote ComfyUI instance.
 * This solves CORS restrictions — browsers cannot directly fetch localhost:8188.
 *
 * Unlike the ai-proxy route, this route ALLOWS private IP targets (localhost, 192.168.x.x, etc.)
 * because ComfyUI is expected to run on the user's local machine or LAN.
 *
 * Usage:
 *   POST /api/comfy/upload/image
 *   POST /api/comfy/prompt
 *   GET  /api/comfy/system_stats
 *   GET  /api/comfy/history/{prompt_id}
 *   GET  /api/comfy/view?filename=xxx
 *
 *   Headers:
 *     x-comfy-url: http://localhost:8188  (ComfyUI base URL)
 */

import { NextRequest, NextResponse } from 'next/server';

// Request body size limit (50MB — ComfyUI uploads can be large images)
const MAX_BODY_SIZE = 50 * 1024 * 1024;

// Allowed protocols
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

function validateComfyUrl(urlStr: string): { valid: boolean; error?: string; url?: URL } {
  try {
    const url = new URL(urlStr);
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
      return { valid: false, error: `Protocol ${url.protocol} not allowed. Use http: or https:` };
    }
    return { valid: true, url };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

async function proxyToComfy(
  request: NextRequest,
  method: string,
  params: { path: string[] },
): Promise<NextResponse> {
  try {
    const comfyUrl = request.headers.get('x-comfy-url') || 'http://localhost:8188';

    const validation = validateComfyUrl(comfyUrl);
    if (!validation.valid) {
      return NextResponse.json(
        { error: { message: validation.error } },
        { status: 400 },
      );
    }

    // Build target path
    const targetPath = params.path.join('/');
    const search = request.nextUrl.searchParams.toString();
    const targetUrl = `${comfyUrl.replace(/\/+$/, '')}/${targetPath}${search ? '?' + search : ''}`;

    // Build forwarding headers
    const forwardHeaders: Record<string, string> = {};
    const contentType = request.headers.get('content-type');
    if (contentType) {
      forwardHeaders['Content-Type'] = contentType;
    }

    // Build fetch options
    const fetchOptions: RequestInit = {
      method,
      headers: forwardHeaders,
    };

    // Handle request body (POST/PUT)
    if (method !== 'GET' && method !== 'DELETE') {
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_SIZE) {
        return NextResponse.json(
          { error: { message: `Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)` } },
          { status: 413 },
        );
      }
      fetchOptions.body = body;
      // For multipart/form-data, we need to NOT set content-type header
      // so that the boundary is preserved from the original request
      if (contentType?.includes('multipart/form-data')) {
        // The arrayBuffer already contains the boundary, but we need to pass
        // the original content-type header which includes the boundary
        forwardHeaders['Content-Type'] = contentType;
      }
    }

    // Execute proxy request
    const response = await fetch(targetUrl, fetchOptions);

    // Build response
    const responseBody = await response.arrayBuffer();
    const responseHeaders = new Headers();

    // Pass through content-type
    const respContentType = response.headers.get('content-type');
    if (respContentType) {
      responseHeaders.set('Content-Type', respContentType);
    }

    return new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    console.error('[comfy-proxy] Error:', message);
    return NextResponse.json(
      { error: { message: `ComfyUI proxy error: ${message}` } },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await params;
  return proxyToComfy(request, 'GET', resolvedParams);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await params;
  return proxyToComfy(request, 'POST', resolvedParams);
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await params;
  return proxyToComfy(request, 'PUT', resolvedParams);
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const resolvedParams = await params;
  return proxyToComfy(request, 'DELETE', resolvedParams);
}
