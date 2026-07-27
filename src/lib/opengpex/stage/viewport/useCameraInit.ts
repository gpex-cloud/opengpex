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

import React from 'react';
import { Frame, EditorData, EditorActions } from '@opengpex/editor/core/types';

/**
 * useCameraInit: Viewport camera initialization hook (no-op).
 *
 * Canvas stillness strategy (Photoshop behavior):
 *
 * This hook intentionally does NOT adjust the camera in response to layout
 * changes (drawer panel open/close, ToolMenu pin toggle, window resize, etc.).
 * The canvas remains absolutely still in local coordinates — expanded panels
 * may partially occlude the canvas, which is acceptable and consistent with
 * Photoshop / Affinity Photo behavior.
 *
 * Camera initialization is handled upstream:
 *  - Frame creation paths (singleImage, multiSubImage, create, branch, etc.)
 *    compute and store the correct initial camera via getFitCamera before
 *    calling addFrame.
 *  - On page refresh, the camera is restored from IndexedDB via HYDRATE.
 *  - Manual fit commands (⌘+1, ⌘+2) use `insets.fixed` only (DrawerBar icon
 *    column 40px), ignoring dynamic panel width (`insets.varied`).
 *
 * There is no scenario where the Viewport mounts with an uninitialized camera,
 * and no scenario where layout shifts should override the user's zoom/pan state.
 */
export function useCameraInit(
  _containerRef: React.RefObject<HTMLDivElement | null>,
  _frame: Frame,
  _state: EditorData,
  _actions: EditorActions
) {
  // Intentionally empty — canvas remains absolutely still during layout changes.
}
