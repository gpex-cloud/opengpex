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
 * HTTP transport layer shared by all provider adapters.
 *
 * Everything here is about *moving bytes*, never about which provider to use:
 *   - proxyFetch        every external call is routed through /api/ai-proxy
 *   - readErrorInfo     normalizes the many error body shapes into {status, message}
 *   - postJsonForImage  JSON POST expecting an image, with parameter self-healing
 *   - findImageInJson   locates an image anywhere in an arbitrary JSON response
 *   - extract*          turns a response into a Blob / string
 *
 * Provider selection happens in registry.ts; adapters compose these helpers.
 */

import type { AIEndpoint } from './types';

// ─── URL helpers ───────────────────────────────────────────────────────────────

export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

// ─── Proxy fetch — every external request goes through /api/ai-proxy ───────────

const AI_PROXY_PATH = '/api/ai-proxy';

export interface ProxyFetchOptions {
  targetUrl: string;
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: BodyInit | null;
  contentType?: string;
  /** Optional abort signal — supports cancelling streaming requests. */
  signal?: AbortSignal;
  /**
   * How the API key is presented to the upstream service.
   *  - 'bearer' (default): `Authorization: Bearer <key>` (OpenAI-compatible)
   *  - 'anthropic':        `x-api-key: <key>` (Anthropic native Messages API)
   */
  authMode?: 'bearer' | 'anthropic';
  /** Extra headers forwarded verbatim to the upstream (e.g. anthropic-version). */
  extraHeaders?: Record<string, string>;
}

/** Proxies a request server-side, translating X-API-Key → Authorization: Bearer. */
export async function proxyFetch(opts: ProxyFetchOptions): Promise<Response> {
  const headers: Record<string, string> = {
    'X-Target-URL': opts.targetUrl,
    'X-API-Key': opts.apiKey,
  };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  // Tell the proxy how to present the key upstream (default: bearer).
  if (opts.authMode) headers['X-Auth-Mode'] = opts.authMode;
  // Forward extra upstream headers via a prefixed passthrough envelope so the
  // proxy can replay them without colliding with its own control headers.
  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      headers[`X-Forward-${k}`] = v;
    }
  }

  return fetch(AI_PROXY_PATH, {
    method: opts.method || 'POST',
    headers,
    body: opts.body,
    signal: opts.signal,
  });
}

// ─── Blob helpers ──────────────────────────────────────────────────────────────

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read image blob'));
    reader.readAsDataURL(blob);
  });
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  const commaIdx = dataUrl.indexOf(',');
  return commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
}

// ─── Error handling ────────────────────────────────────────────────────────────

export interface ErrorInfo {
  status: number;
  message: string;
}

export async function readErrorInfo(res: Response): Promise<ErrorInfo> {
  const errData = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    message?: string;
  };
  return {
    status: res.status,
    message: errData.error?.message || errData.message || `HTTP ${res.status} ${res.statusText}`,
  };
}

/**
 * Builds the guidance message for a missing endpoint. Since there is no
 * cross-provider fallback, a 404/405 is a dead end — the message must tell the
 * user the likely cause: the selected provider does not match their service.
 */
export function endpointMismatchMessage(
  endpoint: AIEndpoint,
  providerName: string,
  action: string,
  status: number,
): string {
  return (
    `${action} is not available on "${endpoint.name}" (HTTP ${status}). ` +
    `This endpoint does not expose the API that ${providerName} uses. ` +
    `Open Settings and verify the provider selected for this endpoint matches your service.`
  );
}

/** Throws the appropriate error for a failed response. */
export async function throwRequestError(
  res: Response,
  ctx: { endpoint: AIEndpoint; providerName: string; action: string },
): Promise<never> {
  const info = await readErrorInfo(res);
  if (info.status === 404 || info.status === 405) {
    throw new Error(endpointMismatchMessage(ctx.endpoint, ctx.providerName, ctx.action, info.status));
  }
  throw new Error(info.message);
}

// ─── Parameter self-healing (single request scope) ─────────────────────────────

