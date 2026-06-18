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

import React, { Component, ErrorInfo } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  pluginId: string;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class PluginErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(
      `[Plugin Crash] Plugin ID: ${this.props.pluginId}`,
      error,
      errorInfo,
    );
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex flex-col items-center justify-center p-2 text-red-500 bg-red-50 rounded border border-red-200 text-xs text-center overflow-hidden h-full w-full"
          title={`Plugin ${this.props.pluginId} crashed`}
        >
          <AlertTriangle size={16} className="mb-1" />
          <span className="font-bold truncate max-w-full block leading-tight">
            {this.props.pluginId}
          </span>
          <span className="opacity-80 scale-90 block leading-none mt-1">
            Crashed
          </span>
        </div>
      );
    }

    return this.props.children;
  }
}
