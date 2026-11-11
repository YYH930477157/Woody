/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IProvider,
  ModelImageInputCapability,
  ModelOpenAiApiMode,
  ModelReasoningEffort,
  ModelReasoningCapability,
  ModelSettings,
  ModelType,
} from '@/common/config/storage';

/**
 * Capability matching regex patterns
 */
export const CAPABILITY_PATTERNS: Record<ModelType, RegExp> = {
  text: /gpt|claude|gemini|qwen|llama|mistral|deepseek/i,
  vision: /4o|claude-3|gemini-.*-pro|gemini-.*-flash|gemini-2\.0|qwen-vl|llava|vision/i,
  function_calling: /gpt-4|claude-3|gemini|qwen|deepseek/i,
  image_generation: /flux|diffusion|stabilityai|sd-|dall|cogview|janus|midjourney|mj-|imagen/i,
  web_search: /search|perplexity/i,
  reasoning: /o1-|reasoning|think/i,
  embedding: /(?:^text-|embed|bge-|e5-|LLM2Vec|retrieval|uae-|gte-|jina-clip|jina-embeddings|voyage-)/i,
  rerank: /(?:rerank|re-rank|re-ranker|re-ranking|retrieval|retriever)/i,
  excludeFromPrimary: /dall-e|flux|stable-diffusion|midjourney|flash-image|image|embed|rerank/i,
};

/**
 * Explicit exclusion lists (blacklist) for capabilities
 */
export const CAPABILITY_EXCLUSIONS: Record<ModelType, RegExp[]> = {
  text: [],
  vision: [/embed|rerank|dall-e|flux|stable-diffusion/i],
  function_calling: [
    /aqa(?:-[\w-]+)?/i,
    /imagen(?:-[\w-]+)?/i,
    /o1-mini/i,
    /o1-preview/i,
    /gemini-1(?:\\.[\w-]+)?/i,
    /dall-e/i,
    /embed/i,
    /rerank/i,
  ],
  image_generation: [],
  web_search: [],
  reasoning: [],
  embedding: [],
  rerank: [],
  excludeFromPrimary: [],
};

/**
 * Get the lowercase, normalized base model name for matching.
 */
