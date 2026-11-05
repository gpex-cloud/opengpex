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

'use client';

/* eslint-disable react-hooks/set-state-in-effect */

import { ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Portal segment: which z-index isolation domain the hosted content belongs
 * to. Each segment has its own root container in GlobalUI, so content can
 * never be trapped under a higher segment by sharing a single island.
 *  - popup:    popovers, dropdowns and tooltips of the workspace (default)
 *  - modal:    modal dialogs and their forModal popovers / tooltips
 *  - window: context menus and other surfaces that must beat dialogs
 */
export type PortalSegment = 'popup' | 'modal' | 'window';

const SEGMENT_ROOT_IDS: Record<PortalSegment, string> = {
  popup: 'editor-portal-root',
  modal: 'editor-portal-root-modal',
  window: 'editor-portal-root-window',
};

interface PortalProps {
  children: ReactNode;
  /** Mount target DOM ID; overrides the segment-derived root when set */
  targetId?: string;
  /** Segment root to mount into; ignored when targetId is given */
  segment?: PortalSegment;
}

/**
 * EditorPortal: Editor unified Portal utility component
 *
 * Specification responsibilities:
 * 1. Automatically handles safe mount under SSR environment, avoiding injection hydration errors.
 * 2. Unifies DOM lookup logic, defaulting to the popup segment root
 *    'editor-portal-root' (override with segment or targetId).
 * 3. Intended for all UI elements needing to escape local containers (like sidebars, toolbars).
 */
export default function EditorPortal({
  children,
  targetId,
  segment = 'popup',
}: PortalProps) {
  const resolvedTargetId = targetId ?? SEGMENT_ROOT_IDS[segment];
  const [mounted, setMounted] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // 1. Set mounted flag (SSR safe)
    setMounted(true);

    // 2. Locate target DOM
    const el = document.getElementById(resolvedTargetId);
    if (el) {
      setTarget(el);
    } else {
      console.warn(`[EditorPortal] Target ID "#${resolvedTargetId}" not found. Falling back to body.`);
      setTarget(document.body);
    }

    return () => {
      setMounted(false);
      setTarget(null);
    };
  }, [resolvedTargetId]);

  // No render if not mounted or target missing
  if (!mounted || !target) return null;

  return createPortal(children, target);
}
