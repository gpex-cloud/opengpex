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

import React, { useEffect, useRef, useState } from 'react';
import { Motion } from '@opengpex/editor/core/motion';
import { AlertTriangle, Check, X, HelpCircle } from 'lucide-react';

interface FancyConfirmProps {
  isVisible: boolean;
  title: string;
  message: string;
  type?: 'info' | 'danger' | 'warning';
  variant?: 'square' | 'rect';
  /** 'confirm' shows two buttons (confirm + cancel); 'alert' shows a single dismiss button */
  mode?: 'confirm' | 'alert';
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * FancyConfirm: Flagship confirmation dialog (Dynamic Variants)
 * Features:
 * 1. Square (Slim & Compact): minimalist vertical flow.
 * 2. Rect: asymmetric horizontal rectangle, high information density design.
 * 3. mode='alert': single-button alert mode (only shows a close button).
 */
export default function FancyConfirm({
  isVisible,
  title,
  message,
  type = 'info',
  variant = 'square',
  mode = 'confirm',
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel
}: FancyConfirmProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const isRect = variant === 'rect';

  // 💡 Use Ref to lock the latest reference of the callback, preventing parent re-renders (like Hover state change) from changing reference
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);
  
  useEffect(() => {
    onConfirmRef.current = onConfirm;
    onCancelRef.current = onCancel;
  }, [onConfirm, onCancel]);

  // 💡 Use State to maintain target random position stability during open lifecycle, preventing re-renders from causing high-frequency icon jumps on hover/redraw
  const [shouldRender, setShouldRender] = useState(isVisible);
  const [prevIsVisible, setPrevIsVisible] = useState(isVisible);
  const [randomStyle, setRandomStyle] = useState({
    left: -24,
    bottom: 8,
    rotate: -15,
    scale: 1
  });

  if (isVisible !== prevIsVisible) {
    setPrevIsVisible(isVisible);
    if (isVisible) {
      setShouldRender(true);
    }
  }

  useEffect(() => {
    if (isVisible) {
      // 💡 Each time the dialog lights up, allocate a set of random geometric parameters within golden aesthetics limits to the giant watermark
      setRandomStyle({
        left: Math.floor(Math.random() * 41) - 40,      // -40px to 0px (left shift clipping)
        bottom: Math.floor(Math.random() * 61) - 10,    // -10px to 50px (vertical offset, center high)
        rotate: Math.floor(Math.random() * 46) - 35,    // -35deg to 10deg (artistic tilt)
        scale: Number((Math.random() * 0.35 + 0.85).toFixed(2)) // 0.85 to 1.2 (size breath)
      });
    }
  }, [isVisible]);

  // 💡 Theme color scheme mapping
  const getTheme = () => {
    switch (type) {
      case 'danger':
        return {
          barBg: 'bg-rose-600',
          squareIconBg: 'bg-rose-500/10 text-rose-600 border-rose-500/20',
          btnBg: 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30',
          icon: <AlertTriangle size={24} strokeWidth={2.5} />,
          IconComponent: AlertTriangle
        };
      case 'warning':
        return {
          barBg: 'bg-amber-500',
          squareIconBg: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
          btnBg: 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/30',
          icon: <AlertTriangle size={24} strokeWidth={2.5} />,
          IconComponent: AlertTriangle
        };
      case 'info':
      default:
        return {
          barBg: 'bg-emerald-600',
          squareIconBg: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
          btnBg: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30',
          icon: <HelpCircle size={24} strokeWidth={2.5} />,
          IconComponent: HelpCircle
        };
    }
  };

  const theme = getTheme();
  const IconComponent = theme.IconComponent;

  useEffect(() => {
    if (isVisible) {
      if (containerRef.current) {
        Motion.to(containerRef.current, { opacity: 1, duration: 0.3, pointerEvents: 'auto' });
      }
      if (modalRef.current) {
        Motion.fromTo(modalRef.current, 
          { scale: 0.95, opacity: 0, y: isRect ? 0 : 15, x: isRect ? 30 : 0 }, 
          { scale: 1, opacity: 1, y: 0, x: 0, duration: 0.5, ease: "expo.out" }
        );
      }

      // Keyboard support (in alert mode, Escape also triggers confirm/dismiss)
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onConfirmRef.current();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (mode === 'alert') {
            onConfirmRef.current(); // Single-button: Escape = dismiss
          } else {
            onCancelRef.current();
          }
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    } else {
      if (containerRef.current) {
        Motion.to(containerRef.current, { 
          opacity: 0, 
          duration: 0.2, 
          pointerEvents: 'none',
          onComplete: () => {
            setShouldRender(false);
          }
        });
      }
      if (modalRef.current) {
        Motion.to(modalRef.current, { scale: 0.95, opacity: 0, y: isRect ? 0 : 5, x: isRect ? 10 : 0, duration: 0.2 });
      }
    }
  }, [isVisible, isRect, mode]); // 💡 Completely untangled from callback function dependencies, animate only on visibility toggle!

