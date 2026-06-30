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

/* eslint-disable react-hooks/refs */
/* eslint-disable react-hooks/immutability */

import React, {
  createContext,
  useContext,
  useMemo,
  ReactNode,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import {
  EditorContextValue,
  EditorStateContextValue,
  EditorServiceContextValue,
  BuiltPlugin,
  CommandInstance,
  InteractionSignalValue,
  VolatileInteraction,
  Layer,
  Frame,
} from "@opengpex/editor/core/types";
import { createAssetService } from "@opengpex/editor/core/storage/asset/AssetService";
import { createStateStorage } from "@opengpex/editor/core/storage/state/StateStorage";

import { useEditorStore } from "@opengpex/editor/core/state/useEditorStore";
import { createGeometryService } from "@opengpex/editor/core/geometry";
import { createPixelService } from "@opengpex/editor/core/engine";
import { createWorkerProxy } from "@opengpex/editor/core/engine/WorkerProxy";
import { createLayerService } from "@opengpex/editor/core/layer";
import { createClipboardService } from "@opengpex/editor/core/clipboard/ClipboardService";
import {
  useLayerSync as useCoreLayerSync,
  useViewportSync as useCoreViewportSync,
  useOverlayRotationSync as useCoreOverlayRotationSync,
} from "@opengpex/editor/core/motion/hooks/animation";
import { createPluginService } from "@opengpex/editor/core/plugin";
import { createFontService } from "@opengpex/editor/core/fonts";
import { CORE_VERSION } from "@opengpex/editor/core/plugin/version";
import "../../index.css";

export * from "@opengpex/editor/core/state/useVolatileState";

/* ==========================================================================
   SECTION 1: Context Declarations
   ========================================================================== */

/**
 * EditorContext: Global editor context
 * Uses a separate static/dynamic context architecture to optimize high-frequency re-rendering performance:
 * - EditorStateContext: Contains the high-frequency changing Reducer State (e.g., activeFrame, activeLayer).
 * - EditorServiceContext: Contains singleton static services and facades (does not trigger React re-rendering).
 */
export const EditorStateContext = createContext<
  EditorStateContextValue | undefined
>(undefined);
export const EditorServiceContext = createContext<
  EditorServiceContextValue | undefined
>(undefined);

// Local environment context of the plug-in, used to locate the currently rendering plug-in instance
export const PluginContext = createContext<BuiltPlugin | null>(null);

/* ==========================================================================
   SECTION 2: Core EditorProvider Component
   ========================================================================== */

export function EditorProvider({ children }: { children: ReactNode }) {
  // 1. Integration of core state and logic (Zustand / Reducer Store)
  const {
    state,
    dispatch,
    actions,
    activeFrame,
    activeLayer,
    volatileRef,
    contextValueRef,
    isHydrated,
  } = useEditorStore();

  // 2. Initialization of pure static singleton services (does not re-render with any state, unique within the lifecycle)
  const geometry = useMemo(() => createGeometryService(), []);
  const assets = useMemo(() => createAssetService(), []);
  const processor = useMemo(() => createWorkerProxy(), []);
  const pixels = useMemo(
    () => createPixelService(geometry, assets, processor),
    [geometry, assets, processor],
  );
  const layers = useMemo(
    () => createLayerService(geometry, pixels, assets, actions, () => state),
    [geometry, pixels, assets, actions, state],
  );
  const storage = useMemo(() => createStateStorage(assets), [assets]);
  const clipboard = useMemo(() => createClipboardService(), []);
  const plugins = useMemo(() => createPluginService(), []);
  const fonts = useMemo(() => createFontService(), []);

  // 3. Construct split static/dynamic context values
  const stateContextValue = useMemo(
    () => ({
      state,
      activeFrame,
      activeLayer,
    }),
    [state, activeFrame, activeLayer],
  );

  const serviceContextValue = useMemo(
    () => ({
      actions,
      geometry,
      pixels,
      layers,
      assets,
      storage,
      clipboard,
      plugins,
      fonts,
      volatileRef,
      coreVersion: CORE_VERSION,
    }),
    [
      actions,
      geometry,
      pixels,
      layers,
      assets,
      storage,
      clipboard,
      plugins,
      fonts,
      volatileRef,
    ],
  );

  // Synchronize context reference to ensure internal Store logic can access the complete Facade
  contextValueRef.current = {
    ...stateContextValue,
    ...serviceContextValue,
  } as EditorContextValue;

  // 4. Environment-side side effects (Environment Side Effects)

  // 4.1 Core bootstrapping and persistent recovery (Bootstrap & Hydration)
  const sysCommandsRegistered = useRef(false);
  useEffect(() => {
    async function init() {
      // Timeout guard: Prevents permanent hang if IndexedDB connection is stale
      // (e.g., page restored from bfcache, multi-tab lock, or storage corruption)
      const RESTORE_TIMEOUT_MS = 2500;
      let savedState: Awaited<ReturnType<typeof storage.restore>> = null;

      try {
        savedState = await Promise.race([
          storage.restore(),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("RESTORE_TIMEOUT")), RESTORE_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === "RESTORE_TIMEOUT";
        console.warn(
          isTimeout
            ? "[EditorProvider] IndexedDB restore timed out. Loading empty workspace."
            : "[EditorProvider] State restore failed. Loading empty workspace.",
          err,
        );
        savedState = null;
      }

      if (savedState) {
        dispatch({ type: "HYDRATE", payload: savedState });
      } else {
        dispatch({ type: "SET_LOADED", payload: true });
      }

      isHydrated.current = true;

      // Font hydration: restore cached fonts from IndexedDB (non-blocking, fire-and-forget)
      fonts.hydrate().catch((e) => {
        console.warn("[EditorProvider] Font hydration failed (non-fatal):", e);
      });

      // Register advanced system global commands
      if (!sysCommandsRegistered.current) {
        sysCommandsRegistered.current = true;
        import("../advanced").then(({ registerAdvancedCommands }) => {
          const ctx = contextValueRef.current;
          if (!ctx) return;

          registerAdvancedCommands(ctx.actions);
          const statuses = ctx.pixels.utils.probeEngines();
          ctx.actions.setEngineStatus(statuses);
        });
      }
    }
    init();
  }, [dispatch, isHydrated, contextValueRef, storage, fonts]);

  // 4.2 Auto-save debouncing (Auto-Save)
  useEffect(() => {
    if (!state.isLoaded || !isHydrated.current) return;
    const timer = setTimeout(() => storage.save(state), 200);
    return () => clearTimeout(timer);
  }, [state, isHydrated, storage]);

  // 4.3 Browser global behavior correction (Environmental Fixes)
  useEffect(() => {
    const handleGlobalWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };

    const handleGlobalPaste = (e: ClipboardEvent) => {
      const ctx = contextValueRef.current;
      if (!ctx) return;
      // Allow paste even without activeFrame — the paste command handles
      // creating a new frame from clipboard when no frame is open.
      ctx.actions.adv.layer.clip.paste.execute({ e });
    };

    document.addEventListener("wheel", handleGlobalWheel, { passive: false });
    document.addEventListener("paste", handleGlobalPaste);

    return () => {
      document.removeEventListener("wheel", handleGlobalWheel);
      document.removeEventListener("paste", handleGlobalPaste);
      pixels.cache.clear();
    };
  }, [pixels.cache, contextValueRef]);

  return (
    <EditorServiceContext.Provider value={serviceContextValue}>
      <EditorStateContext.Provider value={stateContextValue}>
        {children}
      </EditorStateContext.Provider>
    </EditorServiceContext.Provider>
  );
}

/* ==========================================================================
   SECTION 3: Static Service Hooks (ReadOnly & Non-Reactive)
   ========================================================================== */

/**
 * useEditorServices: Gets static editor services/command bus (components calling this hook do not re-render due to state changes)
 *
 * [Reference Stability Guarantee]
 * The reference to the `actions` property in the returned object is stable (will not be rebuilt due to changes in other services in the context).
 * This means plug-in developers can safely put `actions` in the useEffect/useCallback dependency arrays,
 * without triggering an infinite loop. This is not a hack, but because actions themselves are pure command dispatchers,
 * whose behavior indirectly accesses the latest context via refs, equivalent to Redux's dispatch reference stability contract.
 */
export function useEditorServices() {
  const context = useContext(EditorServiceContext);
  const pluginScope = useContext(PluginContext);

  if (!context)
    throw new Error("useEditorServices must be used within EditorProvider");

  // Maintain reference to the latest context, used for scope resolution to access plugins service
  const contextRef = useRef(context);
  contextRef.current = context;

  // Create a stable scoped executeCommand (only depends on pluginScope?.uid, unchanged after mounting)
  const scopedExecuteCommand = useMemo(() => {
    return <P = unknown, R = unknown>(id: string, payload?: P): R => {
      const ctx = contextRef.current!;
      const uid = pluginScope?.uid;
      const targetId = (uid && ctx.plugins.getCommand(id))
        ? id
        : `${uid || ""}.${id}`;
      return ctx.actions.executeCommand(targetId, payload);
    };
  }, [pluginScope?.uid]);

  // Stable scoped actions object: base actions (from useEditorStore, stable) + scoped executeCommand (stable)
  const scopedActions = useMemo(
    () => ({
      ...context.actions,
      executeCommand: scopedExecuteCommand,
    }),
    [context.actions, scopedExecuteCommand],
  );

  // Return the scoped service object
  // Note: the outer object may be rebuilt due to context changes (e.g., when geometry or other services update),
  // but the result.actions reference is always stable — this is the design intent.
  const scopedService = useMemo(
    () => ({
      ...context,
      actions: scopedActions,
    }),
    [context, scopedActions],
  );

  // No plug-in scope -> directly return context (where actions is already a stable reference from useEditorStore)
  if (!pluginScope) return context;

  return scopedService;
}

/**
 * usePluginCommands: Gets all available execution commands in the current plug-in scope (automatically derives short ID names and injects the fid closure)
 */
export function usePluginCommands<
  T extends Record<
    string,
    { execute: (payload: never) => unknown; readonly shortcutLabel: string }
  > = Record<string, CommandInstance<unknown, unknown>>,
>(): T {
  const scope = useContext(PluginContext);
  const { actions, plugins } = useEditorServices();

  return useMemo(() => {
    if (!scope || !scope.commands) return {} as T;

    const commandMap = {} as Record<
      string,
      {
        execute: (payload?: unknown) => unknown;
        readonly shortcutLabel: string;
      }
    >;

    scope.commands.forEach((cmd) => {
      const fullId = cmd.id;

      // 1. Tokenize cmd.id by delimiters (., -, _) and filter out empty characters
      const words = fullId.split(/[._-]/).filter(Boolean);

      // 2. Remove "cmd" from the beginning (case-insensitive, if present)
      if (words.length > 0 && words[0].toLowerCase() === "cmd") {
        words.shift();
      }

      // 3. Assemble into camelCase and append "Cmd" suffix
      const camelId =
        words.length > 0
          ? words
              .map((word, index) =>
                index === 0
                  ? word.toLowerCase()
                  : word.charAt(0).toUpperCase() + word.slice(1),
              )
              .join("")
          : "cmd";
      const cmdKey = `${camelId}Cmd`;

      const commandObj = {
        execute: (payload?: unknown) => {
          return actions.executeCommand(cmd.uid, payload);
        },
        get name() {
          return plugins.getCommand(cmd.uid)?.name || cmd.id;
        },
        get shortcutLabel() {
          return plugins.getShortcutLabel(cmd.uid, true);
        },
      };

      commandMap[fullId] = commandObj;
      commandMap[cmdKey] = commandObj;
    });

    return commandMap as unknown as T;
  }, [scope, actions, plugins]);
}

/**
 * usePluginSignals: Gets all available signals in the current plug-in scope (automatically derives shorthand camelCase names and links namespace key-value pairs)
 */
export function usePluginSignals<
  T extends Record<
    string,
    {
      value: InteractionSignalValue;
      set: (val: InteractionSignalValue) => void;
    }
  > = Record<
    string,
    {
      value: InteractionSignalValue;
      set: (val: InteractionSignalValue) => void;
    }
  >,
>(): T {
  const scope = useContext(PluginContext);
  const { state } = useEditorState();
  const { actions } = useEditorServices();

  return useMemo(() => {
    if (!scope || !scope.signals) return {} as T;

    const signalMap = {} as Record<
      string,
      {
        value: InteractionSignalValue;
        set: (val: InteractionSignalValue) => void;
      }
    >;

    scope.signals.forEach((sig) => {
      const fullId = sig.uid;

      // 1. Tokenize sig.id by delimiters (., -, _) and filter out empty characters
      const words = sig.id.split(/[._-]/).filter(Boolean);

      // 2. Remove "signal" from the beginning (case-insensitive, if present)
      if (words.length > 0 && words[0].toLowerCase() === "signal") {
        words.shift();
      }

      // 3. Assemble into camelCase and append "Signal" suffix as key name
      const camelName =
        words.length > 0
          ? words
              .map((word, index) =>
                index === 0
                  ? word.toLowerCase()
                  : word.charAt(0).toUpperCase() + word.slice(1),
              )
              .join("")
          : "signal";
      const sigKey = `${camelName}Signal`;

      const controller = {
        get value() {
          return state.getStateSignal(fullId, sig.defaultValue);
        },
        set: (val: InteractionSignalValue) => {
          actions.setStateSignal(fullId, val);
        },
      };

      signalMap[sig.id] = controller;
      signalMap[sigKey] = controller;
    });

    return signalMap as unknown as T;
  }, [scope, state, actions]);
}

export function usePluginList(): BuiltPlugin[] {
  const { plugins } = useEditorServices();

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return plugins.subscribe(onStoreChange);
    },
    [plugins],
  );

  const getSnapshot = useCallback(() => {
    return plugins.getAllPlugins();
  }, [plugins]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * usePluginSelfBusy: Gets the busy status of the current plugin scope reactively.
 */
export function usePluginSelfBusy(): boolean {
  const scope = useContext(PluginContext);
  const { plugins } = useEditorServices();

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return plugins.subscribe(onStoreChange);
    },
    [plugins],
  );

  const getSnapshot = useCallback(() => {
    if (!scope?.uid) return false;
    return plugins.isBusy(scope.uid);
  }, [plugins, scope]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}


