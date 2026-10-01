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

import type { Frame, CameraState, GeometryService } from "@opengpex/editor/core/types";
import type { SampledPixels } from "@opengpex/editor/core/engine/types";
import type { ColorValue } from "@opengpex/editor/core/engine/color";

/** 8-bit RGB triplet (display track). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The two greys of a two-tone magnifier divider (see `gridInkFor`). */
export interface GridInk {
  lo: string;
  hi: string;
}

export interface ColorSamplerProps {
  /** Whether the sampler overlay is active */
  active: boolean;
  /** Called with the sampled structured colour (f32 + gamut) when the user picks */
  onSample: (color: ColorValue) => void;
  /** Called when user cancels (Escape key) */
  onCancel: () => void;
  /**
   * Frozen document composite snapshot (proposal §3): RAW premultiplied-linear
   * pixels, captured on the PRESS that starts a pick (via `onRequestSnapshot`).
   * `null` before the first press, while capturing, or when unavailable. Decoded
   * per-sample through `sampleGpuRawData` on the magnifier window under the
   * cursor — never encoded whole.
   */
  snapshot: SampledPixels | null;
  /**
   * Capture the freeze snapshot for a press, centred on `world`. Called from the
   * overlay's `mousedown`; resolves to the capture (also pushed to `snapshot`), or
   * `null` when it cannot run. This is what makes sampling press-triggered — no
   * readback happens on tool-enter or during pan/zoom.
   */
  onRequestSnapshot: (world: { x: number; y: number }) => Promise<SampledPixels | null>;
  /**
   * 1:1 micro-capture at a world point, for the COMMIT path (A′).
   *
   * The press snapshot is captured at screen resolution (`snapshot.scale`), so when
   * the view is zoomed out its texels are GPU-filtered blends of several document
   * pixels — fine for a preview that mirrors what is on screen, wrong as the value
   * that lands in the colour field. On release, this re-captures a tiny window
   * around the cursor at `scale: 1` so the committed colour is a REAL document
   * pixel, which is also what Photoshop's point-sample eyedropper does at any zoom.
   *
   * Optional: when omitted (or when the snapshot is already 1:1) the preview value
   * is committed directly.
   */
  captureExact?: (world: { x: number; y: number }) => Promise<SampledPixels | null>;
  /**
   * Release the frozen snapshot. Called once the release commit has resolved.
   *
   * The snapshot is a viewport-sized `Float32Array` — 33MB at 1080p, 192MB at 4K.
   * It is only meaningful WHILE the button is held (drag indexing), so holding it
   * on React state until the tool exits pins that much memory for the entire
   * session. The next press captures a fresh one anyway.
   */
  onReleaseSnapshot?: () => void;
  /** Active document frame — supplies canvas dims + camera for screen→world projection. */
  frame: Frame;
  /** Geometry service (uses only `space.screenToWorld`). */
  geometry: GeometryService;
  /** Live camera accessor (pan/zoom are NOT frozen — §3.4①). */
  getCamera: () => CameraState | undefined;
  /**
   * Whether the snapshot was captured from the ACTIVE LAYER only rather than the
   * full composite. Display-only: the scope is chosen by the owner hook (it decides
   * the `layers` argument for both capture paths). Shown in the readout because the
   * sampler is a modal tool with no other affordance — an unannounced "current
   * layer" scope reads as a broken eyedropper over a hidden or clipped region.
   */
  currentLayerOnly?: boolean;
  /** Whether to show the pixel magnifier grid (default: true) */
  showMagnifier?: boolean;
  /**
   * Whether to draw dividers between magnifier pixels (default: true). They are
   * two-tone, both greys derived from the block — see `gridInkFor`.
   */
  showGridLines?: boolean;
  /** Size of each pixel cell in the magnifier grid in px (default: 16) */
  magnifierCellSize?: number;
  /**
   * Grid dimension, must be ODD so there is a centre pixel (default: 9).
   *
   * 9×9 at 16px/cell provides a rich 81-pixel context window around the cursor
   * while keeping the floating loupe compact (~144px).
   */
  magnifierGridSize?: number;
}
