/**
 * MarkerOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue, Layer, MarkerData } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<MarkerOverlayCommandsMap>() */
export interface MarkerOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  placeCmd: CommandInstance<{ frameId: string; layer: Layer }>;
  updateMarkerCmd: CommandInstance<{ frameId: string; layerId: string; patch: Partial<MarkerData> }>;
}

/** Type map for usePluginSignals<MarkerOverlaySignalsMap>() */
export interface MarkerOverlaySignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  drawingMarkerSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
}
