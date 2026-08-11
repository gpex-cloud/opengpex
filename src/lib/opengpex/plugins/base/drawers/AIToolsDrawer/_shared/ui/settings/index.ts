/**
 * Settings UI Sub-module — Barrel re-export.
 *
 * Contains the shared infrastructure for AI model settings panels:
 *   - ModelSettings: Declarative, self-contained settings component
 *   - useModelSettings: Unified hook (config + CRUD + cache/download)
 *   - ModelSettingsShell: Layout component (legacy — use ModelSettings instead)
 *   - ModelCard: Individual model card component
 */

export { ModelSettings } from './ModelSettings';
export type { ModelSettingsProps, FileFieldDescriptor } from './ModelSettings';

export { useModelSettings } from './useModelSettings';
export type { UseModelSettingsOptions, UseModelSettingsReturn } from './useModelSettings';

export { ModelCard } from './ModelCard';
export type { ModelCardModel, ModelCardProps } from './ModelCard';
