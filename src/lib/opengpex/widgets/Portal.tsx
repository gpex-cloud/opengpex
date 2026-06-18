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

interface PortalProps {
  children: ReactNode;
  /** Mount target DOM ID, defaults to the editor-defined root node */
  targetId?: string;
}

/**
 * EditorPortal: Editor unified Portal utility component
 * 
 * Specification responsibilities:
 * 1. Automatically handles safe mount under SSR environment, avoiding injection hydration errors.
 * 2. Unifies DOM lookup logic, defaulting to 'editor-portal-root'.
 * 3. Intended for all UI elements needing to escape local containers (like sidebars, toolbars).
 */
export default function EditorPortal({ 
  children, 
  targetId = 'editor-portal-root' 
}: PortalProps) {
  const [mounted, setMounted] = useState(false);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // 1. Set mounted flag (SSR safe)
    setMounted(true);
    
    // 2. Locate target DOM
    const el = document.getElementById(targetId);
    if (el) {
      setTarget(el);
    } else {
      console.warn(`[EditorPortal] Target ID "#${targetId}" not found. Falling back to body.`);
      setTarget(document.body);
    }

    return () => {
      setMounted(false);
      setTarget(null);
    };
  }, [targetId]);

  // No render if not mounted or target missing
  if (!mounted || !target) return null;

  return createPortal(children, target);
}
