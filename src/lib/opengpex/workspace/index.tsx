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

import React from 'react';
import { EditorProvider } from '@opengpex/editor/core/context';
import { Workspace as WorkspaceController } from './Workspace';

/**
 * Workspace: Top-level editor entry point.
 *
 * Note: Layout-to-Redux sync (useLayoutSync) is now invoked inside
 * <LayoutProvider> subtree from `Workspace.tsx`, since the hook depends
 * on the LayoutContext (`safeRect` / `status`) provided by it.
 */
export default function Workspace() {
 return (
 <EditorProvider>
 <WorkspaceController />
 </EditorProvider>
 );
}
