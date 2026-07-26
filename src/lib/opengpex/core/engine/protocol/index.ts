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

/**
 * protocol/ barrel export — all cross-thread protocol types.
 */

export type {
  MatrixData,
  WorldMatrix,
  LayerDescriptor,
  BitmapMaskDescriptor,
} from './descriptors';
export { asWorldMatrix, translateToRoi } from './descriptors';

export type {
  CompositeJob,
  FilterJob,
  ResampleJob,
  RasterizeJob,
  DecodeJob,
  EnsureAssetJob,
  FileIoJob,
  Job,
} from './jobs';

export type { PixelResultData } from './results';

export type {
  DrawLayerOptions,
  RenderLayerCommand,
  RenderCommand,
  IRenderer,
} from './IRenderer';

export type {
  FilterDescriptor,
  FilterType,
  FilterKind,
  FilterInput,
  FilterApplyOptions,
  HighResPixelBuffer,
  IFilter,
  BrightnessFilter,
  ContrastFilter,
  SaturationFilter,
  HueRotateFilter,
  BlurFilter,
  CurvesFilter,
  LevelsFilter,
  ChannelMixFilter,
  CustomFilter,
  CurvePoints,
  CurvesData,
  LevelsData,
  ChannelMixData,
} from './IFilter';
export { classifyFilter, hasNeighborhoodFilter } from './IFilter';
