/**
 * LayersDrawer/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue, Layer, LayerBlendMode } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<LayersDrawerCommandsMap>() */
export interface LayersDrawerCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  reorderCmd: CommandInstance<{ frameId: string; layers: Layer[] }>;
  removeCmd: CommandInstance<{ frameId?: string; layerId?: string }>;
  visibilityCmd: CommandInstance<{ frameId?: string; layerId: string; visible: boolean }>;
  lockCmd: CommandInstance<{ frameId?: string; layerId: string; locked: boolean }>;
  renameCmd: CommandInstance<{ frameId?: string; layerId: string; name: string }>;
  syncOverlayCmd: CommandInstance<{ frameId?: string; layerId: string }>;
  addBlankLayerCmd: CommandInstance;
  duplicateLayerCmd: CommandInstance<{ layerId?: string } | undefined>;
  syncMaskCmd: CommandInstance<{ frameId?: string; layerId: string; maskId: string }>;
  setBlendModeCmd: CommandInstance<{ frameId?: string; layerId?: string; blendMode: LayerBlendMode }>;
  setLayerOpacityCmd: CommandInstance<{ frameId?: string; layerId?: string; opacity: number }>;
  setLayerFillCmd: CommandInstance<{ frameId?: string; layerId?: string; fill: number }>;
}

/** Type map for usePluginSignals<LayersDrawerSignalsMap>() */
export interface LayersDrawerSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  showSubLayersSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
