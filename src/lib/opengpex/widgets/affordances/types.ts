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

import type { Frame, CameraState, VolatileState, ScreenRotationBox } from '@opengpex/editor/core/types';
export type { ScreenRotationBox };

/** Snapshot arguments the framework hands to every per-tick provider. */
export type HudTickArgs = [v: VolatileState, f: Frame, cam: CameraState];

import type { HTMLAttributes, ReactNode } from 'react';
import type { TransformGizmoProps } from '@opengpex/editor/widgets/TransformGizmo';

/**
 * Declarative contract of the transform HUD (see TransformHud): the
 * consumer declares which affordances are on and provides the entity's
 * anchor geometry live; the framework owns all positioning/rotation
 * behavior. Business-agnostic by construction — nothing in the framework
 * reads entity internals.
 */
export interface TransformHudProps {
  active: boolean;
  /** The entity's true box in screen space, derived LIVE every tick. */
  getAnchorFrame: (...args: HudTickArgs) => ScreenRotationBox | null;
  /** Gizmo container reveal policy. Default 'always'. */
  reveal?: 'always' | 'hover';
  /** Hover-reveal containment test (canvas-local point). */
  hitTest?: (localPoint: { x: number; y: number }, f: Frame, cam: CameraState) => boolean;
  /**
   * TransformGizmo DECLARATION — the framework mounts the shared gizmo
   * itself (it composes its sibling widget; consumers never import or
   * position it). Omit for no gizmo (an absent affordance adds no hit
   * surface), e.g. pan sessions.
   */
  gizmo?: TransformGizmoProps;
  /**
   * Press-routing scope rendered as `data-<scope>` on the gizmo container:
   * gesture handlers claim gizmo presses by scoping to this attribute
   * (e.g. 'clip-selection' → data-clip-selection-gizmo), which keeps a
   * foreign entity's gizmo press from hijacking into another handler.
   */
  pressScope?: string;
  /**
   * The gizmo container doubles as a MOVE surface (PS transform-box
   * behavior): renders `data-handle="move"` and pointer-events-auto so
   * box drags move the entity. Omit for pointer-events-none containers
   * whose entity moves by direct dragging (path selections, pen paths).
   */
  moveSurface?: boolean;
  /** Rounded container footprint (circle/ellipse selections render a 50% radius). */
  roundShape?: boolean;
  /**
   * Escape hatch for rare container attributes the first-class props do
   * not cover. Everyday declarations should not need it.
   */
  gizmoContainerProps?: HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: unknown };
  /** Dimension chip: live text plus optional unit suffix (default 'px'). */
  dimension?: { text: (...args: HudTickArgs) => string; unit?: string };
  /** Action bar content (business buttons owned by the consumer). */
  actions?: ReactNode;
  /**
   * Delta chip affordance: renders the framework-owned displacement /
   * rotation chip while a transform gesture on this HUD's entity is in
   * flight (reads the shared gesture-feedback record; frame-target HUDs
   * own the frame feedback). Anchored under the HUD's rotated bottom-left
   * corner, rotated with the entity. Viewport-level DeltaLabel stands
   * down for frame-target gestures while a HUD owns them.
   */
  delta?: boolean;
}
