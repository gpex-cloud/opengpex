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
 * Send Feedback — data contract and pure helpers for the feedback pipeline.
 *
 * The browser only ever calls the same-origin BFF route (/api/feedback), never
 * the cloud host directly (ad-blocker immunity, no CORS). Identity travels
 * exclusively in headers — Bearer for signed-in users, X-Client-Id as the
 * rate-limit guard key — and never inside the payload: an anonymous submission
 * is a pure content drop with zero identity fields.
 *
 * History rule: anonymous submissions are tracked in a localStorage-only list
 * (this device only, never synced, no network reads); signed-in history is
 * queried from the cloud by user_id and cached locally. The storage/network
 * logic lives in exported pure helpers so node-env unit tests can exercise it
 * without React; FeedbackModal only wires them to component state.
 */

import type { GpuInfo } from '@opengpex/editor/core/engine/gpu/GpuInfo';
import { APP_VERSION } from './protocols';

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;
export const LOCAL_FEEDBACK_STORAGE_KEY = 'gpex_feedback_local';
export const LOCAL_FEEDBACK_MAX_ENTRIES = 50;

export type FeedbackCategory = 'bug' | 'feature' | 'general';
export const FEEDBACK_CATEGORIES: FeedbackCategory[] = ['bug', 'feature', 'general'];

/** Diagnostics attached to every submission. Values are read-only snapshots
 * of state the editor already holds — no new probes, no canvas content, no
 * file names. `gpu.ready === false` is the high-value signal that the engine
 * never finished device negotiation. */
export interface FeedbackDiagnostics {
  appVersion: string;
  userAgent: string;
  os: string;
  gpu: {
    ready: boolean;
    adapter?: {
      vendor: string;
      architecture: string;
      device: string;
      description: string;
    };
    workingFormat?: 'rgba16float' | 'rgba32float';
    limits?: { maxTextureDimension2D: number; maxBufferSize: number };
  };
  screen: string;
  canvasSize?: { width: number; height: number };
}

export interface FeedbackPayload {
  category: FeedbackCategory;
  message: string;
  diagnostics: FeedbackDiagnostics;
}

/** One locally-tracked submission (this device only). */
export interface LocalFeedbackEntry {
  feedbackId: string;
  category: FeedbackCategory;
  message: string;
  createdAt: string;
}

/** One row of the "My Feedback" list. `origin` distinguishes cloud rows
 * (server-known status, possible reply) from device-only rows (anonymous
 * submissions that have no server query path). */
export interface FeedbackHistoryItem {
  feedbackId: string;
  category: FeedbackCategory;
  message: string;
  status: string;
  createdAt: string;
  replyMessage: string | null;
  repliedAt: string | null;
  origin: 'cloud' | 'device';
}

/** Human-readable OS label from the UA string; mirrors the BFF's own
 * client-platform normalization so both sides aggregate identically. */
export function resolveOsLabel(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (/macintosh|mac os/.test(ua)) return 'macOS';
  if (/windows/.test(ua)) return 'Windows';
  if (/linux|cros|android/.test(ua)) return 'Linux';
  return 'Unknown';
}

/** "2560x1440@2x" style screen descriptor; the scale suffix is omitted at 1x. */
export function formatScreenSize(width: number, height: number, devicePixelRatio: number): string {
  const base = `${width}x${height}`;
  return devicePixelRatio && devicePixelRatio !== 1 ? `${base}@${devicePixelRatio}x` : base;
}

export function truncateMessage(message: string): string {
  return message.length > FEEDBACK_MESSAGE_MAX_LENGTH
    ? message.slice(0, FEEDBACK_MESSAGE_MAX_LENGTH)
    : message;
}

/** Stand-in GpuInfo used when the engine surface is unreachable entirely
 * (plugin mounted before engine boot): honestly reports ready:false. */
export const GPU_UNAVAILABLE_SNAPSHOT: GpuInfo = {
  ready: false,
  adapterInfo: { vendor: '', architecture: '', device: '', description: '' },
  limits: { maxTextureDimension2D: 0, maxBufferSize: 0 },
  workingFormat: 'rgba16float',
  needsTiling: false,
  memory: { inUseBytes: 0, freeBytes: 0, peakBytes: 0, compositeTargetBytes: 0, roiTargetBytes: 0, belowCacheBytes: 0, residentTransientBytes: 0, workingSetBytes: 0 },
};

export interface DiagnosticsInput {
  gpu: GpuInfo;
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  canvasSize?: { width: number; height: number };
}

/** Projects the engine snapshot + browser facts into the wire diagnostics
 * shape. The GpuInfo contract keeps the shape stable when `ready` is false,
 * so the projection needs no branches. */
