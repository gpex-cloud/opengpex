/**
 * PenOverlay/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';

/** Type map for usePluginCommands<PenOverlayCommandsMap>() */
export interface PenOverlayCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  penApplyMaskCmd: CommandInstance<{ feather?: number }>;
  penToSelectionCmd: CommandInstance;
  penApplyAsBezierCmd: CommandInstance;
  penUpdateDataCmd: CommandInstance<{ frameId: string; layerId: string; penData: PenPathData | null }>;
  penCancelDraftCmd: CommandInstance;
  penCreateShapeCmd: CommandInstance<PenShapeStylePayload | undefined>;
  penReleaseToDraftCmd: CommandInstance<{ frameId: string; layerId: string }>;
  penUpdateStyleCmd: CommandInstance<{
  frameId: string;
  layerId: string;
  patch: { fill?: ColorValue | null; strokeColor?: ColorValue; strokeWidth?: number };
}>;
}

/** Type map for usePluginSignals<PenOverlaySignalsMap>() */
export interface PenOverlaySignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  penPhaseSignal: {
    value: string;
    set: (val: string) => void;
  };
}