/* ==========================================================================
   SECTION 4: Dynamic Runtime State Hooks (Reactive Subscriptions)
   ========================================================================== */

/**
 * useEditorState: Subscribes and gets the current active viewport, active layer, and the editor's full Reducer State
 */
export function useEditorState() {
  const context = useContext(EditorStateContext);
  const pluginScope = useContext(PluginContext);

  if (!context)
    throw new Error("useEditorState must be used within EditorProvider");

  return useMemo(() => {
    if (!pluginScope) return context;

    return {
      ...context,
      getSignal: <T = boolean,>(key: string, defaultValue?: T): T => {
        const targetKey = key.startsWith(pluginScope.uid)
          ? key
          : `${pluginScope.uid}.${key}`;
        return context.state.getStateSignal(targetKey, defaultValue);
      },
    };
  }, [context, pluginScope]);
}

/**
 * usePluginConfig: Explicitly gets the dynamic configuration for a specific plug-in ID
 * @param pluginId Unique identifier of the plug-in (uid)
 */
export function usePluginConfig<T>(
  pluginId: string,
): [T, (patch: Partial<T>) => void] {
  const { state } = useEditorState();
  const { actions } = useEditorServices();
  const pluginList = usePluginList();

  const config = useMemo(() => {
    const plugin = pluginList.find((p) => p.uid === pluginId);
    const resolvedId = plugin ? plugin.uid : pluginId;
    return {
      ...(plugin?.initialConfig || {}),
      ...(state.pluginConfig[resolvedId] || {}),
    } as T;
  }, [pluginList, state.pluginConfig, pluginId]);

  const setConfig = (patch: Partial<T>) => {
    const plugin = pluginList.find((p) => p.uid === pluginId);
    const resolvedId = plugin ? plugin.uid : pluginId;
    actions.updatePluginConfig(resolvedId, patch);
  };

  return [config, setConfig];
}

