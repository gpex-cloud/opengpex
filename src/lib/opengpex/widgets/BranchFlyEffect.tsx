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

import React, { useState, useEffect, useCallback } from 'react';
import { Motion } from '@opengpex/editor/core/motion';

interface BranchFlyDetail {
  rect: DOMRect;
  thumbnailUrl: string;
  trunkId?: string;
}

interface FlyInstance {
  id: string;
  thumbnailUrl: string;
  startX: number;
  startY: number;
  trunkId?: string;
}

/**
 * BranchFlyEffect: Global branch generation fly-in animation layer
 * Listens to 'editor:branch-fly' events, implementing a parabolic fly-in effect from thumbnail to Dock.
 */
export default function BranchFlyEffect() {
  const [flies, setFlies] = useState<FlyInstance[]>([]);

  const handleFly = useCallback((e: Event) => {
    const { rect, thumbnailUrl, trunkId } = (e as CustomEvent<BranchFlyDetail>).detail;
    const id = `fly-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    
    setFlies(prev => [...prev, {
      id,
      thumbnailUrl,
      startX: rect.left + rect.width / 2,
      startY: rect.top + rect.height / 2,
      trunkId
    }]);

    // Auto cleanup
    setTimeout(() => {
      setFlies(prev => prev.filter(f => f.id !== id));
    }, 1500);
  }, []);

  useEffect(() => {
    window.addEventListener('editor:branch-fly', handleFly);
    return () => window.removeEventListener('editor:branch-fly', handleFly);
  }, [handleFly]);

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden">
      {flies.map(fly => (
        <FlyItem key={fly.id} fly={fly} />
      ))}
    </div>
  );
}

function FlyItem({ fly }: { fly: FlyInstance }) {
  const itemRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!itemRef.current) return;

    const el = itemRef.current;
    
    // Precise positioning: prioritize target thumbnail, fallback to Dock center
    const dockEl = document.getElementById('editor-tab-dock');
    const thumbEl = fly.trunkId 
      ? dockEl?.querySelector(`[data-frame-id="${fly.trunkId}"]`) 
      : null;
    const targetRect = thumbEl?.getBoundingClientRect() || dockEl?.getBoundingClientRect();

    const targetX = targetRect ? (targetRect.left + targetRect.width / 2) : (window.innerWidth / 2);
    const targetY = targetRect ? (targetRect.top + targetRect.height / 2) : (window.innerHeight - 60);

    const tl = Motion.timeline();

    // 1. Popup effect
    tl.fromTo(el, 
      { 
        x: fly.startX, 
        y: fly.startY, 
        scale: 0.2, 
        opacity: 0,
        rotation: -10
      },
      { 
        scale: 1, 
        opacity: 1, 
        duration: 0.4, 
        ease: "back.out(2)" 
      }
    );

    // 2. Fly to Dock
    tl.to(el, {
      x: targetX,
      y: targetY,
      scale: 0.3,
      rotation: 15,
      duration: 0.8,
      ease: "power2.inOut",
      onComplete: () => {
        // Subtle elastic vibration on landing
        Motion.to(el, { opacity: 0, scale: 0, duration: 0.2 });
      }
    }, "-=0.1");

  }, [fly]);

  return (
    <div
      ref={itemRef}
      className="absolute top-0 left-0 -translate-x-1/2 -translate-y-1/2 w-48 aspect-video bg-white dark:bg-zinc-800 rounded-xl border-2 border-white dark:border-zinc-700 shadow-2xl p-1 overflow-hidden"
    >
      <div className="w-full h-full rounded-lg overflow-hidden bg-zinc-200 dark:bg-zinc-900">
        <img 
          src={fly.thumbnailUrl} 
          alt="Branch Preview" 
          className="w-full h-full object-cover"
        />
      </div>
    </div>
  );
}
