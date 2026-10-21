import { JSON_SCHEMA, load } from 'js-yaml';
import type { CmakeDimension } from '@/common/types/cmake';

export type ResolvedVariants = {
  selection: Record<string, string>;
  settings: Record<string, string | number | boolean>;
  env: Record<string, string>;
  buildType?: string;
};
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const managedSettings =
  /^(?:CMAKE_(?:GENERATOR.*|HOME_DIRECTORY|CACHEFILE_DIR|SOURCE_DIR|BINARY_DIR|C_COMPILER.*|CXX_COMPILER.*|MAKE_PROGRAM|EXPORT_COMPILE_COMMANDS|TOOLCHAIN_FILE))$/;
export const isPrivateEnvironment = (key: string): boolean => /^AIONUI_.*(?:TOKEN|PORT)/i.test(key);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('cmake.invalidVariants: expected mapping');
  return value as Record<string, unknown>;
}
function text(value: unknown, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.trim()) ||
    value.length > 8192 ||
    value.includes('\0') ||
    /[\r\n]/.test(value)
  )
    throw new Error('cmake.invalidVariants: invalid string');
  return value;
}
function keysOnly(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`cmake.unsupportedVariants: ${key}`);
}

/** Parse the bounded CMake Tools variant subset without executing YAML tags. */
export function parseVariants(source: string | undefined): CmakeDimension[] {
  if (source === undefined)
    return [
      {
        name: 'buildType',
        label: 'buildType',
        defaultChoice: 'Debug',
        choices: ['Debug', 'Release'].map((id) => ({ id, label: id, buildType: id, settings: {}, env: {} })),
      },
    ];
  if (Buffer.byteLength(source) > 262144) throw new Error('cmake.invalidVariants: file too large');
  const root = record(load(source, { schema: JSON_SCHEMA }));
  if (!Object.keys(root).length || Object.keys(root).length > 20)
    throw new Error('cmake.invalidVariants: dimension count');
  return Object.entries(root).map(([name, raw]) => {
    if (!keyPattern.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
      throw new Error('cmake.invalidVariants: dimension name');
    const dimension = record(raw);
    keysOnly(dimension, ['default', 'choices', 'short', 'long']);
    const entries = Object.entries(record(dimension.choices));
    if (!entries.length || entries.length > 100) throw new Error('cmake.invalidVariants: choice count');
    const choices = entries.map(([id, rawChoice]) => {
      text(id);
      const choice = record(rawChoice);
      keysOnly(choice, ['short', 'long', 'buildType', 'settings', 'env']);
      const settings: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(choice.settings === undefined ? {} : record(choice.settings))) {
        if (
          !keyPattern.test(key) ||
          managedSettings.test(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          throw new Error(`cmake.unsupportedVariants: setting ${key}`);
        if (
          typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          (typeof value !== 'number' || !Number.isFinite(value))
        )
          throw new Error('cmake.invalidVariants: settings must be scalar');
        if (typeof value === 'string' && (value.length > 8192 || value.includes('\0') || /[\r\n]/.test(value)))
          throw new Error('cmake.invalidVariants: invalid setting');
        settings[key] = value;
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(choice.env === undefined ? {} : record(choice.env))) {
        if (
          !keyPattern.test(key) ||
          isPrivateEnvironment(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          throw new Error(`cmake.invalidVariants: environment ${key}`);
        env[key] = text(value, true);
      }
      return {
        id,
        label: choice.short === undefined ? id : text(choice.short),
        description: choice.long === undefined ? undefined : text(choice.long),
        buildType: choice.buildType === undefined ? undefined : text(choice.buildType),
        settings,
        env,
      };
    });
    const defaultChoice = dimension.default === undefined ? choices[0].id : text(dimension.default);
    if (!choices.some((choice) => choice.id === defaultChoice))
      throw new Error('cmake.invalidVariants: default choice missing');
    return { name, label: dimension.short === undefined ? name : text(dimension.short), defaultChoice, choices };
  });
}

/** Resolve every dimension; misspelled selections and conflicting values fail explicitly. */
export function resolveVariants(dimensions: CmakeDimension[], requested: Record<string, string>): ResolvedVariants {
  for (const key of Object.keys(requested))
    if (!dimensions.some((dimension) => dimension.name === key))
      throw new Error(`cmake.selection: unknown dimension ${key}`);
  const result: ResolvedVariants = { selection: {}, settings: {}, env: {} };
  for (const dimension of dimensions) {
    const id = requested[dimension.name] ?? dimension.defaultChoice;
    const choice = dimension.choices.find((candidate) => candidate.id === id);
    if (!choice) throw new Error(`cmake.selection: unknown choice ${dimension.name}=${id}`);
    result.selection[dimension.name] = id;
    for (const [key, value] of Object.entries(choice.settings)) {
      if (Object.hasOwn(result.settings, key) && result.settings[key] !== value)
        throw new Error(`cmake.variantConflict: setting conflict ${key}`);
      result.settings[key] = value;
    }
    for (const [key, value] of Object.entries(choice.env)) {
      if (Object.hasOwn(result.env, key) && result.env[key] !== value)
        throw new Error(`cmake.variantConflict: environment conflict ${key}`);
      result.env[key] = value;
    }
    if (choice.buildType) {
      if (result.buildType && result.buildType !== choice.buildType)
        throw new Error('cmake.variantConflict: buildType conflict');
      result.buildType = choice.buildType;
    }
  }
  if (
    result.buildType &&
    result.settings.CMAKE_BUILD_TYPE !== undefined &&
    result.settings.CMAKE_BUILD_TYPE !== result.buildType
  )
    throw new Error('cmake.variantConflict: CMAKE_BUILD_TYPE conflict');
  return result;
}
