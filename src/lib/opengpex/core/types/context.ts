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

import { EditorActions } from './actions';
import { GeometryService } from './geometry';
import { PixelService, AssetService, ClipboardService, StateStorage, LayerService } from './services';
import { EditorState, VolatileState, InteractionSignalValue } from './state';
import { Frame, Layer } from './models';
import { FontService } from '@opengpex/editor/core/fonts';
import type { FileService } from '@opengpex/editor/core/files';

import { PluginService } from './plugins';

/**
 * EditorServiceContextValue: Static services context (does not trigger frequent re-renders with state)
 */
export interface EditorServiceContextValue {
  actions: EditorActions;
  geometry: GeometryService;
  pixels: PixelService;
  layers: LayerService;
  assets: AssetService;
  /** Unified file format I/O service (decode/encode/metadata) */
  files: FileService;
  storage: StateStorage;
  clipboard: ClipboardService;
  plugins: PluginService;
  fonts: FontService;
  volatileRef: React.RefObject<VolatileState>;
  /** Current core version (from package.json, injected at build time) */
  coreVersion: string;
}

/**
 * EditorStateContextValue: Reactive state context (synchronized with React lifecycle)
 */
export interface EditorStateContextValue {
  state: EditorState;
  activeFrame: Frame | null;
  activeLayer: Layer | null;
  getSignal?: <T = boolean>(key: string, defaultValue?: T) => T;
}

/**
 * EditorContextValue: Aggregated editor context
 */
export type EditorContextValue = EditorServiceContextValue & EditorStateContextValue & {
  scoped?: {
    selfConfig: unknown;
    setSelfConfig: (patch: Record<string, unknown>) => void;
    getSignal: <T = boolean>(key: string, defaultValue?: T) => T;
    setSignal: (key: string, value: InteractionSignalValue) => void;
    toggleSignal: (key: string) => void;
    /** Set the busy state for this plugin — controls DrawerBar icon animation */
    setBusy: (busy: boolean) => void;
  };
};