export const getBaseModelName = (modelName: string): string => {
  return modelName
    .toLowerCase()
    .replace(/[^a-z0-9./-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

export type ModelOpenAiApiModeChoice = ModelOpenAiApiMode | 'auto';
export type ModelImageInputChoice = ModelImageInputCapability | 'auto';
export type ModelReasoningEffortChoice = ModelReasoningEffort | 'auto';
export const MODEL_REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

/** Provider lists are wire values; keep literal none separate from omission. */
export const modelReasoningChoices = (capability?: ModelReasoningCapability): ModelReasoningEffort[] => {
  if (capability?.supported === false) return ['none'];
  if (!capability?.efforts) return [...MODEL_REASONING_EFFORTS];
  return [
    'none',
    ...capability.efforts.flatMap((value): ModelReasoningEffort[] => {
      if (value === 'none') return ['provider_none'];
      return MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort) ? [value as ModelReasoningEffort] : [];
    }),
  ];
};

export const reasoningEffortLabelKey = (value: string) => {
  if (value === 'none') return 'agent.thoughtLevel.omit' as const;
  if (value === 'provider_none') return 'agent.thoughtLevel.providerNone' as const;
  return undefined;
};

/** Refresh discovery only for returned models, preserving user settings and offline caches. */
export const mergeReportedReasoningCapabilities = (
  current: Record<string, ModelSettings> | undefined,
  modelIds: string[],
  reported?: Record<string, ModelReasoningCapability>
): Record<string, ModelSettings> => {
  const next = { ...current };
  if (reported === undefined) return next;
  for (const id of modelIds) {
    const settings = { ...next[id] };
    delete settings.reasoning_capability;
    if (reported[id]) settings.reasoning_capability = reported[id];
    if (Object.keys(settings).length) next[id] = settings;
    else delete next[id];
  }
  return next;
};

/** Mirrors the aionrs factory's provider mapping and OpenAI effort defaults. */
export const supportsModelReasoningEffort = (platform: string, modelProtocol = 'openai'): boolean => {
  if (['anthropic', 'bedrock', 'gemini-vertex-ai'].includes(platform)) return false;
  if (['openai', 'gemini'].includes(platform)) return true;
  return modelProtocol === 'openai' || modelProtocol === 'gemini';
};

/** Whether a provider/model protocol can select an OpenAI wire API. */
export const supportsOpenAiApiMode = (platform: string, modelProtocol = 'openai'): boolean => {
  if (platform === 'new-api') return modelProtocol === 'openai';
  return !['anthropic', 'bedrock', 'gemini', 'gemini-vertex-ai'].includes(platform);
};

/** Smallest context window a model setting accepts, matching the backend's gateway filter. */
export const MIN_MODEL_CONTEXT_LIMIT = 1024;
/** Largest context window a model setting accepts. */
export const MAX_MODEL_CONTEXT_LIMIT = 100_000_000;

/**
 * Context window per model: the typed value applies to every model, otherwise
 * each model keeps the window its gateway reported, if any.
 */
export const pickContextLimits = (
  modelIds: string[],
  typed: number | undefined,
  reported: Record<string, number> | undefined
): Record<string, number> => {
  const limits: Record<string, number> = {};
  for (const modelId of modelIds) {
    const limit = typed ?? reported?.[modelId];
    if (limit !== undefined) limits[modelId] = limit;
  }
  return limits;
};

/** Apply explicit settings to models while keeping automatic values absent on the wire. */
export const updateModelSettings = (
  current: Record<string, ModelSettings> | undefined,
  modelIds: string[],
  imageInput: ModelImageInputChoice,
  openAiApiMode: ModelOpenAiApiModeChoice,
  contextLimits: Record<string, number> = {},
  reasoningEffort?: ModelReasoningEffortChoice,
  reportedCapabilities?: Record<string, ModelReasoningCapability>
): Record<string, ModelSettings> => {
  const next = { ...current };

  for (const modelId of modelIds) {
    const contextLimit = contextLimits[modelId];
    const modelEffort = reasoningEffort ?? current?.[modelId]?.reasoning_effort;
    const capability =
      reportedCapabilities === undefined ? current?.[modelId]?.reasoning_capability : reportedCapabilities[modelId];
    if (
      imageInput === 'auto' &&
      openAiApiMode === 'auto' &&
      contextLimit === undefined &&
      (!modelEffort || modelEffort === 'auto') &&
      !capability
    ) {
      delete next[modelId];
      continue;
    }

    const settings: ModelSettings = {};
    if (imageInput !== 'auto') settings.image_input = imageInput;
    if (openAiApiMode !== 'auto') settings.openai_api_mode = openAiApiMode;
    if (contextLimit !== undefined) settings.context_limit = contextLimit;
    if (modelEffort && modelEffort !== 'auto') settings.reasoning_effort = modelEffort;
    if (capability) settings.reasoning_capability = capability;
    next[modelId] = settings;
  }

  return next;
};

/**
 * Check whether a specific model within a provider has a given capability.
 * Returns true (supported), false (excluded), or undefined (unknown).
 */
export const hasSpecificModelCapability = (
  _platformModel: IProvider,
  modelName: string,
  type: ModelType
): boolean | undefined => {
  const baseModelName = getBaseModelName(modelName);
  const exclusions = CAPABILITY_EXCLUSIONS[type];
  const pattern = CAPABILITY_PATTERNS[type];

  const isExcluded = exclusions.some((excludePattern) => excludePattern.test(baseModelName));
  if (isExcluded) return false;

  return pattern.test(baseModelName) ? true : undefined;
};