export function projectDiagnostics(input: DiagnosticsInput): FeedbackDiagnostics {
  return {
    appVersion: APP_VERSION,
    userAgent: input.userAgent,
    os: resolveOsLabel(input.userAgent),
    gpu: {
      ready: input.gpu.ready,
      adapter: {
        vendor: input.gpu.adapterInfo.vendor,
        architecture: input.gpu.adapterInfo.architecture,
        device: input.gpu.adapterInfo.device,
        description: input.gpu.adapterInfo.description,
      },
      workingFormat: input.gpu.workingFormat,
      limits: {
        maxTextureDimension2D: input.gpu.limits.maxTextureDimension2D,
        maxBufferSize: input.gpu.limits.maxBufferSize,
      },
    },
    screen: formatScreenSize(input.screenWidth, input.screenHeight, input.devicePixelRatio),
    ...(input.canvasSize ? { canvasSize: input.canvasSize } : {}),
  };
}

/** Client-side cap for the message; the server re-validates independently. */
export function buildFeedbackPayload(
  category: FeedbackCategory,
  message: string,
  diagnostics: FeedbackDiagnostics,
): FeedbackPayload {
  return { category, message: truncateMessage(message), diagnostics };
}

function isLocalFeedbackEntry(value: unknown): value is LocalFeedbackEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.feedbackId === 'string' &&
    typeof v.category === 'string' &&
    typeof v.message === 'string' &&
    typeof v.createdAt === 'string'
  );
}

/** Device-local submission log, newest first. Unavailable storage (SSR,
 * private mode, quota) simply yields an empty list. */
export function readLocalFeedback(): LocalFeedbackEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOCAL_FEEDBACK_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLocalFeedbackEntry);
  } catch {
    return [];
  }
}

/** Prepends one entry, dedupes by id, and evicts the oldest beyond the cap.
 * Storage failures are swallowed: the local log is best-effort. */
export function appendLocalFeedback(entry: LocalFeedbackEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [
      entry,
      ...readLocalFeedback().filter((e) => e.feedbackId !== entry.feedbackId),
    ];
    localStorage.setItem(
      LOCAL_FEEDBACK_STORAGE_KEY,
      JSON.stringify(next.slice(0, LOCAL_FEEDBACK_MAX_ENTRIES)),
    );
  } catch {
    // Non-fatal: without storage the entry just isn't remembered locally.
  }
}

/** Wire shape of a cloud history row (snake_case over the wire). */
interface WireHistoryItem {
  feedback_id?: unknown;
  category?: unknown;
  message?: unknown;
  status?: unknown;
  created_at?: unknown;
  reply_message?: unknown;
  replied_at?: unknown;
}

/** Parses the cloud history response; malformed rows are skipped, a malformed
 * envelope yields an empty list. */
export function parseHistoryResponse(data: unknown): FeedbackHistoryItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const out: FeedbackHistoryItem[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue;
    const w = raw as WireHistoryItem;
    if (typeof w.feedback_id !== 'string' || typeof w.message !== 'string') continue;
    out.push({
      feedbackId: w.feedback_id,
      category: (typeof w.category === 'string' ? w.category : 'general') as FeedbackCategory,
      message: w.message,
      status: typeof w.status === 'string' ? w.status : '',
      createdAt: typeof w.created_at === 'string' ? w.created_at : '',
      replyMessage: typeof w.reply_message === 'string' ? w.reply_message : null,
      repliedAt: typeof w.replied_at === 'string' ? w.replied_at : null,
      origin: 'cloud',
    });
  }
  return out;
}

/** Signed-in "My Feedback" list: cloud rows (newest first) followed by
 * device-only rows from the anonymous era, deduped by id (a submission made
 * while signed in exists in both lists — the cloud row wins). */
export function mergeHistory(
  cloudItems: FeedbackHistoryItem[] | null,
  localEntries: LocalFeedbackEntry[],
): FeedbackHistoryItem[] {
  const cloudIds = new Set((cloudItems ?? []).map((i) => i.feedbackId));
  const deviceItems: FeedbackHistoryItem[] = localEntries
    .filter((e) => !cloudIds.has(e.feedbackId))
    .map((e) => ({
      ...e,
      status: '',
      replyMessage: null,
      repliedAt: null,
      origin: 'device' as const,
    }));
  return [...(cloudItems ?? []), ...deviceItems];
}

export type SubmitFeedbackResult =
  | { ok: true; feedbackId: string }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number }
  | { ok: false; reason: 'failed' };

/** Submits through the same-origin BFF. 429 answers carry the server's
 * Retry-After; every other failure collapses to `failed` — the caller must
 * keep the draft visible either way. */
export async function submitFeedback(
  payload: FeedbackPayload,
  options: { clientId?: string; accessToken?: string } = {},
): Promise<SubmitFeedbackResult> {
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.clientId ? { 'X-Client-Id': options.clientId } : {}),
        ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { feedback_id?: string } | null;
      return { ok: true, feedbackId: typeof data?.feedback_id === 'string' ? data.feedback_id : '' };
    }
    if (res.status === 429) {
      const retryAfterSeconds = Number(res.headers.get('Retry-After')) || 3600;
      return { ok: false, reason: 'rate_limited', retryAfterSeconds };
    }
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/** Fetches the signed-in user's cloud history via the BFF. Returns null on
 * any failure so the caller can keep showing the local list. */
export async function fetchMyFeedback(accessToken: string): Promise<FeedbackHistoryItem[] | null> {
  try {
    const res = await fetch('/api/feedback', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseHistoryResponse(data);
  } catch {
    return null;
  }
}