  if (!shouldRender) return null;

  // --- Variant 1: Square (Vertical Slim) ---
  const SquareLayout = (
    <div 
      ref={modalRef}
      className="relative w-full max-w-[320px] bg-[var(--bg-panel)] backdrop-blur-3xl rounded-2xl border border-[var(--border-light)] shadow-[0_24px_48px_rgba(0,0,0,0.2)] overflow-hidden"
    >
      <div className="pt-8 pb-4 px-6 flex flex-col items-center text-center">
        <div className={`mb-4 w-12 h-12 rounded-2xl flex items-center justify-center border shadow-sm ${theme.squareIconBg}`}>
          {theme.icon}
        </div>
        <h3 className="text-[var(--text-main)] text-lg font-black tracking-tight leading-tight uppercase italic mb-1 truncate w-full" title={title}>
          {title}
        </h3>
        <p className="text-[var(--text-muted)] text-[11px] font-bold leading-relaxed max-w-[220px]">
          {message}
        </p>
      </div>
      <div className="p-5 pt-2 flex flex-col gap-2">
        <button onClick={onConfirm} className={`w-full py-3 rounded-2xl transition-all active:scale-[0.97] shadow-lg flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] ${theme.btnBg}`}>
          {confirmText} <Check size={14} strokeWidth={3} />
        </button>
        {mode === 'confirm' && (
          <button onClick={onCancel} className="w-full py-3 text-[var(--text-muted)] hover:text-[var(--text-main)] text-[10px] font-black uppercase tracking-[0.15em] transition-colors flex items-center justify-center gap-2">
            <X size={12} strokeWidth={3} /> {cancelText}
          </button>
        )}
      </div>
    </div>
  );

  // --- Variant 2: Rect (Horizontal Wide) ---
  const RectLayout = (
    <div 
      ref={modalRef}
      className="relative flex w-full max-w-[460px] bg-[var(--bg-panel)] backdrop-blur-3xl rounded-2xl border border-[var(--border-light)] shadow-[0_32px_80px_rgba(0,0,0,0.3)] overflow-hidden"
    >
      {/* Asymmetric Left Bar */}
      <div className={`relative w-24 shrink-0 overflow-hidden flex items-center justify-center ${theme.barBg}`}>
        <IconComponent 
          className="absolute text-white/25 pointer-events-none origin-center"
          size={160} 
          strokeWidth={2.5} 
          style={{
            left: `${randomStyle.left}px`,
            bottom: `${randomStyle.bottom}px`,
            transform: `rotate(${randomStyle.rotate}deg) scale(${randomStyle.scale})`
          }}
        />
      </div>

      <div className="flex-1 flex flex-col p-8 pl-10 pr-12 min-w-0">
        <div className="mb-8">
          <h3 className="text-[var(--text-main)] text-2xl font-black tracking-tighter leading-none italic uppercase mb-3 truncate" title={title}>
            {title}
          </h3>
          <p className="text-[var(--text-muted)] text-xs font-bold leading-relaxed uppercase tracking-wide">
            {message}
          </p>
        </div>

        <div className="flex gap-4 mt-auto">
          <button 
            onClick={onConfirm}
            className={`flex-1 py-3.5 rounded-xl transition-all active:scale-[0.96] shadow-xl 
              flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-[0.3em]
              ${theme.btnBg}
            `}
          >
            {confirmText}
            <Check size={14} strokeWidth={3} />
          </button>
          {mode === 'confirm' && (
            <button 
              onClick={onCancel}
              className="px-6 py-3.5 bg-[var(--bg-stage)] hover:bg-[var(--bg-panel)] border border-[var(--border-subtle)] hover:border-[var(--border-light)] rounded-xl transition-all text-[var(--text-muted)] hover:text-[var(--text-main)] text-[10px] font-black uppercase tracking-[0.2em] flex items-center gap-2"
            >
              <X size={12} strokeWidth={3} />
              {cancelText}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div 
      ref={containerRef}
      className="fixed inset-0 z-[6000] flex items-center justify-center p-4 bg-zinc-950/20 opacity-0 pointer-events-none"
    >
      {isRect ? RectLayout : SquareLayout}
    </div>
  );
}
