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

// src/app/not-found.tsx
'use client';

import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-white dark:bg-zinc-900">
      <div className="fixed top-10 right-12 z-50 flex items-center gap-4">
        <Link 
          href="/" 
          className="flex items-center justify-center w-12 h-12 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 rounded-full shadow-sm transition-colors text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
          aria-label="Back to Home"
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            className="h-6 w-6" 
            viewBox="0 0 20 20" 
            fill="currentColor"
          >
            <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
          </svg>
        </Link>
      </div>
      
      <div className="text-center px-4">
        <div className="flex flex-col md:flex-row items-center justify-center gap-4 mb-6">
          <div className="text-6xl font-bold text-zinc-900 dark:text-white">404</div>
          <div className="hidden md:block h-8 w-px bg-zinc-300 dark:bg-zinc-600"></div>
          <div className="text-2xl font-semibold text-zinc-900 dark:text-white">
            Page Not Found
          </div>
        </div>
        
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          {"The page you're looking for doesn't exist or has been moved."}
        </p>
      </div>
    </div>
  );
}