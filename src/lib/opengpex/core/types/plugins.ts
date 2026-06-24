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

/**
 * Plugin Types: Plugin and protocol definitions
 */
import { EditorState, EditorSlot, EditorAction, InteractionSignalValue } from './state';
import { GeometryService, WorldPoint, LocalPoint, ViewportPoint } from './geometry';
import { Frame } from './models';
import type { EditorActions } from './actions';
import type { EditorContextValue } from './context';

export interface EditorShortcut {
  id: string;
  name: string;
  category: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /**
   * Number of consecutive taps required to fire this shortcut, default 1.
   *
   * When `taps > 1`, the same key (with matching modifier set) must be
   * pressed `taps` times within `tapWindowMs` of each other for `action`
   * to dispatch. Intermediate presses are swallowed via `preventDefault`
   * so a half-completed gesture doesn't leak into other listeners
   * (browser find, form fields, etc.).
   *
   * Auto-repeat (`KeyboardEvent.repeat`) is never counted as a tap, so
   * holding the key down can't be mistaken for a multi-tap.
   *
   * Why this lives on the shortcut definition (not in user-land code):
   * mirrors a common UX gesture (e.g. "double-tap A to toggle AA") in a
   * single declarative line, with the matching label automatically
   * propagated through `formatShortcut` → `shortcutLabel`.
   */
  taps?: number;
  /**
   * Max ms between consecutive taps when `taps > 1`, default 400ms.
   * 400 mirrors macOS double-click default and the de-facto "intentional
   * double-tap" range across desktop UIs; below ~250ms deliberate
   * presses get rejected, above ~500ms unrelated subsequent presses
   * start chaining into accidental fires.
   */
  tapWindowMs?: number;
  action: () => void;
  description: string;
}




export interface UIContribution {
  slot: EditorSlot;
  component: React.ComponentType<Record<string, unknown>>;
  order?: number;
  title?: string;
  icon?: React.ReactNode;
  group?: string; // Core plugins can define a group to tell TabbedSlot which category to put them in
}

export interface CommandInterceptor {
  beforeExecute?: (id: string, context: EditorContextValue) => boolean | void;
}

export interface InteractionEvent {
  nativeEvent: PointerEvent | MouseEvent | React.MouseEvent | React.PointerEvent;
  point: {
    screen: ViewportPoint;
    world: WorldPoint;
    canvas: LocalPoint;
  };
  keys: { shift: boolean; alt: boolean; meta: boolean };
  geometry: GeometryService;
  actions: EditorActions;
  state: EditorState;
  activeFrame: Frame;
}

export interface PluginManifest {
  id: string;            // Unique identifier for the plugin (e.g. base.viewport_options)
  displayName: string;   // Intuitive display name in UI
  version: string;       // Plugin version (follows SemVer specification, e.g. 1.0.0)
  description: string;   // Brief description of plugin features
  category: 'options' | 'drawers' | 'backstage' | 'panels' | 'overlays' | string; // Category
  author: string;        // Author or organization name

  // ─── Critical fields that should be established early ───
  requirements?: {
    coreVersion?: string; // Core kernel version dependency (e.g. ">=1.0.0"), prevents crash when loading plugin on older kernels
    auth?: 'none' | 'auth_required' | 'cloud_required'; // Environment requirements
    permission?: string;  // Access control permission point (e.g. "use-ai-studio"), used to trigger paywalls
  };

  // ─── Metadata reserved for future plugin marketplace ───
  links?: {
    homepage?: string;    // Plugin homepage or GitHub repository URL
    documentation?: string; // Plugin documentation URL
  };
}

export type PluginShowPolicy = 'always-show' | 'frame-required';

export interface EditorCommand<P = never, R = unknown> {
  id: string;
  name: string;
  undoable?: boolean;
  execute: (ctx: EditorContextValue, payload: P) => R;
  shortcut?: Omit<EditorShortcut, 'id' | 'name' | 'category' | 'action' | 'description'>;
  shortcuts?: Omit<EditorShortcut, 'id' | 'name' | 'category' | 'action' | 'description'>[];
}

