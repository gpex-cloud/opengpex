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
 * Universal AI Proxy Route
 * 
 * Universal AI API proxy, resolving browser CORS restrictions.
 * Front-end sends requests to /api/ai-proxy, which are forwarded by the Next.js server to the actual gateway/API endpoint.
 * 
 * Usage:
 *   POST /api/ai-proxy
 *   Headers:
 *     X-Target-URL: https://llm-gateway.example.com/v1/images/generations
 *     X-API-Key: sk-xxx  (Optional, will be converted to Authorization: Bearer xxx)
 *     Content-Type: application/json (or multipart/form-data)
 * 
 *   GET /api/ai-proxy
 *   Headers:
 *     X-Target-URL: https://llm-gateway.example.com/v1/models
 *     X-API-Key: sk-xxx
 */

import { NextRequest, NextResponse } from 'next/server';

// Allowed target URL protocols
const ALLOWED_PROTOCOLS = ['https:', 'http:'];

// Request body size limit (10MB, image editing might require larger payloads)
const MAX_BODY_SIZE = 10 * 1024 * 1024;

export async function GET(request: NextRequest) {
  return proxyRequest(request, 'GET');
}

export async function POST(request: NextRequest) {
  return proxyRequest(request, 'POST');
}

export async function PUT(request: NextRequest) {
  return proxyRequest(request, 'PUT');
}

export async function DELETE(request: NextRequest) {
  return proxyRequest(request, 'DELETE');
}

async function proxyRequest(request: NextRequest, method: string): Promise<NextResponse> {
  try {
    const targetUrl = request.headers.get('X-Target-URL');
    const apiKey = request.headers.get('X-API-Key');

    if (!targetUrl) {
      return NextResponse.json(
        { error: { message: 'Missing X-Target-URL header' } },
        { status: 400 },
      );
    }

    // Validate URL safety
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return NextResponse.json(
        { error: { message: 'Invalid X-Target-URL format' } },
        { status: 400 },
      );
    }

    if (!ALLOWED_PROTOCOLS.includes(parsedUrl.protocol)) {
      return NextResponse.json(
        { error: { message: `Protocol ${parsedUrl.protocol} not allowed` } },
        { status: 400 },
      );
    }

    // Block intranet requests (basic SSRF protection)
    const hostname = parsedUrl.hostname;
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.') ||
      hostname === '::1'
    ) {
      return NextResponse.json(
        { error: { message: 'Internal network targets not allowed' } },
        { status: 403 },
      );
    }

    // Build forwarding request headers
    const forwardHeaders: Record<string, string> = {};

    if (apiKey) {
      forwardHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    // Passthrough Content-Type
    const contentType = request.headers.get('Content-Type');
    if (contentType) {
      forwardHeaders['Content-Type'] = contentType;
    }

    // Build request options
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
    }

    // Initiate proxy request
    const response = await fetch(targetUrl, fetchOptions);

    // Passthrough response
    const responseBody = await response.arrayBuffer();
    const responseHeaders = new Headers();

    // Passthrough key response headers
    const passthroughHeaders = ['content-type', 'x-request-id'];
    for (const key of passthroughHeaders) {
      const val = response.headers.get(key);
      if (val) responseHeaders.set(key, val);
    }

    return new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed';
    console.error('[ai-proxy] Error:', message);
    return NextResponse.json(
      { error: { message: `Proxy error: ${message}` } },
      { status: 502 },
    );
  }
}
