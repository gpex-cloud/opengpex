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
 * InpaintEraserSettingsSection — Self-contained model settings for the Smart Eraser tool.
 */

import { ModelSettings } from '../../../_shared/ui/settings/ModelSettings';
import { MODEL_TYPE_KEY, MODEL_TYPE_NAME, BUILTIN_ERASER_MODELS, DEFAULT_INPAINT_ERASER_CONFIG } from '../protocols';
import type { InpaintEraserModelEntry } from '../protocols';

export function InpaintEraserSettingsSection() {
  return (
    <ModelSettings<InpaintEraserModelEntry>
      configKey={MODEL_TYPE_KEY}
      toolDisplayName={MODEL_TYPE_NAME}
      defaultConfig={DEFAULT_INPAINT_ERASER_CONFIG}
      builtins={BUILTIN_ERASER_MODELS}
      defaultNewModel={() => ({
        id: `custom-${Date.now()}`,
        name: 'Custom Inpaint Model',
        modelId: '',
        size: 'Unknown',
        description: 'User-added custom inpainting model',
        builtin: false,
        inputSize: 512,
      })}
      getFiles={(m) => [{ filename: m.onnxFile ?? 'lama_fp32.onnx', expectedBytes: m.expectedBytes }]}
      fileFields={[
        { key: 'onnxFile', label: 'ONNX', placeholder: 'lama_fp32.onnx', suffix: (m) => `${m.inputSize}×${m.inputSize}` },
      ]}
      customModelHint="Model must accept [1, 3, H, W] image + [1, 1, H, W] mask inputs"
    />
  );
}