export interface BuiltCommand<P = never, R = unknown> extends EditorCommand<P, R> {
  uid: string;
}

/**
 * CommandInstance: Command instance bound to current editor context at runtime
 */
export interface CommandInstance<P = void, R = void> {
  readonly name: string;
  execute: [P] extends [void] ? (payload?: never) => R : [unknown] extends [P] ? (payload?: unknown) => R : (payload: P) => R;
  readonly shortcutLabel: string;
}

export interface EditorSignal {
  id: string;
  name: string;
  defaultValue: InteractionSignalValue;
  scope: 'private' | 'public';
}

export interface BuiltSignal extends EditorSignal {
  uid: string;
}

export interface InteractionHandler {
  id: string;
  priority: number;
  test: (e: InteractionEvent) => boolean;
  onStart: (e: InteractionEvent) => void;
  onMove: (e: InteractionEvent) => void;
  onEnd: (e: InteractionEvent) => unknown;
}

export interface EditorPlugin {
  // --- 1. Identity & Metadata ---
  manifest: PluginManifest;
  sourceType?: 'base' | 'community' | 'user' | string;
  _folderName?: string;

  // --- 2. Layout & UI ---
  slot: EditorSlot;
  show?: PluginShowPolicy;
  icon?: React.ReactNode;
  order?: number;
  side?: 'left' | 'right';

  // --- 3. Functional Properties ---
  component: React.ComponentType<Record<string, unknown>>;
  initialConfig?: Record<string, unknown>;
  commands?: EditorCommand<never, unknown>[];
  signals?: EditorSignal[];
  contributions?: UIContribution[];
  interceptors?: {
    command?: CommandInterceptor;
  };
  /** Interaction handler provided by plugin (Interaction v2.0) */
  interactions?: InteractionHandler[];
  onAction?: (action: EditorAction, state: EditorState, actions: EditorActions) => void;
  deprecated?: boolean | string;

  // Lifecycle
  onInit?: (ctx: EditorContextValue) => void;
  onDestroy?: (ctx: EditorContextValue) => void;
}

export interface BuiltPlugin extends Omit<EditorPlugin, 'commands' | 'signals'> {
  uid: string; // Unique ID (author.short_id)
  group: string;
  enabled: boolean;
  commands?: BuiltCommand[];
  signals?: BuiltSignal[];
}

export interface PluginService {
  subscribe(listener: () => void): () => void;
  isPluginVisible(plugin: BuiltPlugin, context: { hasActiveFrame: boolean }): boolean;
  registerPlugin(plugin: BuiltPlugin): void;
  unregisterPlugin(pluginId: string): void;
  getPlugin(pluginId: string): BuiltPlugin | undefined;
  getAllPlugins(): BuiltPlugin[];

  registerCommand(command: BuiltCommand, triggerNotify?: boolean): void;
  unregisterCommand(commandId: string, triggerNotify?: boolean): void;
  getCommand(commandId: string): BuiltCommand | undefined;
  getAllCommands(): BuiltCommand[];

  registerShortcut(shortcut: EditorShortcut, triggerNotify?: boolean): void;
  unregisterShortcut(shortcutId: string, triggerNotify?: boolean): void;
  getShortcut(shortcutId: string): EditorShortcut | undefined;
  getAllShortcuts(): EditorShortcut[];

  getShortcutLabel(commandId: string, all?: boolean): string;
  getShortcutLabels(commandId: string): string[];

  registerSignal(signal: BuiltSignal, triggerNotify?: boolean): void;
  unregisterSignal(signalId: string, triggerNotify?: boolean): void;
  getSignal(signalId: string): BuiltSignal | undefined;
  getAllSignals(): BuiltSignal[];
}