/**
 * usePluginSelfConfig: Gets the dynamic configuration in the component's own plug-in scope (zero-argument, supports adaptive Context resolution)
 */
export function usePluginSelfConfig<T>(): [T, (patch: Partial<T>) => void] {
  const scope = useContext(PluginContext);
  if (!scope?.uid) {
    throw new Error(
      "usePluginSelfConfig was called outside of a PluginContext Provider.",
    );
  }
  return usePluginConfig<T>(scope.uid);
}

/**
 * usePluginResource: Unified resource reference Hook
 * Inside a plug-in, use this Hook to reference resource files (images, fonts, docs, etc.) in the plug-in directory.
 * No need to worry about whether running on static or dynamic track, the framework automatically adapts the path.
 *
 * @param relativePath - Resource path relative to the plug-in root directory, e.g., 'media/icon.png' or 'docs/help.pdf'
 * @returns Full URL that can be directly used in attributes like <img src>
 *
 * @example
 * ```tsx
 * const icon = usePluginResource('icons/logo.svg');
 * return <img src={icon} />;
 * ```
 */
export function usePluginResource(relativePath: string): string {
  const scope = useContext(PluginContext);
  if (!scope) {
    throw new Error("usePluginResource must be called within a plugin component (PluginContext Provider).");
  }
  // Use _folderName (injected by registry/init) for serve API path resolution
  const folderName = (scope as unknown as { _folderName?: string })._folderName || scope.uid;
  return `/api/plugins/serve/${folderName}/${relativePath}`;
}

