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

import React, { useState, useEffect, useRef, useCallback } from 'react';

// === Color Math Helpers ===
export function hsvToRgb(h: number, s: number, v: number) {
  let r = 0, g = 0, b = 0;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max === min) {
    h = 0; 
  } else {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, v };
}

export function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

export function hexToRgb(hex: string) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  if (c.length !== 6) return null;
  const num = parseInt(c, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// === Presets ===
export const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', 
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ffffff', '#71717a', '#000000'
];

interface ColorPickerProps {
  color: string;
  onChange: (color: string) => void;
  onCommit?: (color: string) => void;
}

export function ColorPicker({ color, onChange, onCommit }: ColorPickerProps) {
  const [hsv, setHsv] = useState({ h: 0, s: 0, v: 1 });
  const [hexInput, setHexInput] = useState(color);
  const hsvRef = useRef({ h: 0, s: 0, v: 1 });
  const hexInputRef = useRef<HTMLInputElement>(null);

  // Auto-select text on mount with a tiny delay to ensure animation has started
  useEffect(() => {
    const timer = setTimeout(() => {
      if (hexInputRef.current) {
        hexInputRef.current.focus();
        hexInputRef.current.select();
      }
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Sync internal HSV when external color changes
  useEffect(() => {
    const rgb = hexToRgb(color);
    if (rgb) {
      const newHsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      // Preserve hue if switching to grayscale, otherwise slider resets to 0
      setHsv(prev => {
        const nextHsv = {
          h: newHsv.s === 0 ? prev.h : newHsv.h,
          s: newHsv.s,
          v: newHsv.v
        };
        hsvRef.current = nextHsv;
        return nextHsv;
      });
      setHexInput(color.toUpperCase());
    }
  }, [color]);

  // Handle HSV area interaction
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const handleAreaMove = useCallback((e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent) => {
    if (!areaRef.current) return;
    e.preventDefault();
    const { left, top, width, height } = areaRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
    
    const x = Math.max(0, Math.min(1, (clientX - left) / width));
    const y = Math.max(0, Math.min(1, (clientY - top) / height));
    
    const next = { ...hsvRef.current, s: x, v: 1 - y };
    setHsv(next);
    hsvRef.current = next;

    const rgb = hsvToRgb(next.h, next.s, next.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onChange(hex);
    setHexInput(hex.toUpperCase());
  }, [onChange]);

  const handleHueMove = useCallback((e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent) => {
    if (!hueRef.current) return;
    e.preventDefault();
    const { left, width } = hueRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
    const x = Math.max(0, Math.min(1, (clientX - left) / width));
    
    const next = { ...hsvRef.current, h: x };
    setHsv(next);
    hsvRef.current = next;

    const rgb = hsvToRgb(next.h, next.s, next.v);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onChange(hex);
    setHexInput(hex.toUpperCase());
  }, [onChange]);

  const handleAreaDown = (e: React.MouseEvent | React.TouchEvent) => {
    handleAreaMove(e);
    const stop = () => {
      document.removeEventListener('mousemove', handleAreaMove);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('touchmove', handleAreaMove);
      document.removeEventListener('touchend', stop);
      if (onCommit) {
        const rgb = hsvToRgb(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v);
        onCommit(rgbToHex(rgb.r, rgb.g, rgb.b));
      }
    };
    document.addEventListener('mousemove', handleAreaMove);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', handleAreaMove, { passive: false });
    document.addEventListener('touchend', stop);
  };

  const handleHueDown = (e: React.MouseEvent | React.TouchEvent) => {
    handleHueMove(e);
    const stop = () => {
      document.removeEventListener('mousemove', handleHueMove);
      document.removeEventListener('mouseup', stop);
      document.removeEventListener('touchmove', handleHueMove);
      document.removeEventListener('touchend', stop);
    };
    document.addEventListener('mousemove', handleHueMove);
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchmove', handleHueMove, { passive: false });
    document.addEventListener('touchend', stop);
  };

  const handleHexInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.toUpperCase();
    setHexInput(val);
    if (/^#?[0-9A-F]{6}$/i.test(val)) {
      const safeVal = val.startsWith('#') ? val : '#' + val;
      onChange(safeVal);
    }
  };

  const handleRgbChange = (channel: 'r'|'g'|'b', val: string) => {
    let num = parseInt(val, 10);
    if (isNaN(num)) return;
    num = Math.max(0, Math.min(255, num));
    const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
    rgb[channel] = num;
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    onChange(hex);
  };

  const currentRgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
  const hueColor = rgbToHex(hsvToRgb(hsv.h, 1, 1).r, hsvToRgb(hsv.h, 1, 1).g, hsvToRgb(hsv.h, 1, 1).b);

  return (
    <div className="flex flex-col gap-2 w-56 select-none">
      
      {/* Saturation/Value Area */}
      <div 
        ref={areaRef}
        onMouseDown={handleAreaDown}
        onTouchStart={handleAreaDown}
        className="w-full h-36 rounded-xl relative overflow-hidden shadow-inner cursor-crosshair ring-1 ring-black/5 dark:ring-white/10"
        style={{ backgroundColor: hueColor }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent pointer-events-none" />
        <div 
          className="absolute w-3 h-3 border-[1.5px] border-white rounded-full shadow-sm -mt-1.5 -ml-1.5 pointer-events-none"
          style={{ 
            left: `${hsv.s * 100}%`, 
            top: `${(1 - hsv.v) * 100}%`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.2) inset, 0 0 4px rgba(0,0,0,0.4)'
          }}
        />
      </div>

      {/* Hue Slider */}
      <div 
        ref={hueRef}
        onMouseDown={handleHueDown}
        onTouchStart={handleHueDown}
        className="w-full h-3.5 rounded-full relative shadow-inner cursor-ew-resize ring-1 ring-black/5 dark:ring-white/10"
        style={{ background: 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)' }}
      >
        <div 
          className="absolute w-4 h-4 bg-white rounded-full shadow-md -mt-[2px] -ml-2 pointer-events-none"
          style={{ left: `${hsv.h * 100}%`, boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}
        />
      </div>

      <div className="w-full h-px bg-zinc-100 dark:bg-white/5 my-0.5" />

      {/* Presets Grid */}
      <div className="grid grid-cols-5 gap-1 px-0.5">
        {PRESET_COLORS.map(c => {
          const isActive = color.toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              onClick={() => { onChange(c); setHexInput(c.toUpperCase()); onCommit?.(c); }}
              className={`
                aspect-square flex items-center justify-center rounded-full transition-all
                ${isActive 
                  ? 'ring-2 ring-zinc-300 dark:ring-offset-zinc-900 bg-zinc-700 shadow-md' 
                  : 'hover:bg-zinc-200 dark:hover:bg-zinc-700 active:scale-95'}
              `}
              title={c}
            >
              <div 
                className={`rounded-full transition-transform  ${isActive ? 'w-6 h-6 scale-120 shadow-md' : 'w-6 h-6 shadow-sm'}`}
                style={{ backgroundColor: c }}
              />
            </button>
          );
        })}
      </div>

      <div className="w-full h-px bg-zinc-100 dark:bg-white/5 my-0.5" />

      {/* Inputs (HEX, R, G, B) */}
      <div className="flex items-center gap-2">
        <div className="flex-1 flex flex-col gap-1">
          <input 
            ref={hexInputRef}
            type="text" 
            value={hexInput}
            onChange={handleHexInput}
            onFocus={(e) => e.target.select()}
            onBlur={() => setHexInput(color.toUpperCase())}
            spellCheck={false}
            className="w-full bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg px-2 h-7 text-[10px] font-black text-center text-zinc-700 dark:text-zinc-300 outline-none focus:border-indigo-500/50 transition-colors uppercase"
          />
          <span className="text-[8px] font-bold text-zinc-400 text-center tracking-widest uppercase">Hex</span>
        </div>

        <div className="flex-[0.7] flex flex-col gap-1">
           <input 
            type="text" 
            value={currentRgb.r} 
            onChange={(e) => handleRgbChange('r', e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-7 text-[10px] font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-colors"
          />
          <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">R</span>
        </div>
        <div className="flex-[0.7] flex flex-col gap-1">
           <input 
            type="text" 
            value={currentRgb.g} 
            onChange={(e) => handleRgbChange('g', e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-7 text-[10px] font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-colors"
          />
          <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">G</span>
        </div>
        <div className="flex-[0.7] flex flex-col gap-1">
           <input 
            type="text" 
            value={currentRgb.b} 
            onChange={(e) => handleRgbChange('b', e.target.value)}
            className="w-full bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-white/10 rounded-lg px-1 h-7 text-[10px] font-bold tabular-nums text-center text-zinc-600 dark:text-zinc-400 outline-none focus:border-indigo-500/50 transition-colors"
          />
          <span className="text-[8px] font-bold text-zinc-400 text-center uppercase">B</span>
        </div>
      </div>
    </div>
  );
}
