/**
 * TextOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue, Layer } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<TextOverlayCommandsMap>() */
export interface TextOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  placeCmd: CommandInstance<{ frameId: string; layer: Layer }>;
  editStartCmd: CommandInstance<{ frameId: string; layerId: string }>;
  updatePropertiesCmd: CommandInstance<{ frameId: string; layerId: string; patch: Partial<TextLayerData> }>;
  modifyCommitCmd: CommandInstance<{ frameId: string; layerId: string; patch: Partial<Layer> }>;
}

/** Type map for usePluginSignals<TextOverlaySignalsMap>() */
export interface TextOverlaySignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  editingTextLayerIdSignal: {
    value: unknown;
    set: (val: unknown) => void;
  };
}
