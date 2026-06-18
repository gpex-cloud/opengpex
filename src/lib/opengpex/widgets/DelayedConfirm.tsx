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

import React, { useState, useEffect, useRef } from 'react';

/**
 * DelayedConfirm - A generic wrapper component for double-click confirmation.
 * Ported to new architecture with unified zinc/indigo theme.
 */
interface DelayedConfirmProps {
  children: React.ReactNode;
  onConfirm: () => void;
  delayTime?: number;
  confirmClassName?: string;
  roundedClassName?: string;
  className?: string;
  variant?: 'linear' | 'circular';
  strokeWidth?: number;
  ringColor?: string;
}

export default function DelayedConfirm({
  children,
  onConfirm,
  delayTime = 3000,
  confirmClassName = "bg-indigo-500/10 dark:bg-indigo-400/5",
  roundedClassName = "rounded-xl",
  className = "",
  variant = 'linear',
  strokeWidth = 2,
  ringColor = "text-indigo-500"
}: DelayedConfirmProps) {
  const [stage, setStage] = useState<'idle' | 'confirming'>('idle');
  const [progress, setProgress] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (stage === 'idle') {
      setStage('confirming');
      // Small delay to trigger transition
      setTimeout(() => setProgress(100), 20);
      
      timerRef.current = setTimeout(() => {
        setStage('idle');
        setProgress(0);
      }, delayTime);
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      setStage('idle');
      setProgress(0);
      onConfirm();
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // SVG parameters for circular variant (Countdown style: Starts full, shrinks to 0)
  // Reduced radius slightly to accommodate thicker strokeWidth without overflow
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  // Inverse logic: progress 0 -> offset 0 (Full), progress 100 -> offset circumference (Empty)
  const dashOffset = stage === 'confirming' ? (progress / 100) * circumference : 0;

  const isPositioned = /absolute|fixed|relative/.test(className);

  return (
    <div 
      onClick={handleClick}
      className={`${!isPositioned ? 'relative' : ''} cursor-pointer transition-all duration-200 group ${variant === 'linear' ? `overflow-hidden ${roundedClassName}` : ''} ${className}`}
    >
      {/* 1. Linear Variant Overlays */}
      {variant === 'linear' && (
        <>
          <div 
            className={`absolute inset-0 z-[15] transition-opacity duration-300 pointer-events-none ${stage === 'confirming' ? confirmClassName : 'opacity-0'}`}
          />
          <div 
            className={`absolute inset-0 bg-indigo-500/20 dark:bg-indigo-400/10 origin-left pointer-events-none z-[20] transition-opacity duration-300 ${stage === 'confirming' ? 'opacity-100' : 'opacity-0'}`}
            style={{ 
              transform: `scaleX(${progress / 100})`,
              transitionProperty: progress === 0 ? 'none' : 'transform',
              transitionDuration: progress === 0 ? '0ms' : `${delayTime}ms`,
              transitionTimingFunction: 'linear'
            }}
          />
          <div className={`absolute inset-0 pointer-events-none bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full z-[21] transition-opacity duration-300 ${stage === 'confirming' ? 'opacity-100 animate-[dc-shimmer_2s_infinite]' : 'opacity-0'}`} />
        </>
      )}

      {/* 2. Circular Variant Overlays */}
      {variant === 'circular' && (
        <div className={`absolute inset-[-2px] z-[20] pointer-events-none rotate-[-90deg] transition-opacity duration-300 ${stage === 'confirming' ? 'opacity-100' : 'opacity-0'}`}>
          <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-[0_0_8px_rgba(99,102,241,0.2)]">
            {/* Background trace */}
            <circle
              cx="50" cy="50" r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-white/5"
            />
            {/* Active progress ring */}
            <circle
              cx="50" cy="50" r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              strokeDasharray={circumference}
              style={{ 
                strokeDashoffset: dashOffset,
                transition: progress === 0 ? 'none' : `stroke-dashoffset ${delayTime}ms linear`
              }}
              className={ringColor}
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
      
      {/* Shared Children Container */}
      <div className={`transition-transform duration-200 active:scale-[0.97] ${stage === 'confirming' ? 'scale-[1.05]' : ''}`}>
        {children}
      </div>

      <style jsx global>{`
        @keyframes dc-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </div>
  );
}