/* ==========================================================================
   SECTION 5: Motion & Sync Master Hooks (Context Aware)
   ========================================================================== */

export function useLayerSync(
  ref: React.RefObject<HTMLElement | null>,
  layer: Layer,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraVars?: Record<string, any>,
) {
  const { volatileRef } = useEditorServices();
  return useCoreLayerSync(ref, layer, volatileRef, extraVars);
}

export function useViewportSync(
  stageRef: React.RefObject<HTMLElement | null>,
  artboardRef: React.RefObject<HTMLElement | null>,
  frame: Frame,
) {
  const { volatileRef } = useEditorServices();
  return useCoreViewportSync(stageRef, artboardRef, frame, volatileRef);
}

export function useOverlayRotationSync(
  ref: React.RefObject<HTMLElement | null>,
  frame: Frame | null,
) {
  return useCoreOverlayRotationSync(ref, frame);
}

/* ==========================================================================
   SECTION 6: Volatile Interaction Hooks (Fast-Track Subscriptions)
   ========================================================================== */

/**
 * useVolatileInteraction: Subscribe to a specific field of the Volatile Interaction Store.
 * Only triggers a re-render when the subscribed field changes — NOT on every state update.
 *
 * This is the recommended way to read high-frequency interaction data
 * (hover, cursor, HUD) in React components without causing global re-renders.
 *
 * @example
 * ```tsx
 * const hoveredId = useVolatileInteraction('hoveredLayerId');
 * const cursor = useVolatileInteraction('cursorOverride');
 * ```
 *
 * @see docs/opengpex/20260630_interaction_state_volatile_migration_spec.md
 */
export function useVolatileInteraction<K extends keyof VolatileInteraction>(
  key: K,
): VolatileInteraction[K] {
  const { actions, volatileRef } = useEditorServices();

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return actions.fast.subscribeInteraction(key, onStoreChange);
    },
    [actions, key],
  );

  const getSnapshot = useCallback(() => {
    return volatileRef.current.interaction[key];
  }, [volatileRef, key]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
