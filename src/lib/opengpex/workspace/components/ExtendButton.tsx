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

"use client";

import { useRef, useEffect } from "react";
import PluginSlot from "./PluginSlot";
import { useLayout } from "../LayoutContext";

/**
 * ExtendButton: Generic extension slot container
 * Shell component - Renders nothing if no plugins are registered to XTEND_SLOT.
 * Icons displayed and panels popped up on click are completely determined by plugins.
 *
 * Measures actual height via ResizeObserver and registers to LayoutContext cornerBlocks,
 * Enabling the right DrawerBar to detect and avoid automatically.
 */
export default function ExtendButton() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { setCornerBlock, clearCornerBlock } = useLayout();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height || 0;
      setCornerBlock("topRight", "xtend-button", height);
    });

    observer.observe(el);
    return () => {
      observer.disconnect();
      clearCornerBlock("xtend-button");
    };
  }, [setCornerBlock, clearCornerBlock]);

  return (
    <div ref={containerRef}>
      <PluginSlot name="XTEND_SLOT" />
    </div>
  );
}
