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

import { BuiltPlugin, BuiltCommand, EditorShortcut, PluginService, BuiltSignal } from '../types/plugins';
import { formatShortcut } from './utils';

export function createPluginService(): PluginService {
  const plugins = new Map<string, BuiltPlugin>();
  const commands = new Map<string, BuiltCommand>();
  const shortcuts = new Map<string, EditorShortcut>();
  const signals = new Map<string, BuiltSignal>();

  // Track which commands, shortcuts and signals belong to which plugin for cascading teardown
  const pluginAssets = new Map<string, { commands: Set<string>; shortcuts: Set<string>; signals: Set<string> }>();

  let _pluginsSnapshot: BuiltPlugin[] = [];
  let _commandsSnapshot: BuiltCommand[] = [];
  let _shortcutsSnapshot: EditorShortcut[] = [];
  let _signalsSnapshot: BuiltSignal[] = [];

  let _pluginsDirty = true;
  let _commandsDirty = true;
  let _shortcutsDirty = true;
  let _signalsDirty = true;

  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach(l => l());
  };

  const service: PluginService = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isPluginVisible: (plugin: BuiltPlugin, context: { hasActiveFrame: boolean }) => {
      if (plugin.enabled === false) return false;
      const showPolicy = plugin.show ?? 'always-show';
      if (showPolicy === 'frame-required' && !context.hasActiveFrame) {
        return false;
      }
      return true;
    },

    registerPlugin: (plugin: BuiltPlugin) => {
      // Idempotent: if the plugin is already registered, teardown its old assets first
      // This prevents signal/command collision warnings during React Strict Mode re-mounts
      if (plugins.has(plugin.uid)) {
        const oldAssets = pluginAssets.get(plugin.uid);
        if (oldAssets) {
          oldAssets.commands.forEach(cmdId => { commands.delete(cmdId); _commandsDirty = true; });
          oldAssets.shortcuts.forEach(scId => { shortcuts.delete(scId); _shortcutsDirty = true; });
          oldAssets.signals.forEach(sigId => { signals.delete(sigId); _signalsDirty = true; });
        }
      }

      plugins.set(plugin.uid, plugin);
      _pluginsDirty = true;

      const assets = { commands: new Set<string>(), shortcuts: new Set<string>(), signals: new Set<string>() };
      pluginAssets.set(plugin.uid, assets);

      // Only mount assets (commands, signals) if the plugin is enabled
      if (plugin.enabled !== false) {
        if (plugin.commands) {
          plugin.commands.forEach(cmd => {
            assets.commands.add(cmd.uid);
            service.registerCommand(cmd, false);
          });
        }

        if (plugin.signals) {
          plugin.signals.forEach(sig => {
            const targetKey = sig.scope === 'private' ? sig.uid : `shared.${sig.id}`;
            assets.signals.add(targetKey);
            service.registerSignal(sig, false);
          });
        }
      }

      notify();
    },

    unregisterPlugin: (pluginId: string) => {
      if (!plugins.has(pluginId)) return;

      const assets = pluginAssets.get(pluginId);
      if (assets) {
        assets.commands.forEach(cmdId => service.unregisterCommand(cmdId, false));
        assets.shortcuts.forEach(shortcutId => service.unregisterShortcut(shortcutId, false));
        assets.signals.forEach(sigId => service.unregisterSignal(sigId, false));
        pluginAssets.delete(pluginId);
      }

      plugins.delete(pluginId);
      _pluginsDirty = true;
      notify();
    },

    getPlugin: (pluginId: string) => plugins.get(pluginId),

    getAllPlugins: () => {
      if (_pluginsDirty) {
        _pluginsSnapshot = Array.from(plugins.values());
        _pluginsDirty = false;
      }
      return _pluginsSnapshot;
    },

    registerCommand: (command: BuiltCommand, triggerNotify = true) => {
      // Only register by uid (globally unique). Short cmd.id lookup is handled by
      // useEditorServices().executeCommand() fallback: pluginScope.uid + "." + shortId
      const key = command.uid || command.id;
      commands.set(key, command);
      _commandsDirty = true;
      if (triggerNotify) notify();
    },

    unregisterCommand: (commandId: string, triggerNotify = true) => {
      commands.delete(commandId);
      _commandsDirty = true;
      if (triggerNotify) notify();
    },

    getCommand: (commandId: string) => commands.get(commandId),

    getAllCommands: () => {
      if (_commandsDirty) {
        _commandsSnapshot = Array.from(commands.values());
        _commandsDirty = false;
      }
      return _commandsSnapshot;
    },

    registerShortcut: (shortcut: EditorShortcut, triggerNotify = true) => {
      shortcuts.set(shortcut.id, shortcut);
      _shortcutsDirty = true;
      if (triggerNotify) notify();
    },

    unregisterShortcut: (shortcutId: string, triggerNotify = true) => {
      shortcuts.delete(shortcutId);
      _shortcutsDirty = true;
      if (triggerNotify) notify();
    },

    getShortcut: (shortcutId: string) => shortcuts.get(shortcutId),

    getAllShortcuts: () => {
      if (_shortcutsDirty) {
        _shortcutsSnapshot = Array.from(shortcuts.values());
        _shortcutsDirty = false;
      }
      return _shortcutsSnapshot;
    },

    getShortcutLabel: (commandId: string, all: boolean = false) => {
      const labels = service.getShortcutLabels(commandId);
      if (labels.length === 0) return '';
      return all ? labels.join(' / ') : labels[0];
    },

    getShortcutLabels: (commandId: string) => {
      const command = commands.get(commandId);
      if (!command) return [];

      const configs = command.shortcuts || (command.shortcut ? [command.shortcut] : []);

      return configs.map(sc => formatShortcut(sc.key, {
        ctrl: sc.ctrl,
        shift: sc.shift,
        alt: sc.alt,
        meta: sc.meta,
        taps: sc.taps
      }));

    },

    registerSignal: (signal: BuiltSignal, triggerNotify = true) => {
      const targetKey = signal.scope === 'private' ? signal.uid : `shared.${signal.id}`;
      if (signals.has(targetKey)) {
        console.warn(`[PluginService] Signal name collision detected: ${targetKey}`);
      }
      signals.set(targetKey, signal);
      _signalsDirty = true;
      if (triggerNotify) notify();
    },

    unregisterSignal: (signalId: string, triggerNotify = true) => {
      signals.delete(signalId);
      _signalsDirty = true;
      if (triggerNotify) notify();
    },

    getSignal: (signalId: string) => {
      return signals.get(signalId);
    },

    getAllSignals: () => {
      if (_signalsDirty) {
        _signalsSnapshot = Array.from(signals.values());
        _signalsDirty = false;
      }
      return _signalsSnapshot;
    }
  };

  return service;
}