/** Known "bad parameter" signatures → the parameter to strip and retry without. */
export function findStrippableParam(message: string, body: Record<string, unknown>): string | null {
  if (!/unknown parameter|invalid value|unrecognized|unsupported/i.test(message)) return null;
  // e.g. "Unknown parameter: 'response_format'" / "Invalid value for 'size'"
  const quoted = message.match(/['"]([a-z_]+)['"]/i);
  if (quoted && quoted[1] in body) return quoted[1];
  return null;
}

export interface JsonImageRequestOptions {
  endpoint: AIEndpoint;
  providerName: string;
  action: string;
  targetUrl: string;
  body: Record<string, unknown>;
}

/**
 * POSTs a JSON body expecting an image back, with one-shot parameter
 * self-healing: if the service rejects a specific extension parameter
 * (400 "Unknown parameter: 'seed'"), strip it and retry once.
 *
 * This is per-request resilience for parameter dialects and is unrelated to
 * provider selection — the provider never changes.
 */
export async function postJsonForImage(opts: JsonImageRequestOptions): Promise<Blob> {
  const { endpoint, providerName, action, targetUrl, body } = opts;

  const res = await proxyFetch({
    targetUrl,
    apiKey: endpoint.apiKey,
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
  });

  if (res.ok) return extractImageFromResponse(res, endpoint.apiKey);

  const info = await readErrorInfo(res);

  const param = findStrippableParam(info.message, body);
  if (param) {
    const retryBody = { ...body };
    delete retryBody[param];
    const retryRes = await proxyFetch({
      targetUrl,
      apiKey: endpoint.apiKey,
      method: 'POST',
      body: JSON.stringify(retryBody),
      contentType: 'application/json',
    });
    if (retryRes.ok) {
      console.warn(`[AIBridge] Self-healed: stripped rejected parameter "${param}" and retried`);
      return extractImageFromResponse(retryRes, endpoint.apiKey);
    }
    throw new Error((await readErrorInfo(retryRes)).message);
  }

  if (info.status === 404 || info.status === 405) {
    throw new Error(endpointMismatchMessage(endpoint, providerName, action, info.status));
  }
  throw new Error(info.message);
}

// ─── Image extraction ──────────────────────────────────────────────────────────

/** Recursively searches arbitrary JSON for the first image reference: OpenAI
 *  data[].b64_json/url, multimodal image parts, data URIs, markdown image links.
 *  Kept generic so response-shape differences between services are absorbed. */
export function findImageInJson(value: unknown): { b64?: string; url?: string } | null {
  if (!value) return null;

  if (typeof value === 'string') {
    const dataUri = value.match(/data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUri) return { b64: dataUri[1] };
    const mdUrl = value.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
      || value.match(/(https?:\/\/[^\s"')]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"')]*)?)/i);
    if (mdUrl) return { url: mdUrl[1] };
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageInJson(item);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['b64_json'] === 'string') return { b64: obj['b64_json'] as string };
    if (typeof obj['url'] === 'string' && /^https?:\/\//.test(obj['url'] as string)) {
      return { url: obj['url'] as string };
    }
    if (obj['type'] === 'image_url' && obj['image_url']) return findImageInJson(obj['image_url']);
    if (obj['type'] === 'image' && typeof obj['data'] === 'string') return { b64: obj['data'] as string };
    for (const key of Object.keys(obj)) {
      const found = findImageInJson(obj[key]);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Turns a successful response into an image Blob.
 *
 * Returned URLs are downloaded THROUGH THE PROXY with the API key attached —
 * some services keep generated images behind the same auth (e.g. LocalAI with
 * LOCALAI_AUTH=true), where a bare browser fetch would get a 401.
 */
export async function extractImageFromResponse(res: Response, apiKey?: string): Promise<Blob> {
  const json = (await res.json().catch(() => null)) as unknown;
  const found = findImageInJson(json);
  if (!found) throw new Error('Invalid API response: no image data found');

  if (found.b64) {
    const binary = atob(found.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  const imgRes = apiKey
    ? await proxyFetch({ targetUrl: found.url!, apiKey, method: 'GET' })
    : await fetch(found.url!);
  if (!imgRes.ok) throw new Error(`Failed to fetch image from returned URL (HTTP ${imgRes.status})`);
  return await imgRes.blob();
}

// ─── Text extraction ───────────────────────────────────────────────────────────

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
}

/**
 * Extracts assistant text from a chat-completions response.
 *
 * Takes ONLY `message.content`. Thinking models (e.g. qwen3) also return a
 * `reasoning` field; a lenient "first string field" strategy would surface the
 * chain-of-thought as the answer.
 */
export async function extractTextFromResponse(res: Response, what: string): Promise<string> {
  const json = (await res.json()) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error(`Invalid ${what} response: message.content is missing`);
  }
  return content;
}

// ─── Model list parsing ────────────────────────────────────────────────────────

/** Normalizes the shapes a /v1/models response can take into raw records. */
export function readModelRecords(rawJson: unknown): Record<string, unknown>[] {
  if (Array.isArray(rawJson)) return rawJson as Record<string, unknown>[];
  const obj = rawJson as Record<string, unknown> | null;
  if (obj && Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  if (obj && Array.isArray(obj.models)) return obj.models as Record<string, unknown>[];
  return [];
}
