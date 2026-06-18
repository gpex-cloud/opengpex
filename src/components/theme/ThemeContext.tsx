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

// src/components/theme/ThemeContext.tsx
"use client"

/* eslint-disable react-hooks/set-state-in-effect */

import { createContext, useContext, useState, useEffect, useMemo, useCallback, ReactNode } from 'react';

// Define theme type
type Theme = 'light' | 'dark' | 'system';

// Define Context value type
interface ThemeContextType {
  theme: Theme;
  isDark: boolean;
  switchTheme: (newTheme?: Theme) => void;
}

// Define Provider props type
interface ThemeProviderProps {
  children: ReactNode;
  // Pass initial theme state from server
  initialTheme?: Theme;
  initialIsDark?: boolean;
}

// Create Context
const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ 
  children, 
  initialTheme = 'system',
  initialIsDark = false
}: ThemeProviderProps) {
  // Use initial value passed from server to avoid mismatch between client and server (hydration mismatch)
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [isDark, setIsDark] = useState<boolean>(initialIsDark);

  // Client-side initialization (executed after hydration)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    // Read saved theme from localStorage
    const savedTheme = (localStorage.getItem('theme') as Theme) || 'system';
    setTheme(savedTheme);
    
    // Determine if dark mode should be used
    const updateDarkMode = () => {
      const shouldBeDark = 
        savedTheme === 'dark' || 
        (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      
      setIsDark(shouldBeDark);
      document.documentElement.classList.toggle('dark', shouldBeDark);
    };
    
    updateDarkMode();
    
    // If following system theme, add event listener
    if (savedTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => updateDarkMode();
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, []);

  // Theme toggle function - wrapped with useCallback
  const switchTheme = useCallback((newTheme?: Theme) => {
    // If a specific theme is provided, use it
    if (newTheme) {
      setTheme(newTheme);
      
      if (newTheme === 'system') {
        localStorage.removeItem('theme');
        // Apply system setting immediately
        const systemIsDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
        setIsDark(systemIsDark);
        if (typeof document !== 'undefined') {
          document.documentElement.classList.toggle('dark', systemIsDark);
        }
      } else {
        if (typeof localStorage !== 'undefined') {
          localStorage.theme = newTheme;
        }
        const isDarkMode = newTheme === 'dark';
        setIsDark(isDarkMode);
        if (typeof document !== 'undefined') {
          document.documentElement.classList.toggle('dark', isDarkMode);
        }
      }
      return;
    }
    
    // If no new theme is provided, perform toggle rotation logic
    let nextTheme: Theme;
    
    // Implement rotation: light -> dark -> system -> light...
    if (theme === 'light') nextTheme = 'dark';
    else if (theme === 'dark') nextTheme = 'system';
    else nextTheme = 'light';
    
    // Update state
    setTheme(nextTheme);
    
    // Save settings and apply theme
    if (nextTheme === 'system') {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('theme');
      }
      // Apply system setting immediately
      const systemIsDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDark(systemIsDark);
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', systemIsDark);
      }
    } else {
      if (typeof localStorage !== 'undefined') {
        localStorage.theme = nextTheme;
      }
      const isDarkMode = nextTheme === 'dark';
      setIsDark(isDarkMode);
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', isDarkMode);
      }
    }
  }, [theme]);  // Add theme as dependency because the theme variable is used inside the function

  // Optimize Context value with useMemo, adding switchTheme as dependency
  const contextValue = useMemo(() => ({
    theme,
    isDark,
    switchTheme
  }), [theme, isDark, switchTheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
}

// Create useTheme hook
export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

// Create simplified useDarkMode hook
export function useDarkMode() {
  const { isDark } = useTheme();
  return isDark;
}