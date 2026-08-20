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

/**
 * UpscalerSettingsSection — Self-contained model settings for the Upscaler tool.
 *
 * Encapsulates all upscaler-specific ModelSettings configuration so that the
 * parent settings.tsx only needs to render this component without knowing
 * internal details (builtins, file fields, defaultNewModel, etc.).
 */

import { ModelSettings } from '../../_shared/ui/settings/ModelSettings';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_UPSCALE_MODELS, DEFAULT_UPSCALE_CONFIG } from '../protocols';
import type { UpscaleModelEntry } from '../protocols';

export function UpscalerSettingsSection() {
  return (
    <ModelSettings<UpscaleModelEntry>
      configKey={MODEL_TYPE_KEY}
      toolDisplayName={MODEL_TYPE_NAME}
      defaultConfig={DEFAULT_UPSCALE_CONFIG}
      builtins={BUILTIN_UPSCALE_MODELS}
      defaultNewModel={() => ({
        id: `custom-${Date.now()}`,
        name: 'Custom Upscale Model',
        modelId: '',
        size: 'Unknown',
        scale: 4,
        description: 'User-added custom upscale model',
        builtin: false,
      })}
      getFiles={(m) => [{ filename: m.onnxFile ?? 'model.onnx' }]}
      getBadge={(m) => `${m.scale}×`}
      fileFields={[{ key: 'onnxFile', label: 'ONNX', placeholder: 'model.onnx' }]}
    />
  );
}
