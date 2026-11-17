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

import React from 'react';
import { motion } from 'framer-motion';

/**
 * Contract between the workspace shell (DrawerBar, which owns the drag
 * controls of each Reorder.Item) and drawer plugins rendered through
 * PluginSlot, which live behind a plugin boundary and cannot receive refs or
 * handlers through props. The shell provides two capabilities:
 *
 * - startDrag: begins tracking a drag of the owning sidebar item from the
 *   given pointer event. Tracking alone does not move anything; the item only
 *   starts following the pointer once it actually moves, so a plain click on
 *   the same element still fires its own onClick afterwards (this is what
 *   makes "press-drag to reorder, click to open a dropdown" coexist on the
 *   same title).
 * - isDragActive: true while a drag of this item is running or within the
 *   short post-release window. Used to swallow the synthetic click that
 *   browsers fire at pointerup even after a real drag, which would otherwise
 *   toggle dropdowns or buttons as a side effect of reordering.
 */
export interface DrawerDragCapabilities {
  startDrag: (e: React.PointerEvent) => void;
  isDragActive: () => boolean;
}

const DrawerDragContext = React.createContext<DrawerDragCapabilities | null>(
  null
);

export function useDrawerDrag(): DrawerDragCapabilities | null {
  return React.useContext(DrawerDragContext);
}

/**
 * Provider mounted by the workspace shell around each plugin panel slot.
 */
export function DrawerDragProvider({
  capabilities,
  children,
}: {
  capabilities: DrawerDragCapabilities;
  children: React.ReactNode;
}) {
  return (
    <DrawerDragContext.Provider value={capabilities}>
      {children}
    </DrawerDragContext.Provider>
  );
}

/** Elements that must never start a drawer drag when pressed. */
const DRAG_EXEMPT_SELECTOR =
  '[data-no-drag], button, a, input, select, textarea, [role="combobox"], [role="listbox"], [role="slider"]';

function shouldStartDrag(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return !target.closest(DRAG_EXEMPT_SELECTOR);
}

/**
 * Shared header for sidebar drawer panels: leading icon + title (optionally
 * interactive, e.g. an environment selector dropdown) on the left, arbitrary
 * action buttons on the right. The icon + title zone doubles as the drag
 * anchor for reordering the panel inside the DrawerBar, delegated to the
 * workspace shell through DrawerDragProvider; the actions zone is excluded
 * from dragging by design.
 */
export function DrawerHeader({
  icon,
  title,
  leftExtras,
  actions,
  actionsClassName = '',
  className = '',
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  /** Extra non-draggable content rendered right after the title on the left. */
  leftExtras?: React.ReactNode;
  actions?: React.ReactNode;
  /** Extra classes for the actions wrapper (e.g. an item gap like gap-1.5). */
  actionsClassName?: string;
  className?: string;
}) {
  const drag = useDrawerDrag();

  return (
    <motion.div
      layout="position"
      className={`flex items-center justify-between h-6 shrink-0 ${className}`}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex items-center gap-2 select-none"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (!shouldStartDrag(e.target)) return;
            drag?.startDrag(e);
          }}
          // Swallow the click that follows a completed drag so reordering
          // from the title zone never toggles a dropdown or button.
          onClickCapture={(e) => {
            if (drag?.isDragActive()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {/* Per-element cursors: the wrapper box is taller than the title
              text (larger custom icons), so a wrapper-level cursor-grab
              would paint a grab hand over the empty band above/below the
              title. The icon carries the grab affordance; the title keeps
              its own cursor (a dropdown trigger shows pointer), while press-
              drag still works anywhere in this zone. */}
          <span className="cursor-grab active:cursor-grabbing flex items-center">
            {icon}
          </span>
          {title}
        </div>
        {leftExtras}
      </div>
      {actions ? (
        <div className={`flex items-center ${actionsClassName}`}>{actions}</div>
      ) : null}
    </motion.div>
  );
}
