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

import { useEffect } from 'react';
import { PLUGINS as CORE_PLUGINS } from '@opengpex/editor/core/plugin/registry';
import { PLUGINS as USER_PLUGINS } from '@opengpex/editor/plugins/registry-user';
import { EditorPlugin, BuiltPlugin, EditorCommand, BuiltCommand, EditorActions, EditorSignal, PluginManifest } from '@opengpex/editor/core/types';
import { CORE_VERSION, satisfiesCoreVersion } from '@opengpex/editor/core/plugin/version';
import { IS_CLOUD_MODE } from '@opengpex/editor/core/helpers/config';

/**
 * usePluginInit: Plugin system initialization
 * Manages the lifecycle of the plugin system, hotkeys, and global services.
 * Completely decoupled from UI.
 */
export function usePluginInit(actions: EditorActions) {
    useEffect(() => {
        // Safe Mode check: if ?safe-mode=true is in the URL, only load official core plugins
        const isSafeMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('safe-mode') === 'true';

        // In Safe Mode, we load all official core plugins (base + community) but skip user/dynamic plugins
        const activeCorePlugins = CORE_PLUGINS as EditorPlugin[];

        if (isSafeMode) {
            console.warn('⚠️ [OpenGPEX Safe Mode] Safe mode is active. Only official core plugins are loaded.');
        }

        // Load user-enabled plugins map from localStorage
        let enabledUserPlugins: Record<string, boolean> = {};
        try {
            const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('gpex_enabled_user_plugins') : null;
            if (stored) enabledUserPlugins = JSON.parse(stored);
        } catch { }

        // Helper to calculate UID at runtime
        const getPluginUid = (manifest: Partial<PluginManifest> | undefined, folderName: string): string => {
            const rawAuthor = manifest?.author || 'anonymous';
            const author = rawAuthor.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
            const manifestId = manifest?.id || folderName;
            return `${author}.${manifestId}`;
        };

        // Helper to calculate Group prefix at runtime
        const getPluginGroup = (sourceType?: string): string => {
            return `gpex.plugins.${sourceType || 'user'}.`;
        };

        // Define a helper function to register a single plugin
        const registerSinglePlugin = (rawPlugin: EditorPlugin) => {
            if (!rawPlugin) {
                console.warn(`[PluginInit] Plugin is undefined.`);
                return;
            }

            if (!rawPlugin.manifest?.id || !rawPlugin.manifest?.author) {
                console.error(
                    `❌ [PluginInit] Plugin in folder "${rawPlugin._folderName || 'unknown'}" is missing required manifest fields 'id' or 'author'. ` +
                    `Registration skipped.`
                );
                return;
            }

            const folderName = rawPlugin._folderName || '';
            const uid = getPluginUid(rawPlugin.manifest, folderName);
            const group = getPluginGroup(rawPlugin.sourceType);

            // 🛡️ Version Gate: Verify if plugin's coreVersion requirement is met by current kernel version
            const requiredCore = rawPlugin.manifest?.requirements?.coreVersion;
            if (requiredCore && !satisfiesCoreVersion(requiredCore)) {
                console.warn(
                    `[PluginInit] Plugin "${uid}" requires core ${requiredCore}, ` +
                    `but current core is ${CORE_VERSION}. Plugin will not be loaded.`
                );
                return;
            }

            // User plugins default to DISABLED — strictly check standard uid
            const isEnabled = rawPlugin.sourceType === 'user'
                ? !!enabledUserPlugins[uid]
                : true;

            const sanitizedPlugin: BuiltPlugin = {
                ...rawPlugin,
                uid: uid,
                group: group,
                enabled: isEnabled,
                manifest: {
                    ...rawPlugin.manifest,
                    id: rawPlugin.manifest?.id || folderName,
                    displayName: rawPlugin.manifest?.displayName || folderName,
                    category: rawPlugin.manifest?.category || 'user',
                    author: rawPlugin.manifest?.author || 'anonymous'
                },
                commands: rawPlugin.commands?.map((cmd: EditorCommand) => ({
                    ...cmd,
                    uid: `${uid}.${cmd.id}`
                })),
                signals: rawPlugin.signals?.map((sig: EditorSignal) => ({
                    ...sig,
                    uid: `${uid}.${sig.id}`
                }))
            } as BuiltPlugin;

            try {
                actions.registerPlugin(sanitizedPlugin);

                // Register commands and associate shortcuts only if enabled
                if (isEnabled) {
                    sanitizedPlugin.commands?.forEach((cmd: BuiltCommand) => {
                        actions.registerCommand(cmd);

                        const shortcutConfigs = cmd.shortcuts || (cmd.shortcut ? [cmd.shortcut] : []);
                        shortcutConfigs.forEach((sc, idx) => {
                            actions.registerShortcut({
                                id: shortcutConfigs.length > 1 ? `${cmd.uid}-${idx}` : cmd.uid,
                                name: cmd.name,
                                category: sanitizedPlugin.manifest?.category || 'General',
                                ...sc,
                                action: () => actions.executeCommand(cmd.uid),
                                description: cmd.name
                            });
                        });
                    });
                }
            } catch (err) {
                console.error(`[PluginInit] Failed to initialize plugin: ${uid}`, err);
            }
        };

        // 1. First register CORE_PLUGINS (sequential order)
        activeCorePlugins.forEach((p) => registerSinglePlugin(p));

        // 2. Then register USER_PLUGINS (skip entirely in Safe Mode)
        if (!isSafeMode) {
            const activeUserPlugins = USER_PLUGINS as EditorPlugin[];
            activeUserPlugins.forEach((p) => registerSinglePlugin(p));
        }

        // 2. Load dynamic user plugins
        const loadUserPlugins = async () => {
            try {
                // Expose shared modules on window.__GPEX__ for dynamic plugins to consume
                if (typeof window !== 'undefined') {
                    const gpex = ((window as unknown as Record<string, unknown>).__GPEX__ || {}) as Record<string, unknown>;
                    (window as unknown as Record<string, unknown>).__GPEX__ = gpex;

                    gpex['react'] = await import('react');
                    gpex['react/jsx-runtime'] = await import('react/jsx-runtime');
                    gpex['react-dom'] = await import('react-dom');
                    gpex['lucide-react'] = await import('lucide-react');

                    // Expose editor public API modules for plugin consumption
                    gpex['@opengpex/editor/core/context'] = await import('@opengpex/editor/core/context');
                    gpex['@opengpex/editor/core/types'] = await import('@opengpex/editor/core/types');
                    gpex['@opengpex/editor/widgets/ActionButton'] = await import('@opengpex/editor/widgets/ActionButton');
                    gpex['@opengpex/editor/widgets/FunctionButton'] = await import('@opengpex/editor/widgets/FunctionButton');
                    gpex['@opengpex/editor/widgets/ColorPicker'] = await import('@opengpex/editor/widgets/ColorPicker');
                    gpex['@opengpex/editor/widgets/Switch'] = await import('@opengpex/editor/widgets/Switch');
                }

                const response = await fetch('/api/plugins/list');
                const data = (await response.json()) as { success: boolean; plugins?: { folderName: string; manifest: PluginManifest }[]; error?: string };
                if (!data.success) {
                    console.error('[PluginInit] Failed to fetch dynamic plugins list:', data.error);
                    return;
                }

                const userPlugins = data.plugins || [];

                for (const p of userPlugins) {
                    const folderName = p.folderName;
                    try {
                        // 1. 🛡️ De-publicize paths, reading sandbox code dynamically from backend proxy routes
                        const moduleUrl = `/api/plugins/serve/${folderName}/dist/index.js`;
                        // We use a template string approach to avoid bundler static resolution
                        const pluginModule = (await import(/* webpackIgnore: true */ moduleUrl)) as { plugin?: EditorPlugin };

                        if (pluginModule.plugin) {
                            registerSinglePlugin({
                                ...pluginModule.plugin,
                                sourceType: 'user',
                                _folderName: folderName
                            });
                        }
                    } catch (err) {
                        console.error(`[PluginInit] Failed to load dynamic plugin ${folderName}:`, err);
                    }
                }
            } catch (err) {
                console.error('[PluginInit] Dynamic plugin system initialization failed:', err);
            }
        };

        if (!isSafeMode && !IS_CLOUD_MODE) {
            loadUserPlugins();
        }

        // 3. Cleanup function: unregister all plugins when component unmounts (cascading cleanup for commands/shortcuts/signals)
        return () => {
            activeCorePlugins.forEach((p) => {
                const uid = getPluginUid(p.manifest, p.manifest.id);
                actions.unregisterPlugin(uid);
            });
            if (!isSafeMode) {
                const activeUserPlugins = USER_PLUGINS as unknown as (EditorPlugin & { sourceType?: string; _folderName?: string })[];
                activeUserPlugins.forEach((p) => {
                    const uid = getPluginUid(p.manifest, p._folderName || p.manifest.id);
                    actions.unregisterPlugin(uid);
                });
            }
        };
    }, [actions]);
}
