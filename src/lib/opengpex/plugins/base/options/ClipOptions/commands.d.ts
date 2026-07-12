/**
 * ClipOptions/commands.d.ts — Auto-generated type declarations
 *
 * Provides compile-time type safety for usePluginCommands<T>() and usePluginSignals<T>().
 * Generated from commands.ts and index.tsx signal declarations.
 *
 * DO NOT EDIT MANUALLY — run `pnpm gen-plugin-types` to regenerate.
 */

import type { CommandInstance, InteractionSignalValue } from '@opengpex/editor/core/types';
import type { ClipTool } from './protocols';

/** Type map for usePluginCommands<ClipCommandsMap>() */
export interface ClipCommandsMap {
  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };
  toggleModeCmd: CommandInstance;
  cropToolCycleForwardCmd: CommandInstance;
  cropToolCycleBackwardCmd: CommandInstance;
  exitClipModeCmd: CommandInstance;
  peelCommitCmd: CommandInstance;
  reCanvasToggleCmd: CommandInstance;
  reCanvasApplyCmd: CommandInstance;
  setAspectCmd: CommandInstance<{ aspect: number | undefined }>;
  resetAspectCmd: CommandInstance;
  branchCreateCmd: CommandInstance<{ rect: DOMRect }>;
  boxResetCmd: CommandInstance;
  antiAliasToggleCmd: CommandInstance;
  cropToolSetCmd: CommandInstance<{ tool: ClipTool }>;
  drillSelectionCmd: CommandInstance;
  layerViaCopyCmd: CommandInstance;
  layerViaCutCmd: CommandInstance;
  invertSelectionCmd: CommandInstance;
  selectFromAlphaCmd: CommandInstance;
  offsetSelectionCmd: CommandInstance<{ distance: number }>;
}

/** Type map for usePluginSignals<ClipSignalsMap>() */
export interface ClipSignalsMap {
  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };
  reCanvasActiveSignal: {
    value: boolean;
    set: (val: boolean) => void;
  };
  clipFeatherValueSignal: {
    value: number;
    set: (val: number) => void;
  };
}
