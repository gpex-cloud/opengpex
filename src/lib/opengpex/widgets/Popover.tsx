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

import React, { ReactNode, useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PopoverPosition = 'top' | 'bottom' | 'left' | 'right';
export type PopoverAlign = 'start' | 'center' | 'end';

interface PopoverProps {
  /** Controls visibility */
  isOpen: boolean;
  /** Called when user clicks outside or presses Escape */
  onClose: () => void;
  /** The trigger element (typically a button) */
  children: ReactNode;
  /** Popover body content (interactive — buttons, inputs, etc.) */
  content: ReactNode;
  /** Placement relative to trigger */
  position?: PopoverPosition;
  /** Alignment along the placement axis */
  align?: PopoverAlign;
  /** Extra className on the popover bubble */
  className?: string;
  /** Extra className on the outer container */
  containerClassName?: string;
  /** Whether clicking outside closes the popover (default: true) */
  dismissOnOutsideClick?: boolean;
  /** Whether pressing Escape closes the popover (default: true) */
  dismissOnEscape?: boolean;
  /** Display mode for the container */
  display?: 'inline-flex' | 'inline' | 'block';
  /** Gap between trigger and popover (px) */
  offset?: number;
  /**
   * Z-index of the rendered popover (it lives in a body-level portal, so this
   * is the *global* z used to layer it against the rest of the editor chrome).
   * Defaults to 9999. Callers can lower it (e.g. when they need a sibling
   * popover/dropdown to overlap *on top* of this one — see the Clip-tool
   * popover vs the aspect-ratio dropdown in `ClipOptions/components.tsx`).
   */
  zIndex?: number;
}


// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Popover — click-triggered, sticky, interactive overlay.
 *
 * Uses a portal to render outside parent overflow boundaries.
 * Position is computed from the trigger element's bounding rect.
 */
export default function Popover({
  isOpen,
  onClose,
  children,
  content,
  position = 'bottom',
  align = 'end',
  className = '',
  containerClassName = '',
  dismissOnOutsideClick = true,
  dismissOnEscape = true,
  display = 'inline-flex',
  offset = 8,
  zIndex = 5000,
}: PopoverProps) {

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  // Arrow offset is anchored to the *trigger center* (not the popover's own
  // 50% mid-line). This keeps the arrow visually pointing at the button no
  // matter which `align` value the caller picks (or how wide the content is).
  // Stored as `{ x, y }` in *popover-local* coordinates and updated alongside
  // `coords` so a single re-position pass keeps both in sync.
  const [arrowOffset, setArrowOffset] = useState<{ x: number; y: number } | null>(null);

  // Compute position from trigger bounding rect
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    let top = 0;
    let left = 0;

    switch (position) {
      case 'bottom':
        top = rect.bottom + scrollY + offset;
        break;
      case 'top':
        top = rect.top + scrollY - offset;
        break;
      case 'left':
        left = rect.left + scrollX - offset;
        top = rect.top + scrollY;
        break;
      case 'right':
        left = rect.right + scrollX + offset;
        top = rect.top + scrollY;
        break;
    }

    // Alignment — `left`/`top` here is the *anchor* point that getTransform()
    // will offset against; the trigger-center coordinate (in viewport space)
    // is what we use to position the arrow.
    let triggerCenterViewport = 0;
    if (position === 'top' || position === 'bottom') {
      switch (align) {
        case 'start':
          left = rect.left + scrollX;
          break;
        case 'center':
          left = rect.left + scrollX + rect.width / 2;
          break;
        case 'end':
          left = rect.right + scrollX;
          break;
      }
      triggerCenterViewport = rect.left + scrollX + rect.width / 2;
    } else {
      switch (align) {
        case 'start':
          top = rect.top + scrollY;
          break;
        case 'center':
          top = rect.top + scrollY + rect.height / 2;
          break;
        case 'end':
          top = rect.bottom + scrollY;
          break;
      }
      triggerCenterViewport = rect.top + scrollY + rect.height / 2;
    }

    setCoords({ top, left });

    // ─── Arrow anchoring (next frame, popover already rendered) ─────────
    // The arrow lives inside the popover; we want its center to land on
    // `triggerCenterViewport`. Wait one rAF so popoverRef.current is laid
    // out (so we can read its rect & translation), then derive the
    // popover-local coordinate of the trigger center.
    requestAnimationFrame(() => {
      const popEl = popoverRef.current;
      if (!popEl) return;
      const popRect = popEl.getBoundingClientRect();
      // popRect.left/top are already the *post-transform* viewport position
      // of the popover content box. Convert trigger-center back to local.
      if (position === 'top' || position === 'bottom') {
        const localX = triggerCenterViewport - scrollX - popRect.left;
        // Clamp to [12, popRect.width - 12] so the arrow never spills out
        // past the rounded corners (12px = arrow size + small inset).
        const clampedX = Math.max(12, Math.min(popRect.width - 12, localX));
        setArrowOffset({ x: clampedX, y: 0 });
      } else {
        const localY = triggerCenterViewport - scrollY - popRect.top;
        const clampedY = Math.max(12, Math.min(popRect.height - 12, localY));
        setArrowOffset({ x: 0, y: clampedY });
      }
    });
  }, [position, align, offset]);


  useEffect(() => {
    if (isOpen) {
      updatePosition();
      // Update on scroll/resize
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
      return () => {
        window.removeEventListener('scroll', updatePosition, true);
        window.removeEventListener('resize', updatePosition);
      };
    }
  }, [isOpen, updatePosition]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen || !dismissOnOutsideClick) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        popoverRef.current && !popoverRef.current.contains(target)
      ) {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [isOpen, onClose, dismissOnOutsideClick]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen || !dismissOnEscape) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, dismissOnEscape]);

  const containerClass = [
    'relative',
    display === 'block' ? 'w-full' : display === 'inline-flex' ? 'inline-flex items-center' : 'inline-block',
    containerClassName,
  ].filter(Boolean).join(' ');

  // Compute CSS transform for alignment
  const getTransform = () => {
    if (position === 'top' || position === 'bottom') {
      switch (align) {
        case 'start': return 'translateX(0)';
        case 'center': return 'translateX(-50%)';
        case 'end': return 'translateX(-100%)';
      }
    } else {
      switch (align) {
        case 'start': return 'translateY(0)';
        case 'center': return 'translateY(-50%)';
        case 'end': return 'translateY(-100%)';
      }
    }
    return '';
  };

  // For top position, also translate up by popover height
  const getExtraTransform = () => {
    if (position === 'top') return ' translateY(-100%)';
    return '';
  };

  // Arrow classes for rotated-square approach (same bg as popover).
  //
  // Theming: the arrow is a small 12×12 rotated square layered behind the
  // content bubble; it must visually merge into the bubble's background, so
  // its `background` is bound to the same `--bg-panel` token as the bubble
  // (white in light mode, `#2b2b2b` in dark mode — see `index.css`). Border
  // uses `--border-subtle` for a hairline edge that matches the bubble.
  //
  // The cross-axis offset (`left` for bottom/top, `top` for left/right) is
  // *not* baked into the class list — it's set via inline style from
  // `arrowOffset` so the arrow can anchor to the trigger center regardless
  // of `align` or content width. The fallback class (`left-1/2 -translate-x-1/2`)
  // is used only on the very first render before `arrowOffset` is computed,
  // to avoid a one-frame visual flash.
  const getArrowClasses = () => {
    const base = 'absolute w-3 h-3 bg-[var(--bg-panel)] border border-[var(--border-subtle)] rotate-45';
    const fallback = arrowOffset == null;
    switch (position) {
      case 'bottom':
        return `${base} -top-1.5 -translate-x-1/2 border-b-0 border-r-0 ${fallback ? 'left-1/2' : ''}`;
      case 'top':
        return `${base} -bottom-1.5 -translate-x-1/2 border-t-0 border-l-0 ${fallback ? 'left-1/2' : ''}`;
      case 'right':
        return `${base} -left-1.5 -translate-y-1/2 border-t-0 border-r-0 ${fallback ? 'top-1/2' : ''}`;
      case 'left':
        return `${base} -right-1.5 -translate-y-1/2 border-b-0 border-l-0 ${fallback ? 'top-1/2' : ''}`;
    }
  };


  const getArrowStyle = (): React.CSSProperties | undefined => {
    if (!arrowOffset) return undefined;
    if (position === 'top' || position === 'bottom') {
      return { left: arrowOffset.x };
    }
    return { top: arrowOffset.y };
  };


  return (
    <div ref={triggerRef} className={containerClass}>
      {children}
      {isOpen && coords && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className={[
            'absolute',
            'animate-in fade-in zoom-in-95 duration-150',
            className,
          ].join(' ')}
          style={{
            top: coords.top,
            left: coords.left,
            transform: getTransform() + getExtraTransform(),
            zIndex,
          }}

        >
          <div className="relative">
            {/* Arrow — anchored to trigger center via inline style (see getArrowStyle) */}
            <div className={getArrowClasses()} style={getArrowStyle()} />
            {/*
             * Content bubble — themed via CSS tokens so light & dark modes
             * pick up the right surface (`--bg-panel` is `#fff` in light,
             * `#2b2b2b` in dark; see `index.css`). The `popover-bubble`
             * utility class adds the cross-cutting "kill native UA chrome"
             * rules (no focus rings on internal buttons, no text-selection
             * highlight, no native focus outline on the bubble itself) so
             * keyboard / click interactions inside the popover don't show
             * the browser's blue/purple highlights that fight with our
             * accent palette.
             */}
            <div className="popover-bubble bg-[var(--bg-panel)] text-[var(--text-main)] rounded-xl shadow-2xl border border-[var(--border-subtle)] backdrop-blur-xl overflow-hidden">
              {content}
            </div>
          </div>

        </div>,
        document.body
      )}
    </div>
  );
}
