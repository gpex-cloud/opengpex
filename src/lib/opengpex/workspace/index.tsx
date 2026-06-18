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
import { EditorProvider, useEditorServices, useEditorState } from '@opengpex/editor/core/context';
import { Workspace as WorkspaceController } from './Workspace';
import { useLayoutSync } from './hooks/useLayoutSync';

/**
 * WorkspaceShell: State gateway
 * Handles global services initialization and layout synchronization.
 */
function WorkspaceShell() {
 const { actions } = useEditorServices();
 const { state } = useEditorState();
 
 // 1. Sync layout config to State
 useLayoutSync(state, actions);

 return <WorkspaceController />;
}

/**
 * Workspace: Top-level editor entry point
 */
export default function Workspace() {
 return (
 <EditorProvider>
 <WorkspaceShell />
 </EditorProvider>
 );
}
