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
 * GPU availability hint data (A7 degrade page).
 *
 * OpenGPEX is WebGPU-only by design: there is NO CPU/canvas fallback. When
 * WebGPU cannot be obtained, the editor shows a hint page built from the
 * data below. This module is intentionally DOM-free and framework-free so
 * the guidance table stays unit-testable in a plain Node environment.
 *
 * The hint is deliberately advisory only — no flow interception, no
 * functional substitute, no link to any legacy editor.
 */

/**
 * Interaction-signal key set by the canvas stage when WebGPU engine init
 * fails at runtime (adapter null / requestDevice failure). The workspace
 * reads this signal to render the hint overlay.
 */
export const GPU_UNAVAILABLE_SIGNAL_KEY = 'gpu.unavailable';

/** One per-platform browser support entry shown on the hint page. */
export interface GpuBrowserGuidance {
  /** Platform name as displayed, e.g. "Windows". */
  platform: string;
  /** Supported browsers on that platform, as displayed. */
  browsers: string;
}

/**
 * Per-platform browser guidance (one line each, rendered as a list).
 *
 * Data basis (Mozilla official sources, as of 2026-11):
 * - Chrome / Edge: WebGPU enabled by default since 113 on desktop.
 * - Safari: enabled by default since Safari 26, including iOS / iPadOS 26+.
 * - Firefox: Windows since 141 (D3D12); Apple-Silicon Macs on all supported
 *   macOS versions since 147; Linux and Android are not yet enabled by
 *   default on stable channels.
 * - iOS / iPadOS: every browser is WebKit-based, so the Safari/iOS version
 *   is what matters regardless of the browser badge.
 */
export const GPU_BROWSER_GUIDANCE: readonly GpuBrowserGuidance[] = [
  { platform: 'Windows', browsers: 'Chrome / Edge 113+, Firefox 141+' },
  { platform: 'macOS (Apple Silicon)', browsers: 'Chrome / Edge 113+, Safari 26+, Firefox 147+' },
  { platform: 'macOS (Intel)', browsers: 'Chrome / Edge 113+, Safari 26+' },
  { platform: 'iOS / iPadOS', browsers: 'Safari 26+ (iOS / iPadOS 26+)' },
  { platform: 'Linux', browsers: 'Chrome / Edge 113+ (Firefox not yet enabled by default)' },
  { platform: 'Android', browsers: 'Chrome 121+ (Firefox not yet enabled by default)' },
];

/** Headline shown on the hint page. */
export const GPU_UNAVAILABLE_TITLE = 'WebGPU is not available';

/** One-line explanation shown under the headline. */
export const GPU_UNAVAILABLE_EXPLANATION =
  'OpenGPEX renders with WebGPU, which your current browser cannot provide. The page will stay blank until you switch to a supported browser.';

/** Label for the reload action. */
export const GPU_UNAVAILABLE_RELOAD_LABEL = 'Reload';
