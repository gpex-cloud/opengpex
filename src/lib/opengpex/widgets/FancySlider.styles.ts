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
 * Global CSS for native `<input type="range">` elements styled with the
 * house-shaped thumb. Uses the `.opengpex-basic-slider` class selector.
 *
 * Design:
 * - House/pentagon clip-path matching `THUMB_CLIP_PATH` in FancySlider.tsx
 * - Semantic gradient track via `--track-bg` CSS variable (set inline per row)
 * - Hover: brightness shift only (no color change)
 * - Drop-shadow for depth
 * - Cross-browser: WebKit/Blink + Firefox
 *
 * NOTE: The clip-path polygon is inlined here (not imported from FancySlider.tsx)
 * to avoid a circular dependency: FancySlider.tsx → this file → FancySlider.tsx.
 * If you change the shape, update BOTH this file and THUMB_CLIP_PATH in FancySlider.tsx.
 */

const CLIP_PATH = `polygon(50% 0%, 100% 28%, 100% 88%, 88% 100%, 12% 100%, 0% 88%, 0% 28%)`;

export const SLIDER_THUMB_CSS = /* css */ `
  .opengpex-basic-slider {
    --thumb-w: 12px;
    --thumb-h: 18px;
    --track-height: 8px;
    --thumb-fill: var(--text-main);
    height: calc(var(--track-height) + var(--thumb-h) + 2px);
    padding: 0;
    margin: 0;
    background: transparent;
    outline: none;
  }

  /* ── WebKit / Blink ─────────────────────────────────── */
  .opengpex-basic-slider::-webkit-slider-runnable-track {
    height: var(--track-height);
    border-radius: 2px;
    background: var(--track-bg);
    border: 1px solid var(--border-subtle);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
  }
  .opengpex-basic-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: var(--thumb-w);
    height: var(--thumb-h);
    margin-top: calc(var(--track-height) / 2 + 1px);
    border: none;
    cursor: ew-resize;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
    clip-path: ${CLIP_PATH};
    background: var(--thumb-fill);
  }
  .opengpex-basic-slider:hover::-webkit-slider-thumb,
  .opengpex-basic-slider:focus-visible::-webkit-slider-thumb {
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45)) brightness(1.3);
  }

  /* ── Firefox ────────────────────────────────────────── */
  .opengpex-basic-slider::-moz-range-track {
    height: var(--track-height);
    border-radius: 2px;
    background: var(--track-bg);
    border: 1px solid var(--border-subtle);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
  }
  .opengpex-basic-slider::-moz-range-thumb {
    width: var(--thumb-w);
    height: var(--thumb-h);
    border: none;
    cursor: ew-resize;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45));
    clip-path: ${CLIP_PATH};
    background: var(--thumb-fill);
  }
  .opengpex-basic-slider:hover::-moz-range-thumb,
  .opengpex-basic-slider:focus-visible::-moz-range-thumb {
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45)) brightness(1.3);
  }
  /* Firefox paints a "progress" fill by default — suppress it. */
  .opengpex-basic-slider::-moz-range-progress {
    background: transparent;
  }
`;
